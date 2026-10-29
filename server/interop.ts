import { createHash, randomBytes } from "node:crypto";
import { mkdir, readdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { z } from "zod";
import { bodySchema, factIdSchema, repoKeySchema, subjectSchema } from "../shared/memory";
import type { ProposalStore } from "./proposals";
import { findSecret } from "./secrets";
import type { MemoryStore } from "./store";

// The files other Paseo plugins may use, documented in INTEROP.md. Paseo has no plugin-to-plugin
// calls, so Memorise publishes a heartbeat and each project's memory metadata, and reads suggestions
// from an inbox. Everything here is versioned: a breaking change gets a new folder, never an edit.
export const INTEROP_VERSION = 1;
export const HEARTBEAT_MS = 2 * 60_000;
export const INBOX_DAILY_LIMIT = 20;
const INBOX_MAX_BYTES = 16 * 1024;

const pluginIdSchema = z.string().regex(/^[a-z0-9][a-z0-9-]{0,63}$/, "Expected a plugin id such as contextualise");

// Other plugins may only suggest replacing or archiving an existing memory. New memories come from
// the user, agents' own tools, and Memorise's capture, so no other plugin becomes a second source.
const suggestionSchema = z
  .object({
    version: z.literal(INTEROP_VERSION),
    from: pluginIdSchema,
    kind: z.enum(["replace", "retire"]),
    targets: z.array(factIdSchema).length(1),
    subject: subjectSchema.optional(),
    body: bodySchema.optional(),
    reason: z.string().trim().min(1).max(300),
  })
  .strict()
  .refine((suggestion) => suggestion.kind === "retire" || suggestion.subject !== undefined || suggestion.body !== undefined, "A replace suggestion needs a new subject or text");

interface InteropDeps {
  root: string;
  store: MemoryStore;
  proposals: ProposalStore;
  now?: () => Date;
}

async function writeAtomically(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temp = `${path}.${randomBytes(4).toString("hex")}.tmp`;
  await writeFile(temp, JSON.stringify(value, null, 2), { mode: 0o600 });
  await rename(temp, path);
}

export class Interop {
  private readonly dir: string;
  private readonly now: () => Date;
  private readonly exported = new Map<string, string>();
  private readonly acceptedToday = new Map<string, number>();
  private day = "";

  constructor(private readonly deps: InteropDeps) {
    this.dir = join(deps.root, "interop", `v${INTEROP_VERSION}`);
    this.now = deps.now ?? (() => new Date());
  }

  async writeStatus(): Promise<void> {
    await writeAtomically(join(this.dir, "status.json"), { version: INTEROP_VERSION, plugin: "memorise", writtenAt: this.now().toISOString() });
  }

  // One file per project, rewritten only when its memories changed. Bodies stay out: a reader that
  // needs one asks the agent to call memory_read, which keeps Memorise's own rules on reading.
  async exportAll(): Promise<void> {
    for (const repoKey of await this.deps.store.repoKeys()) {
      const memories = (await this.deps.store.list(repoKey))
        .filter((fact) => fact.scope === "repo" && !fact.superseded)
        .map(({ id, type, subject, status, enabled, paths, citations }) => ({ id, type, subject, status, enabled, paths, citations }));
      const signature = createHash("sha256").update(JSON.stringify(memories)).digest("hex");
      if (this.exported.get(repoKey) === signature) continue;
      await writeAtomically(join(this.dir, "export", `${repoKey}.json`), { version: INTEROP_VERSION, repoKey, writtenAt: this.now().toISOString(), memories });
      this.exported.set(repoKey, signature);
    }
  }

  private async inboxFiles(): Promise<{ repoKey: string; path: string }[]> {
    const found: { repoKey: string; path: string }[] = [];
    const walk = async (dir: string, segments: string[]): Promise<void> => {
      const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
      const repoKey = segments.join("/");
      for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
        if (entry.isDirectory()) await walk(join(dir, entry.name), [...segments, entry.name]);
        else if (entry.isFile() && entry.name.endsWith(".json") && repoKeySchema.safeParse(repoKey).success) found.push({ repoKey, path: join(dir, entry.name) });
      }
    };
    await walk(join(this.dir, "inbox"), []);
    return found;
  }

  private async reject(path: string, reason: string): Promise<void> {
    const target = join(this.dir, "inbox-rejected", `${this.now().toISOString().replace(/[:.]/g, "-")}-${randomBytes(3).toString("hex")}.json`);
    const original = await readFile(path, "utf8").catch(() => "");
    await writeAtomically(target, { reason, original });
    await rm(path, { force: true });
    console.error(`[memorise] rejected an interop suggestion (${path}): ${reason}`);
  }

  private async read(path: string, repoKey: string): Promise<{ suggestion: z.infer<typeof suggestionSchema>; fact: Awaited<ReturnType<MemoryStore["get"]>> }> {
    if ((await stat(path)).size > INBOX_MAX_BYTES) throw new Error(`File is larger than ${INBOX_MAX_BYTES} bytes`);
    let raw: unknown;
    try {
      raw = JSON.parse(await readFile(path, "utf8"));
    } catch (error) {
      throw new Error(`Expected a JSON object (${String(error)})`);
    }
    const parsed = suggestionSchema.safeParse(raw);
    if (!parsed.success) throw new Error(parsed.error.issues.map((issue) => `${issue.path.join(".") || "file"}: ${issue.message}`).join("; "));
    const suggestion = parsed.data;
    const fact = (await this.deps.store.list(repoKey)).find((candidate) => candidate.id === suggestion.targets[0]);
    if (!fact || fact.scope !== "repo" || fact.status !== "active" || fact.superseded) throw new Error(`There is no active memory ${suggestion.targets[0]} in ${repoKey}`);
    const secret = findSecret([suggestion.subject ?? "", suggestion.body ?? "", suggestion.reason].join("\n"));
    if (secret) throw new Error(`The suggestion looks like it contains a secret (${secret}); memory text reaches model providers`);
    return { suggestion, fact };
  }

  // Valid suggestions become ordinary Memorise suggestions that always wait for the user: this path
  // never approves, whatever the project's auto-approve setting says.
  async ingest(): Promise<{ accepted: number; rejected: number }> {
    const today = this.now().toISOString().slice(0, 10);
    if (today !== this.day) {
      this.day = today;
      this.acceptedToday.clear();
    }
    let accepted = 0;
    let rejected = 0;
    for (const { repoKey, path } of await this.inboxFiles()) {
      if ((this.acceptedToday.get(repoKey) ?? 0) >= INBOX_DAILY_LIMIT) continue;
      try {
        const { suggestion, fact } = await this.read(path, repoKey);
        const facts = await this.deps.store.list(repoKey);
        await this.deps.proposals.add(
          [
            {
              repoKey,
              kind: suggestion.kind,
              targets: suggestion.targets,
              type: fact.type,
              subject: suggestion.subject ?? fact.subject,
              body: suggestion.body ?? fact.body,
              paths: fact.paths,
              reason: suggestion.reason,
              source: { from: "plugin", plugin: suggestion.from, agentId: null, provider: suggestion.from, model: null },
            },
          ],
          facts,
        );
        await rm(path, { force: true });
        this.acceptedToday.set(repoKey, (this.acceptedToday.get(repoKey) ?? 0) + 1);
        accepted += 1;
      } catch (error) {
        await this.reject(path, error instanceof Error ? error.message : String(error));
        rejected += 1;
      }
    }
    return { accepted, rejected };
  }

  // Each step is logged on its own, so a failing export never stops the heartbeat or the inbox.
  start(): () => void {
    const tick = async () => {
      for (const [name, step] of [
        ["status", () => this.writeStatus()],
        ["export", () => this.exportAll()],
        ["inbox", () => this.ingest()],
      ] as const) {
        await step().catch((error: unknown) => console.error(`[memorise] interop ${name} failed: ${String(error)}`));
      }
    };
    void tick();
    const timer = setInterval(() => void tick(), HEARTBEAT_MS);
    timer.unref?.();
    return () => clearInterval(timer);
  }
}
