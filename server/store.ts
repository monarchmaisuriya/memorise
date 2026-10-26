import { randomBytes } from "node:crypto";
import { mkdir, readdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { parse, stringify } from "yaml";
import { bodyLengthProblem, DEFAULT_BODY_CHARS, type Fact, type FactListItem, factIdSchema, factSchema, repoKeySchema, type Scope } from "../shared/memory";

const CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

export function newFactId(now = Date.now()): string {
  let time = "";
  for (let value = now, i = 0; i < 10; i += 1, value = Math.floor(value / 32)) time = CROCKFORD[value % 32] + time;
  const random = Array.from(randomBytes(16), (byte) => CROCKFORD[byte % 32]).join("");
  return time + random;
}

type Control = "pinned" | "activation" | "enabled" | "until";
export type Controls = Partial<Pick<Fact, Control>>;
export type NewFact = Omit<Fact, "id" | "status" | "created" | "modified" | "lastUsed" | "paths" | Control> & Partial<Pick<Fact, "paths" | Control>>;

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

  // The user's limit on a memory's text, read at each save so a settings change applies at once.
  constructor(
    readonly root: string,
    private readonly maxBodyChars: () => number | Promise<number> = () => DEFAULT_BODY_CHARS,
  ) {}

  private async checkBody(body: string): Promise<void> {
    const problem = bodyLengthProblem(body, await this.maxBodyChars());
    if (problem) throw new Error(problem);
  }

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
        console.error(`[memorise] skipped unreadable memory file ${path}: ${String(error)}`);
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

  private pathFor(fact: Fact): string {
    return join(this.dirFor(fact.scope, fact.repoKey), `${fact.id}.md`);
  }

  private async save(fact: Fact): Promise<Fact> {
    // Every write passes here, so a fact can never be left listed for files without any paths.
    if (fact.activation === "files" && fact.paths.length === 0) throw new Error(`Memory "${fact.subject}" is set to show only when matching files change, but it is about no files; add a file pattern or choose another option`);
    await mkdir(this.dirFor(fact.scope, fact.repoKey), { recursive: true });
    const path = this.pathFor(fact);
    const temp = `${path}.${randomBytes(4).toString("hex")}.tmp`;
    await writeFile(temp, serializeFact(fact), { encoding: "utf8", mode: 0o600 });
    await rename(temp, path);
    return fact;
  }

  create(input: NewFact): Promise<Fact> {
    return this.serialize(async () => {
      await this.checkBody(input.body);
      const now = new Date().toISOString();
      return this.save(factSchema.parse({ ...input, id: newFactId(), status: "active", created: now, modified: now, lastUsed: now }));
    });
  }

  // An update is one new file naming the old one, so a crash cannot leave two current versions.
  supersede(id: string, repoKey: string | null, change: Partial<Pick<Fact, "subject" | "body" | "type" | "citations" | "paths" | "source" | Control>>): Promise<Fact> {
    return this.serialize(async () => {
      const old = await this.get(id, repoKey);
      if (old.superseded) throw new Error(`Memory ${id} was already replaced by a newer version; update that one instead`);
      if (old.status === "retired") throw new Error(`Memory ${id} is retired`);
      // Only new text is checked, so an older memory longer than a lowered limit can still be edited otherwise.
      if (change.body !== undefined && change.body.trim() !== old.body) await this.checkBody(change.body);
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

  // The version chain a fact belongs to, newest first; any version's id finds the whole chain.
  async history(id: string, repoKey: string | null): Promise<FactListItem[]> {
    const facts = await this.list(repoKey);
    const byId = new Map(facts.map((fact) => [fact.id, fact]));
    const newer = new Map(facts.flatMap((fact) => (fact.supersedes ? [[fact.supersedes, fact] as const] : [])));
    let head = byId.get(factIdSchema.parse(id));
    if (!head) throw new FactNotFoundError(id);
    // A hand-edited file could link versions in a loop; each id is visited once.
    const seen = new Set<string>();
    while (newer.has(head.id) && !seen.has(head.id)) {
      seen.add(head.id);
      head = newer.get(head.id) as FactListItem;
    }
    const chain: FactListItem[] = [];
    for (let fact: FactListItem | undefined = head; fact && !chain.includes(fact); fact = fact.supersedes ? byId.get(fact.supersedes) : undefined) chain.push(fact);
    return chain;
  }

  // A new version whose content copies an older one; nothing is overwritten.
  async revert(id: string, versionId: string, repoKey: string | null, source: Fact["source"]): Promise<Fact> {
    const chain = await this.history(id, repoKey);
    if (chain[0].id !== id) throw new Error(`Memory ${id} was already replaced by a newer version; revert from that one instead`);
    const version = chain.find((fact) => fact.id === versionId);
    if (!version) throw new Error(`Version ${versionId} is not in the history of memory ${id}`);
    if (version.id === id) throw new Error(`Version ${versionId} is already the current one`);
    const { subject, body, type, paths, citations } = version;
    return this.supersede(id, repoKey, { subject, body, type, paths, citations, source });
  }

  // Moves a fact between a repo and global. A global fact is listed in every repo, so the moved fact
  // is a new fact rather than a new version: a version link would hide the original only in this
  // repo. The original is retired; if that fails, the copy is removed so only one stays current.
  // Citations point at one repo's files, so a fact made global drops them.
  move(id: string, repoKey: string | null, to: Scope): Promise<Fact> {
    return this.serialize(async () => {
      const { superseded, ...fact } = await this.get(id, repoKey);
      if (superseded) throw new Error(`Memory ${id} was already replaced by a newer version; move that one instead`);
      if (fact.status === "retired") throw new Error(`Memory ${id} is retired`);
      if (fact.scope === to) throw new Error(`Memory ${id} is already ${to === "global" ? "global" : "a project memory"}`);
      if (to === "repo" && !repoKey) throw new Error("Choose a project to move this memory into");
      const now = new Date().toISOString();
      const copy = await this.save(
        factSchema.parse({ ...fact, id: newFactId(), scope: to, repoKey: to === "repo" ? repoKey : null, citations: to === "global" ? [] : fact.citations, supersedes: null, created: now, modified: now, lastUsed: now }),
      );
      try {
        await this.save({ ...fact, status: "retired", modified: now });
      } catch (error) {
        await rm(this.pathFor(copy), { force: true });
        throw error;
      }
      return copy;
    });
  }

  // Current facts (not replaced) for global and each repo, by status, for the manager's repo list.
  async summaries(): Promise<{ repoKey: string | null; active: number; retired: number; lastModified: string | null }[]> {
    const summarize = (repoKey: string | null, facts: Fact[]) => {
      const replaced = new Set(facts.map((fact) => fact.supersedes));
      const current = facts.filter((fact) => !replaced.has(fact.id));
      const lastModified = current.map((fact) => fact.modified).sort().at(-1) ?? null;
      return { repoKey, active: current.filter((fact) => fact.status === "active").length, retired: current.filter((fact) => fact.status === "retired").length, lastModified };
    };
    const repos = await this.repoKeys();
    return [summarize(null, await this.readDir(this.dirFor("global", null))), ...(await Promise.all(repos.map(async (key) => summarize(key, await this.readDir(this.dirFor("repo", key))))))];
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

  // Controls change the fact in place, without a new version. Only the user sets them, from the
  // app; no agent tool reaches this.
  setControls(id: string, repoKey: string | null, controls: Controls): Promise<Fact> {
    return this.serialize(async () => {
      const { superseded: _superseded, ...fact } = await this.get(id, repoKey);
      return this.save(factSchema.parse({ ...fact, ...controls, modified: new Date().toISOString() }));
    });
  }

  setPinned(id: string, repoKey: string | null, pinned: boolean): Promise<Fact> {
    return this.setControls(id, repoKey, { pinned });
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
