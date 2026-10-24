import { mkdir, readFile, realpath, rename, stat, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { z } from "zod";
import { repoKeySchema } from "../shared/memory";
import { folderKey, readGitRepo } from "./repo-key";

// A folder's identity on its disk: device, inode, and creation time (0 where the system has none).
// It survives a rename or a move on the same disk, unlike the path.
const identitySchema = z.object({ dev: z.string(), ino: z.string(), born: z.string() });
type Identity = z.infer<typeof identitySchema>;

const entrySchema = identitySchema.extend({
  key: repoKeySchema,
  // The folder's real path when it was last seen.
  path: z.string(),
  // A Paseo project root: agents in folders below it share its key.
  root: z.boolean(),
});
type Entry = z.infer<typeof entrySchema>;
const registrySchema = z.object({ version: z.literal(1), folders: z.array(entrySchema) });

export interface Project {
  key: string;
  // The folder paths are relative to: a repo's top level, or the folder project's own folder.
  root: string;
}

async function identityOf(path: string): Promise<Identity | null> {
  const info = await stat(path, { bigint: true }).catch(() => null);
  return info ? { dev: String(info.dev), ino: String(info.ino), born: String(info.birthtimeNs) } : null;
}

function sameFolder(a: Identity, b: Identity): boolean {
  return a.dev === b.dev && a.ino === b.ino && a.born === b.born;
}

// Decides which project a folder belongs to. A repo is found by git as before. A folder outside git
// keeps the key it got when first seen, recorded in folders.json in the plugin data: found again by
// its path; after a rename or a move on the same disk by its identity (only where the creation time is
// known, so a reused inode is not mistaken for it); and from a subfolder through the nearest Paseo
// project root above it. Folders where an agent merely ran claim nothing below them.
export class ProjectKeys {
  private readonly file: string;
  private entries: Entry[] | null = null;
  private queue: Promise<unknown> = Promise.resolve();

  constructor(dataRoot: string) {
    this.file = join(dataRoot, "folders.json");
  }

  async resolve(cwd: string): Promise<Project> {
    const repo = await readGitRepo(cwd);
    if (repo) return { key: repo.key, root: repo.top };
    const real = await realpath(cwd);
    return this.serialize(() => this.resolveFolder(real, false));
  }

  async keyOf(cwd: string): Promise<string> {
    return (await this.resolve(cwd)).key;
  }

  // Records a folder outside git as a project root (a Paseo project's folder). A repo needs nothing.
  async markRoot(folder: string): Promise<void> {
    if (await readGitRepo(folder)) return;
    const real = await realpath(folder);
    await this.serialize(() => this.resolveFolder(real, true));
  }

  // A folder project's current name and path, for the manager.
  async label(key: string): Promise<{ name: string; path: string } | null> {
    const entry = (await this.load()).find((candidate) => candidate.key === key);
    return entry ? { name: basename(entry.path) || entry.path, path: entry.path } : null;
  }

  private async resolveFolder(real: string, asRoot: boolean): Promise<Project> {
    const entries = await this.load();
    const identity = await identityOf(real);
    if (!identity) throw new Error(`${real} cannot be read, so its project is unknown`);
    const known = (entry: Entry) => (asRoot && !entry.root ? this.save({ ...entry, root: true }) : Promise.resolve(entry));

    const atPath = entries.find((entry) => entry.path === real);
    if (atPath) {
      // A folder made again at the same path is the same project.
      const entry = await known(sameFolder(atPath, identity) ? atPath : await this.save({ ...atPath, ...identity }));
      return { key: entry.key, root: real };
    }
    const moved = await this.movedEntry(entries, identity, () => true);
    if (moved) return { key: (await known(await this.save({ ...moved, path: real }))).key, root: real };

    if (!asRoot) {
      // Each folder above, nearest first, up to the filesystem root.
      for (let dir = real; dir !== dirname(dir); ) {
        dir = dirname(dir);
        const root = entries.find((entry) => entry.root && entry.path === dir);
        if (root) return { key: root.key, root: dir };
        const dirIdentity = await identityOf(dir);
        const movedRoot = dirIdentity ? await this.movedEntry(entries, dirIdentity, (entry) => entry.root) : null;
        if (movedRoot) return { key: (await this.save({ ...movedRoot, path: dir })).key, root: dir };
      }
    }

    // A folder now at a path an older entry was first seen at gets a key of its own.
    const base = folderKey(real);
    let key = base;
    for (let n = 2; entries.some((entry) => entry.key === key); n += 1) key = `${base}-${n}`;
    await this.save({ key, path: real, root: asRoot, ...identity });
    return { key, root: real };
  }

  // An entry for this same folder seen at another path that no longer holds it: the folder moved.
  private async movedEntry(entries: Entry[], identity: Identity, eligible: (entry: Entry) => boolean): Promise<Entry | null> {
    if (identity.born === "0") return null;
    for (const entry of entries) {
      if (!eligible(entry) || !sameFolder(entry, identity)) continue;
      const there = await identityOf(entry.path);
      if (!there || !sameFolder(there, entry)) return entry;
    }
    return null;
  }

  private async load(): Promise<Entry[]> {
    if (this.entries) return this.entries;
    const text = await readFile(this.file, "utf8").catch((error: unknown) => {
      if (Reflect.get(Object(error), "code") === "ENOENT") return null;
      throw error;
    });
    this.entries = text === null ? [] : registrySchema.parse(JSON.parse(text)).folders;
    return this.entries;
  }

  // Replaces the entry with the same key, or adds it, and writes the file (a temporary file renamed
  // over it, so a crash never leaves half a file).
  private async save(entry: Entry): Promise<Entry> {
    const entries = await this.load();
    const index = entries.findIndex((candidate) => candidate.key === entry.key);
    if (index === -1) entries.push(entry);
    else entries[index] = entry;
    await mkdir(dirname(this.file), { recursive: true });
    const temporary = `${this.file}.${process.pid}.tmp`;
    await writeFile(temporary, `${JSON.stringify({ version: 1, folders: entries }, null, 2)}\n`, { mode: 0o600 });
    await rename(temporary, this.file);
    return entry;
  }

  private serialize<T>(work: () => Promise<T>): Promise<T> {
    const next = this.queue.then(work);
    this.queue = next.catch(() => undefined);
    return next;
  }
}
