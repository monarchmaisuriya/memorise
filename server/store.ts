import { randomBytes } from "node:crypto";
import { mkdir, readdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { parse, stringify } from "yaml";
import { type Fact, type FactListItem, factIdSchema, factSchema, repoKeySchema, type Scope } from "../shared/memory";

const CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

export function newFactId(now = Date.now()): string {
  let time = "";
  for (let value = now, i = 0; i < 10; i += 1, value = Math.floor(value / 32)) time = CROCKFORD[value % 32] + time;
  const random = Array.from(randomBytes(16), (byte) => CROCKFORD[byte % 32]).join("");
  return time + random;
}

export type NewFact = Omit<Fact, "id" | "status" | "created" | "modified" | "lastUsed" | "pinned" | "paths"> & Partial<Pick<Fact, "pinned" | "paths">>;

export class FactNotFoundError extends Error {
  constructor(id: string) {
    super(`No memory with id ${id} in this repo or in global memory`);
  }
}

// One fact per Markdown file: YAML frontmatter holds the metadata, the body is the fact itself.
export function serializeFact(fact: Fact): string {
  const { body, ...meta } = factSchema.parse(fact);
  return `---\n${stringify(meta)}---\n${body}\n`;
}

export function parseFact(text: string): Fact {
  const match = /^---\n([\s\S]*?)\n---\n([\s\S]*)$/.exec(text);
  if (!match) throw new Error("Expected YAML frontmatter between --- lines, followed by the fact text");
  return factSchema.parse({ ...Object(parse(match[1])), body: match[2].trim() });
}

// The daemon-side plugin process is the only writer, so serializing inside it is enough to keep
// read-modify-write operations (use, retire, supersede) from interleaving.
export class MemoryStore {
  private queue: Promise<unknown> = Promise.resolve();

  constructor(readonly root: string) {}

  private serialize<T>(operation: () => Promise<T>): Promise<T> {
    const next = this.queue.then(operation, operation);
    this.queue = next.catch(() => undefined);
    return next;
  }

  private dirFor(scope: Scope, repoKey: string | null): string {
    if (scope === "global") return join(this.root, "global");
    return join(this.root, "repos", ...repoKeySchema.parse(repoKey).split("/"));
  }

  private async readDir(dir: string): Promise<Fact[]> {
    const names = await readdir(dir).catch((error: unknown) => {
      if (Reflect.get(Object(error), "code") === "ENOENT") return [];
      throw error;
    });
    const facts: Fact[] = [];
    for (const name of names) {
      if (!name.endsWith(".md")) continue;
      const path = join(dir, name);
      try {
        facts.push(parseFact(await readFile(path, "utf8")));
      } catch (error) {
        // One hand-edited file with a mistake must not hide every other memory; it is reported instead.
        console.error(`[agent-memory] skipped unreadable memory file ${path}: ${String(error)}`);
      }
    }
    return facts;
  }

  // Global facts plus the repo's facts. A fact is superseded when another fact names it.
  async list(repoKey: string | null): Promise<FactListItem[]> {
    const facts = [...(await this.readDir(this.dirFor("global", null))), ...(repoKey ? await this.readDir(this.dirFor("repo", repoKey)) : [])];
    const replaced = new Set(facts.map((fact) => fact.supersedes).filter((id): id is string => id !== null));
    return facts.map((fact) => ({ ...fact, superseded: replaced.has(fact.id) }));
  }

  async get(id: string, repoKey: string | null): Promise<FactListItem> {
    factIdSchema.parse(id);
    const fact = (await this.list(repoKey)).find((candidate) => candidate.id === id);
    if (!fact) throw new FactNotFoundError(id);
    return fact;
  }

  private async save(fact: Fact): Promise<Fact> {
    const dir = this.dirFor(fact.scope, fact.repoKey);
    await mkdir(dir, { recursive: true });
    const path = join(dir, `${fact.id}.md`);
    const temp = `${path}.${randomBytes(4).toString("hex")}.tmp`;
    await writeFile(temp, serializeFact(fact), { encoding: "utf8", mode: 0o600 });
    await rename(temp, path);
    return fact;
  }

  create(input: NewFact): Promise<Fact> {
    return this.serialize(() => {
      const now = new Date().toISOString();
      return this.save(factSchema.parse({ ...input, id: newFactId(), status: "active", created: now, modified: now, lastUsed: now }));
    });
  }

  // An update is one new file naming the old one, so a crash cannot leave two current versions.
  supersede(id: string, repoKey: string | null, change: Partial<Pick<Fact, "subject" | "body" | "citations" | "paths" | "source">>): Promise<Fact> {
    return this.serialize(async () => {
      const old = await this.get(id, repoKey);
      if (old.superseded) throw new Error(`Memory ${id} was already replaced by a newer version; update that one instead`);
      if (old.status === "retired") throw new Error(`Memory ${id} is retired`);
      const now = new Date().toISOString();
      const { superseded: _superseded, ...base } = old;
      return this.save(factSchema.parse({ ...base, ...change, id: newFactId(), supersedes: old.id, status: "active", created: now, modified: now, lastUsed: now }));
    });
  }

  retire(id: string, repoKey: string | null): Promise<Fact> {
    return this.serialize(async () => {
      const { superseded: _superseded, ...fact } = await this.get(id, repoKey);
      return this.save({ ...fact, status: "retired", modified: new Date().toISOString() });
    });
  }

  // Undoes a retire, from the Memory panel.
  restore(id: string, repoKey: string | null): Promise<Fact> {
    return this.serialize(async () => {
      const { superseded: _superseded, ...fact } = await this.get(id, repoKey);
      const now = new Date().toISOString();
      return this.save({ ...fact, status: "active", modified: now, lastUsed: now });
    });
  }

  // Every repo key that has at least one fact file.
  async repoKeys(): Promise<string[]> {
    const keys: string[] = [];
    const walk = async (dir: string, segments: string[]): Promise<void> => {
      const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
      if (entries.some((entry) => entry.isFile() && entry.name.endsWith(".md")) && repoKeySchema.safeParse(segments.join("/")).success) keys.push(segments.join("/"));
      for (const entry of entries) if (entry.isDirectory()) await walk(join(dir, entry.name), [...segments, entry.name]);
    };
    await walk(join(this.root, "repos"), []);
    return keys;
  }

  // Only the user pins, from the Memory panel; no agent tool reaches this.
  setPinned(id: string, repoKey: string | null, pinned: boolean): Promise<Fact> {
    return this.serialize(async () => {
      const { superseded: _superseded, ...fact } = await this.get(id, repoKey);
      return this.save({ ...fact, pinned, modified: new Date().toISOString() });
    });
  }

  markUsed(id: string, repoKey: string | null): Promise<Fact> {
    return this.serialize(async () => {
      const { superseded: _superseded, ...fact } = await this.get(id, repoKey);
      return this.save({ ...fact, lastUsed: new Date().toISOString() });
    });
  }

  // Only the user deletes, from the Memory panel. Agents can retire but never delete. Deleting a fact
  // also deletes the older versions it replaced; otherwise the previous version would become current.
  // Oldest first: if a removal fails partway, the newest version still exists and still hides the
  // older ones, so no replaced version can come back.
  delete(id: string, repoKey: string | null): Promise<void> {
    return this.serialize(async () => {
      const byId = new Map((await this.list(repoKey)).map((fact) => [fact.id, fact]));
      const chain: FactListItem[] = [];
      for (let fact = byId.get(factIdSchema.parse(id)); fact; fact = fact.supersedes ? byId.get(fact.supersedes) : undefined) chain.push(fact);
      if (chain.length === 0) throw new FactNotFoundError(id);
      for (const fact of chain.reverse()) await rm(join(this.dirFor(fact.scope, fact.repoKey), `${fact.id}.md`));
    });
  }
}
