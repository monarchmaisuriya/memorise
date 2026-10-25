import { createHash, randomBytes } from "node:crypto";
import { mkdir, readdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import { type FactListItem, type Proposal, proposalSchema, repoKeySchema } from "../shared/memory";
import { assertNoSecret } from "./secrets";
import { MemoryStore, newFactId } from "./store";

export type NewProposal = Omit<Proposal, "id" | "created" | "hash">;

// Same subject and text (ignoring case and spacing) and same targets: the same proposal.
export function proposalHash(proposal: Pick<Proposal, "kind" | "targets" | "subject" | "body">): string {
  const normal = (text: string) => text.toLowerCase().replace(/\s+/g, " ").trim();
  return createHash("sha256").update([proposal.kind, [...proposal.targets].sort().join(","), normal(proposal.subject), normal(proposal.body)].join("\n")).digest("hex");
}

const rejectedSchema = z.array(z.string().regex(/^[0-9a-f]{64}$/));

// Proposals live apart from facts (proposals/<repoKey>/<id>.json) and are never shown to agents.
export class ProposalStore {
  private queue: Promise<unknown> = Promise.resolve();
  private readonly dir: string;

  constructor(root: string) {
    this.dir = join(root, "proposals");
  }

  private serialize<T>(operation: () => Promise<T>): Promise<T> {
    const next = this.queue.then(operation, operation);
    this.queue = next.catch(() => undefined);
    return next;
  }

  private repoDir(repoKey: string): string {
    return join(this.dir, ...repoKeySchema.parse(repoKey).split("/"));
  }

  private async rejected(): Promise<Set<string>> {
    const text = await readFile(join(this.dir, "rejected.json"), "utf8").catch((error: unknown) => {
      if (Reflect.get(Object(error), "code") === "ENOENT") return "[]";
      throw error;
    });
    return new Set(rejectedSchema.parse(JSON.parse(text)));
  }

  async list(repoKey: string): Promise<Proposal[]> {
    const dir = this.repoDir(repoKey);
    const names = await readdir(dir).catch((error: unknown) => {
      if (Reflect.get(Object(error), "code") === "ENOENT") return [];
      throw error;
    });
    const proposals: Proposal[] = [];
    for (const name of names.filter((entry) => entry.endsWith(".json"))) {
      try {
        proposals.push(proposalSchema.parse(JSON.parse(await readFile(join(dir, name), "utf8"))));
      } catch (error) {
        console.error(`[memorise] skipped unreadable proposal ${join(dir, name)}: ${String(error)}`);
      }
    }
    return proposals.sort((a, b) => a.created.localeCompare(b.created));
  }

  // Repos with proposals waiting and how many, in repo key order. Counted with list, so a file that
  // cannot be read is not counted here either.
  async summary(): Promise<{ repoKey: string; pending: number }[]> {
    const repos: { repoKey: string; pending: number }[] = [];
    const walk = async (dir: string, segments: string[]): Promise<void> => {
      const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
      const repoKey = segments.join("/");
      if (entries.some((entry) => entry.isFile() && entry.name.endsWith(".json")) && repoKeySchema.safeParse(repoKey).success) {
        const pending = (await this.list(repoKey)).length;
        if (pending > 0) repos.push({ repoKey, pending });
      }
      for (const entry of entries) if (entry.isDirectory()) await walk(join(dir, entry.name), [...segments, entry.name]);
    };
    await walk(this.dir, []);
    return repos.sort((a, b) => a.repoKey.localeCompare(b.repoKey));
  }

  // Adds the proposals that are new: not pending already, not rejected before, and not the same as
  // a current fact. Returns the ones added. Every proposal passes the same checks as a saved fact.
  add(candidates: readonly NewProposal[], currentFacts: readonly FactListItem[]): Promise<Proposal[]> {
    return this.serialize(async () => {
      const added: Proposal[] = [];
      const skip = await this.rejected();
      for (const pending of await this.list(candidates[0]?.repoKey ?? "local/none")) skip.add(pending.hash);
      for (const fact of currentFacts) if (!fact.superseded && fact.status === "active") skip.add(proposalHash({ kind: "new", targets: [], subject: fact.subject, body: fact.body }));
      for (const candidate of candidates) {
        const hash = proposalHash(candidate);
        if (skip.has(hash)) continue;
        try {
          assertNoSecret(candidate.subject, candidate.body);
          const proposal = proposalSchema.parse({ ...candidate, id: newFactId(), created: new Date().toISOString(), hash });
          const dir = this.repoDir(proposal.repoKey);
          await mkdir(dir, { recursive: true, mode: 0o700 });
          const path = join(dir, `${proposal.id}.json`);
          const temp = `${path}.${randomBytes(4).toString("hex")}.tmp`;
          await writeFile(temp, JSON.stringify(proposal, null, 2), { mode: 0o600 });
          await rename(temp, path);
          skip.add(hash);
          added.push(proposal);
        } catch (error) {
          console.error(`[memorise] dropped an invalid proposal "${candidate.subject.slice(0, 60)}": ${error instanceof Error ? error.message : String(error)}`);
        }
      }
      return added;
    });
  }

  // The rejection is recorded (atomically) before the proposal is removed, so a crash in between
  // leaves it pending rather than forgotten.
  reject(id: string, repoKey: string): Promise<void> {
    return this.serialize(async () => {
      const proposal = (await this.list(repoKey)).find((candidate) => candidate.id === id);
      if (!proposal) throw new Error(`No suggestion with id ${id} in this project`);
      const rejected = await this.rejected();
      rejected.add(proposal.hash);
      await mkdir(this.dir, { recursive: true, mode: 0o700 });
      const path = join(this.dir, "rejected.json");
      const temp = `${path}.${randomBytes(4).toString("hex")}.tmp`;
      await writeFile(temp, JSON.stringify([...rejected]), { mode: 0o600 });
      await rename(temp, path);
      await rm(join(this.repoDir(repoKey), `${id}.json`));
    });
  }

  // Applies an approved proposal to the store. The proposal is removed only after the store change
  // succeeded, so a failure leaves it pending to try again.
  // by "auto": approved without review because the repo has auto-approve on.
  approve(id: string, repoKey: string, store: MemoryStore, edits: { subject?: string; body?: string; paths?: string[] }, by: "captured" | "auto" = "captured"): Promise<void> {
    return this.serialize(async () => {
      const proposal = (await this.list(repoKey)).find((candidate) => candidate.id === id);
      if (!proposal) throw new Error(`No suggestion with id ${id} in this project`);
      const subject = edits.subject ?? proposal.subject;
      const body = edits.body ?? proposal.body;
      const paths = edits.paths ?? proposal.paths;
      assertNoSecret(subject, body);
      const source = { by, provider: proposal.source.provider, branch: null, commit: null };
      switch (proposal.kind) {
        case "new":
          await store.create({ scope: "repo", repoKey, type: proposal.type, subject, body, paths, supersedes: null, source, citations: [] });
          break;
        case "replace":
          await store.supersede(proposal.targets[0], repoKey, { subject, body, paths, source });
          break;
        case "merge": {
          // The first fact carries the merged wording forward; the others are retired.
          const [keep, ...rest] = proposal.targets;
          await store.supersede(keep, repoKey, { subject, body, paths, source });
          for (const other of rest) await store.retire(other, repoKey);
          break;
        }
        case "retire":
          await store.retire(proposal.targets[0], repoKey);
          break;
      }
      await rm(join(this.repoDir(repoKey), `${id}.json`));
    });
  }
}
