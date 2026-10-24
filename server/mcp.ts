import { appendFile } from "node:fs/promises";
import { createServer, type IncomingMessage, type Server } from "node:http";
import { join } from "node:path";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { z } from "zod";
import { bodySchema, type Citation, citationSchema, type Fact, type FactListItem, factIdSchema, MAX_CITATIONS, MAX_PATH_GLOBS, memoryTypeSchema, pathGlobSchema, subjectSchema } from "../shared/memory";
import { git } from "./git";
import type { AgentScope, TokenAuthority } from "./mcp-auth";
import { assertNoSecret } from "./secrets";
import type { SearchIndex } from "./search-index";
import { FactNotFoundError, type MemoryStore } from "./store";
import type { UsageLog } from "./usage";
import { isVisibleToAgents, orderForAgents } from "./visibility";
import { factMatchesFiles } from "./work-files";

// Distinctive names: read requests are approved by server name, so a user's own server must not share it.
export const READ_SERVER = "paseo-memorise";
export const WRITE_SERVER = "paseo-memorise-write";
const READ_PATH = "/mcp/read";
const WRITE_PATH = "/mcp/write";
const MAX_REQUEST_BYTES = 256 * 1024;
const WRITES_PER_HOUR = 20;
const HOUR_MS = 60 * 60 * 1000;
const GIT_TIMEOUT_MS = 2_000;

export interface MemoryMcpOptions {
  store: MemoryStore;
  tokens: TokenAuthority;
  // null when SQLite could not be opened; keyword queries then fail with searchProblem.
  search: SearchIndex | null;
  searchProblem?: string;
  usage: UsageLog;
  expiryDays(): Promise<number>;
  // False when the agent's repo is set apart from global memories.
  includeGlobal(repoKey: string): Promise<boolean>;
}

export function mcpServerEntries(port: number, token: string) {
  const headers = { Authorization: `Bearer ${token}` };
  return {
    [READ_SERVER]: { type: "http" as const, url: `http://127.0.0.1:${port}${READ_PATH}`, headers },
    [WRITE_SERVER]: { type: "http" as const, url: `http://127.0.0.1:${port}${WRITE_PATH}`, headers },
  };
}

function describeFact(fact: Fact | FactListItem): string {
  const where = fact.scope === "global" ? "global" : fact.repoKey;
  const cites = fact.citations.map((c) => `${c.path}${c.lines ? `:${c.lines}` : ""}@${c.commit}`).join(", ");
  return [
    `[${fact.id}] ${fact.type} (${where}): ${fact.subject}`,
    fact.body,
    `saved by ${fact.source.by}${fact.source.provider ? ` (${fact.source.provider})` : ""} on ${fact.created.slice(0, 10)}${fact.source.branch ? `, branch ${fact.source.branch}` : ""}`,
    ...(cites ? [`cites: ${cites}`] : []),
    ...(fact.status === "retired" ? ["status: retired"] : []),
    ...("superseded" in fact && fact.superseded ? ["status: replaced by a newer version"] : []),
  ].join("\n");
}

function text(value: string) {
  return { content: [{ type: "text" as const, text: value }] };
}

async function headOf(cwd: string): Promise<{ branch: string | null; commit: string | null }> {
  const read = (args: string[]) => git(cwd, args, GIT_TIMEOUT_MS).catch(() => null);
  const [branch, commit] = await Promise.all([read(["rev-parse", "--abbrev-ref", "HEAD"]), read(["rev-parse", "--short=12", "HEAD"])]);
  return { branch: branch === "HEAD" ? null : branch, commit };
}

const citationInput = z
  .array(z.object({ path: z.string().describe("Path relative to the repo root"), lines: z.string().optional().describe("Line or range, like 12 or 12-18") }))
  .max(MAX_CITATIONS)
  .optional()
  .describe("Code the fact is about. The current commit is recorded, so later sessions can see when that code changed.");

export class MemoryMcp {
  private readonly writeTimes = new Map<string, number[]>();
  private readonly auditPath: string;

  constructor(private readonly options: MemoryMcpOptions) {
    this.auditPath = join(options.store.root, "audit.jsonl");
  }

  // The facts an agent's read tools can reach: its repo's, plus global ones unless the repo is set
  // apart from them.
  private async factsFor(scope: AgentScope): Promise<FactListItem[]> {
    const facts = await this.options.store.list(scope.repoKey);
    if (scope.repoKey === null || (await this.options.includeGlobal(scope.repoKey))) return facts;
    return facts.filter((fact) => fact.scope === "repo");
  }

  private async audit(scope: AgentScope, tool: string, id: string | null, outcome: string): Promise<void> {
    const line = JSON.stringify({ time: new Date().toISOString(), repoKey: scope.repoKey, provider: scope.provider, tool, id, outcome });
    await appendFile(this.auditPath, `${line}\n`, { mode: 0o600 }).catch((error: unknown) => console.error(`[memorise] audit write failed: ${String(error)}`));
  }

  private tool<Args>(scope: AgentScope, name: string, run: (args: Args) => Promise<{ result: string; id: string | null }>) {
    return async (args: Args) => {
      try {
        const { result, id } = await run(args);
        await this.audit(scope, name, id, "ok");
        return text(result);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        await this.audit(scope, name, Reflect.get(Object(args), "id") ?? null, `error: ${message}`);
        return { ...text(message), isError: true };
      }
    };
  }

  private requireRepo(scope: AgentScope): string {
    if (scope.repoKey) return scope.repoKey;
    throw new Error("This agent's folder is not in a git repo, so it has no repo memory. Only the user can save global memories, with /remember --global.");
  }

  private takeWriteSlot(repoKey: string): void {
    const now = Date.now();
    const recent = (this.writeTimes.get(repoKey) ?? []).filter((time) => now - time < HOUR_MS);
    if (recent.length >= WRITES_PER_HOUR) throw new Error(`Refused: ${WRITES_PER_HOUR} memory writes for this repo in the last hour. Save only durable facts.`);
    this.writeTimes.set(repoKey, [...recent, now]);
  }

  private async ownRepoFact(scope: AgentScope, id: string): Promise<FactListItem> {
    const repoKey = this.requireRepo(scope);
    const fact = await this.options.store.get(id, repoKey);
    if (fact.scope !== "repo") throw new Error(`Memory ${id} is global; only the user can change global memories, from the Memory panel.`);
    return fact;
  }

  // Citations are pinned to the commit the agent is looking at, and each cited file must exist there,
  // so a later change to that file can be detected. Paths are relative to the repo root.
  private async pinCitations(cwd: string, citations: { path: string; lines?: string }[], commit: string | null): Promise<Citation[]> {
    if (citations.length === 0) return [];
    if (!commit) throw new Error("This repo has no commit yet, so citations cannot be pinned. Save the fact without citations.");
    const pinned: Citation[] = [];
    for (const citation of citations) {
      const path = citation.path.trim().replace(/^(\.\/)+/, "").replace(/\/{2,}/g, "/");
      const parsed = citationSchema.safeParse({ ...citation, path, commit });
      if (!parsed.success) throw new Error(`Citation ${citation.path}: ${parsed.error.issues.map((issue) => issue.message).join("; ")}`);
      await git(cwd, ["cat-file", "-e", `${commit}:${path}`], GIT_TIMEOUT_MS).catch(() => {
        throw new Error(`Citation ${path} does not exist at commit ${commit}. Cite files by their path from the repo root.`);
      });
      pinned.push(parsed.data);
    }
    return pinned;
  }

  buildReadServer(scope: AgentScope): McpServer {
    const { store } = this.options;
    const mcp = new McpServer({ name: READ_SERVER, version: "0.1.0" });
    mcp.registerTool(
      "memory_search",
      {
        description:
          "Search saved memories (this repo and global) by keywords, ranked by relevance. Pass paths to find memories about specific files. Returns matching facts with ids.",
        inputSchema: {
          query: z.string().max(200).optional(),
          paths: z.array(z.string().min(1).max(300)).max(50).optional().describe("Files relative to the repo root; returns memories about them"),
          limit: z.number().int().min(1).max(20).optional(),
        },
      },
      this.tool(scope, "memory_search", async ({ query, paths, limit }: { query?: string; paths?: string[]; limit?: number }) => {
        if (!query?.trim() && !paths?.length) throw new Error("Give a query, paths, or both.");
        const expiryDays = await this.options.expiryDays();
        const all = await this.factsFor(scope);
        let facts = orderForAgents(all.filter((fact) => isVisibleToAgents(fact, expiryDays)));
        if (paths?.length) facts = facts.filter((fact) => factMatchesFiles(fact, paths));
        const max = limit ?? 8;
        let found: FactListItem[];
        if (query?.trim()) {
          const { search } = this.options;
          if (!search) throw new Error(`Keyword search is unavailable (${this.options.searchProblem ?? "the search index could not be opened"}); search by paths instead.`);
          const byId = new Map(facts.map((fact) => [fact.id, fact]));
          found = search.search(scope.repoKey ?? "global", all, new Set(byId.keys()), query, max).flatMap((id) => byId.get(id) ?? []);
        } else {
          found = facts.slice(0, max);
        }
        if (found.length === 0) return { result: `No memories match${query ? ` "${query}"` : ""}${paths?.length ? " for those paths" : ""}.`, id: null };
        // A fact an agent found is a fact in use; only facts nobody reaches expire.
        for (const fact of found) await store.markUsed(fact.id, scope.repoKey);
        await this.options.usage.record("found", found.map((fact) => fact.id));
        return { result: found.map((fact) => describeFact(fact)).join("\n\n"), id: null };
      }),
    );
    mcp.registerTool(
      "memory_read",
      { description: "Read one memory in full by its id.", inputSchema: { id: factIdSchema } },
      this.tool(scope, "memory_read", async ({ id }: { id: string }) => {
        const fact = (await this.factsFor(scope)).find((candidate) => candidate.id === factIdSchema.parse(id));
        if (!fact) throw new FactNotFoundError(id);
        if (!fact.enabled) throw new Error(`Memory ${id} is turned off by the user`);
        if (fact.status === "active" && !fact.superseded) await store.markUsed(id, scope.repoKey);
        await this.options.usage.record("read", [id]);
        return { result: describeFact(fact), id };
      }),
    );
    return mcp;
  }

  buildWriteServer(scope: AgentScope): McpServer {
    const { store } = this.options;
    const mcp = new McpServer({ name: WRITE_SERVER, version: "0.1.0" });
    mcp.registerTool(
      "memory_write",
      {
        description:
          "Save one durable fact about this repo for future agent sessions: a gotcha, decision, how-to, or reference that the code and docs do not already say. One fact per call. Never include secrets.",
        inputSchema: {
          type: memoryTypeSchema,
          subject: subjectSchema.describe("A few words naming what the fact is about, on one line"),
          fact: bodySchema.describe("The fact itself, stated plainly"),
          citations: citationInput,
          paths: z.array(pathGlobSchema).max(MAX_PATH_GLOBS).optional().describe("File globs the fact is about, relative to the repo root, such as src/api/**"),
        },
      },
      this.tool(scope, "memory_write", async (args: { type: Fact["type"]; subject: string; fact: string; citations?: { path: string; lines?: string }[]; paths?: string[] }) => {
        const repoKey = this.requireRepo(scope);
        assertNoSecret(args.subject, args.fact);
        this.takeWriteSlot(repoKey);
        const head = await headOf(scope.cwd);
        const created = await store.create({
          scope: "repo",
          repoKey,
          type: args.type,
          subject: args.subject,
          body: args.fact,
          paths: args.paths ?? [],
          supersedes: null,
          source: { by: "agent", provider: scope.provider, ...head },
          citations: await this.pinCitations(scope.cwd, args.citations ?? [], head.commit),
        });
        return { result: `Saved memory ${created.id}.`, id: created.id };
      }),
    );
    mcp.registerTool(
      "memory_update",
      {
        description: "Replace a repo memory that is wrong or out of date with a corrected version. The old version is kept as history.",
        inputSchema: {
          id: factIdSchema,
          subject: subjectSchema.optional(),
          fact: bodySchema.optional(),
          citations: citationInput,
        },
      },
      this.tool(scope, "memory_update", async (args: { id: string; subject?: string; fact?: string; citations?: { path: string; lines?: string }[] }) => {
        const old = await this.ownRepoFact(scope, args.id);
        assertNoSecret(args.subject ?? "", args.fact ?? "");
        this.takeWriteSlot(old.repoKey ?? "");
        const head = await headOf(scope.cwd);
        const next = await store.supersede(args.id, old.repoKey, {
          ...(args.subject ? { subject: args.subject } : {}),
          ...(args.fact ? { body: args.fact } : {}),
          // Citations are re-pinned only when the agent cites again; changing the wording alone does not
          // mean the cited code was re-checked, so the old commits (and any "needs check") stay.
          ...(args.citations ? { citations: await this.pinCitations(scope.cwd, args.citations, head.commit) } : {}),
          source: { by: "agent", provider: scope.provider, ...head },
        });
        return { result: `Saved memory ${next.id}, replacing ${args.id}.`, id: next.id };
      }),
    );
    mcp.registerTool(
      "memory_retire",
      {
        description: "Retire a repo memory that no longer applies. It stops being shown to agents but stays visible to the user.",
        inputSchema: { id: factIdSchema, reason: z.string().min(1).max(300) },
      },
      this.tool(scope, "memory_retire", async ({ id }: { id: string; reason: string }) => {
        const fact = await this.ownRepoFact(scope, id);
        this.takeWriteSlot(fact.repoKey ?? "");
        await store.retire(id, fact.repoKey);
        return { result: `Retired memory ${id}.`, id };
      }),
    );
    return mcp;
  }

  listen(port: number): Promise<Server> {
    const http = createServer((req, res) => {
      void this.handle(req, res).catch((error: unknown) => {
        console.error(`[memorise] MCP request failed: ${String(error)}`);
        if (!res.headersSent) res.writeHead(500).end("Internal error");
      });
    });
    return new Promise((resolve, reject) => {
      http.once("error", reject);
      http.listen(port, "127.0.0.1", () => {
        http.off("error", reject);
        resolve(http);
      });
    });
  }

  private async handle(req: IncomingMessage, res: import("node:http").ServerResponse): Promise<void> {
    const path = new URL(req.url ?? "/", "http://127.0.0.1").pathname;
    if (path !== READ_PATH && path !== WRITE_PATH) {
      res.writeHead(404).end(`Expected ${READ_PATH} or ${WRITE_PATH}`);
      return;
    }
    // This server never pushes messages, so it refuses the long-lived GET event stream (allowed by
    // the MCP spec). An open stream would also keep the plugin from shutting down.
    if (req.method !== "POST") {
      res.writeHead(405, { Allow: "POST" }).end("Only POST is supported");
      return;
    }
    const scope = this.options.tokens.verify(req.headers.authorization);
    if (!scope) {
      res.writeHead(401).end("Memory token missing or not valid. Recreate the agent to get a new one.");
      return;
    }
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const chunk of req) {
      size += (chunk as Buffer).length;
      if (size > MAX_REQUEST_BYTES) {
        res.writeHead(413).end(`Request larger than ${MAX_REQUEST_BYTES} bytes`);
        return;
      }
      chunks.push(chunk as Buffer);
    }
    let body: unknown;
    try {
      body = chunks.length > 0 ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : undefined;
    } catch {
      res.writeHead(400).end("Expected a JSON-RPC request body");
      return;
    }
    // Stateless: a fresh server per request, so nothing about one agent leaks into another's session.
    const mcp = path === READ_PATH ? this.buildReadServer(scope) : this.buildWriteServer(scope);
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    res.on("close", () => {
      void transport.close();
      void mcp.close();
    });
    await mcp.connect(transport);
    await transport.handleRequest(req, res, body);
  }
}
