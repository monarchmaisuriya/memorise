import { randomBytes } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import { repoKeySchema, repoPrefsSchema, type RepoPrefsValue } from "../shared/memory";

const fileSchema = z.record(repoKeySchema, repoPrefsSchema);

// Per-repo preferences in repo-prefs.json. A missing file or repo means the defaults; a file that
// does not parse is an error, not a silent reset to defaults.
export class RepoPrefs {
  private queue: Promise<unknown> = Promise.resolve();
  private readonly path: string;

  constructor(private readonly root: string) {
    this.path = join(root, "repo-prefs.json");
  }

  private async readAll(): Promise<Record<string, RepoPrefsValue>> {
    const text = await readFile(this.path, "utf8").catch((error: unknown) => {
      if (Reflect.get(Object(error), "code") === "ENOENT") return "{}";
      throw error;
    });
    return fileSchema.parse(JSON.parse(text));
  }

  async get(repoKey: string): Promise<RepoPrefsValue> {
    return repoPrefsSchema.parse((await this.readAll())[repoKeySchema.parse(repoKey)] ?? {});
  }

  set(repoKey: string, prefs: RepoPrefsValue): Promise<RepoPrefsValue> {
    const next = this.queue.then(async () => {
      const all = await this.readAll();
      all[repoKeySchema.parse(repoKey)] = repoPrefsSchema.parse(prefs);
      await mkdir(this.root, { recursive: true, mode: 0o700 });
      const temp = `${this.path}.${randomBytes(4).toString("hex")}.tmp`;
      await writeFile(temp, JSON.stringify(all, null, 2), { mode: 0o600 });
      await rename(temp, this.path);
      return all[repoKey];
    });
    this.queue = next.catch(() => undefined);
    return next;
  }
}
