import { execFileSync } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";
import type { PluginServerContext } from "@getpaseo/plugin/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { type MemorySettings, memorySettings, updateMemoryRpc } from "../shared/memory";
import { contributeMemory } from "./plugin";
import { ProposalStore } from "./proposals";
import { tempDir } from "./test-temp-dir";

type Handler = (...args: never[]) => unknown;

function fakeServer(values: MemorySettings, readSettings?: () => Promise<unknown>) {
  const before = new Map<string, Handler>();
  const on = new Map<string, Handler>();
  const rpc = new Map<string, Handler>();
  const respondToPermission = vi.fn(async (_input: { requestId: string }) => undefined);
  const server = {
    registerSettings: () => ({ read: readSettings ?? (async () => ({ status: "ready", revision: "1", values })), subscribe: () => () => undefined }),
    before: (name: string, handler: Handler) => before.set(name, handler),
    on: (name: string, handler: Handler) => on.set(name, handler),
    handle: (contract: { name: string }, handler: Handler) => rpc.set(contract.name, handler),
    registerProvider: () => undefined,
    registerUsageSource: () => undefined,
  } as unknown as PluginServerContext;
  const workspaces: { workspaceDirectory?: string; projectRootPath: string; projectKind?: string }[] = [];
  // Rows appended to agents' chats, by agent id.
  const appended: { agentId: string; row: Record<string, any> }[] = [];
  // Each agent's timeline, served only through refetch, as Paseo does: "after" a cursor, or the
  // most recent page for "tail".
  const timelines = new Map<string, unknown[]>();
  const refetch = (agentId: string) => async (options: { direction?: string; cursor?: { seq: number }; limit?: number } = {}) => {
    const all = (timelines.get(agentId) ?? []).map((item, i) => ({ item, seqStart: i + 1, seqEnd: i + 1 }));
    const limit = options.limit ?? 200;
    const page = options.direction === "after" && options.cursor ? all.filter((entry) => entry.seqEnd > (options.cursor?.seq ?? 0)).slice(0, limit) : all.slice(-limit);
    return { epoch: "e1", entries: page, hasNewer: false, reset: false, staleCursor: false };
  };
  const paseo = { agents: { ref: (agentId: string) => ({ respondToPermission, timeline: { refetch: refetch(agentId), append: async (row: Record<string, any>) => appended.push({ agentId, row }) } }), list: async () => ({ entries: [] }) }, workspaces: {
      // One workspace per page, so a lookup must follow the cursor.
      list: async ({ page }: { page?: { cursor?: string } } = {}) => {
        const at = Number(page?.cursor ?? 0);
        return { entries: workspaces.slice(at, at + 1), pageInfo: { hasMore: at + 1 < workspaces.length, nextCursor: String(at + 1), prevCursor: null } };
      },
    },
  };
  return {
    server,
    workspaces,
    respondToPermission,
    appended,
    agentCreated: (id: string, cwd: string) => (on.get("agent.created") as (event: unknown, context: unknown) => Promise<void>)({ agent: { id, cwd, provider: "claude", workspaceId: "ws-1", parentAgentId: null, title: null } }, { paseo }),
    // Items join the agent's timeline; the event itself carries an empty timeline, as Paseo's does.
    addToTimeline: (id: string, items: unknown[]) => timelines.set(id, [...(timelines.get(id) ?? []), ...items]),
    turnEnded: (id: string, cwd: string, items: unknown[]) => {
      timelines.set(id, [...(timelines.get(id) ?? []), ...items]);
      return (on.get("agent.turn_ended") as (event: unknown, context: unknown) => Promise<void>)({ agent: { id, cwd, provider: "claude", workspaceId: "ws-1", parentAgentId: null, title: null }, turnId: null, outcome: { kind: "completed" }, timeline: [] }, { paseo });
    },
    create: (config: Record<string, unknown>, env?: Record<string, string>) => (before.get("agent.create") as (input: unknown, context: unknown) => Promise<{ config: Record<string, any> }>)({ request: { config, ...(env ? { env } : {}) } }, { paseo }),
    call: (name: string, input: unknown) => (rpc.get(name) as (input: unknown, context: unknown) => Promise<any>)(input, { paseo }),
    workspaceCreated: (cwd: string) => (on.get("workspace.created") as (event: unknown, context: unknown) => Promise<void>)({ workspace: { id: "ws-1", projectId: "p-1", cwd, name: null, archivedAt: null } }, { paseo }),
    permission: (request: Record<string, unknown>, cwd = "/tmp") => (on.get("agent.permission_requested") as (event: unknown, context: unknown) => Promise<void>)({ agent: { id: "agent-1", cwd }, request }, { paseo }),
  };
}

async function repoWithOrigin(origin: string): Promise<string> {
  const cwd = tempDir("plugin-repo-");
  execFileSync("git", ["init", "-q", cwd]);
  execFileSync("git", ["-C", cwd, "remote", "add", "origin", origin]);
  return cwd;
}

const defaults: MemorySettings = { ...memorySettings.schema.parse({}), mcpPort: 0 };
const other = { excalidraw: { type: "stdio", command: "excalidraw" } };

describe("memorise server entry", () => {
  let cleanup: () => unknown = () => undefined;
  let root: string;
  beforeEach(async () => {
    root = tempDir("plugin-root-");
  });
  afterEach(async () => {
    // Reset after use: a test that never starts the plugin must not run the previous one's cleanup again.
    await cleanup();
    cleanup = () => undefined;
  });

  function start(values: MemorySettings = defaults) {
    const fake = fakeServer(values);
    cleanup = contributeMemory(fake.server, async () => root) as () => unknown;
    return fake;
  }

  it("gives a new agent the index and both tool servers, keeping other plugins' servers", async () => {
    const fake = start();
    const cwd = await repoWithOrigin("git@github.com:acme/api.git");
    await fake.call("memory.save", { where: { directory: cwd }, scope: "global", type: "preference", subject: "commits", body: "Ask before running git commit." });
    const { config } = await fake.create({ provider: "claude", cwd, systemPrompt: "Be brief.", mcpServers: other });
    expect(config.systemPrompt).toMatch(/^Be brief\.\n\n<memorise>/);
    expect(config.systemPrompt).toContain("preference (global): commits: Ask before running git commit.");
    expect(Object.keys(config.mcpServers).sort()).toEqual(["excalidraw", "paseo-memorise", "paseo-memorise-write"]);
    expect(config.mcpServers["paseo-memorise"].headers.Authorization).toMatch(/^Bearer /);
  });

  it("re-scopes a child agent instead of keeping its parent's section and token", async () => {
    const fake = start();
    const parentCwd = await repoWithOrigin("git@github.com:acme/api.git");
    const childCwd = await repoWithOrigin("git@github.com:acme/web.git");
    const parent = (await fake.create({ provider: "codex", cwd: parentCwd, mcpServers: other })).config;
    const child = (await fake.create({ ...parent, provider: "opencode", cwd: childCwd })).config;
    expect(child.systemPrompt.match(/<memorise>/g)).toHaveLength(1);
    expect(child.systemPrompt).toContain("github.com/acme/web");
    expect(child.mcpServers["paseo-memorise"].headers.Authorization).not.toBe(parent.mcpServers["paseo-memorise"].headers.Authorization);
  });

  it("adds nothing and strips inherited memory when turned off or for other providers", async () => {
    const cwd = await repoWithOrigin("git@github.com:acme/api.git");
    const on = start();
    const inherited = (await on.create({ provider: "claude", cwd, systemPrompt: "Own.", mcpServers: other })).config;
    await cleanup();
    for (const [values, provider] of [[{ ...defaults, enabled: false }, "claude"], [defaults, "deepseek-harness"]] as const) {
      const fake = start(values);
      const { config } = await fake.create({ ...inherited, provider });
      expect(config.systemPrompt).toBe("Own.");
      expect(Object.keys(config.mcpServers)).toEqual(["excalidraw"]);
      await cleanup();
    }
    cleanup = () => undefined;
  });

  it("approves reads for Claude and Codex but never writes", async () => {
    const fake = start();
    await fake.permission({ id: "r1", name: "mcp__paseo-memorise__memory_search" });
    await fake.permission({ id: "r2", name: "CodexMcpElicitation", metadata: { serverName: "paseo-memorise" } });
    await fake.permission({ id: "w1", name: "mcp__paseo-memorise-write__memory_write" });
    await fake.permission({ id: "w2", name: "CodexMcpElicitation", metadata: { serverName: "paseo-memorise-write" } });
    // A user's own server that happens to use the old, generic name is never approved.
    await fake.permission({ id: "u1", name: "mcp__memorise__delete_everything" });
    await fake.permission({ id: "u2", name: "CodexMcpElicitation", metadata: { serverName: "memorise" } });
    expect(fake.respondToPermission.mock.calls.map(([call]) => call.requestId)).toEqual(["r1", "r2"]);
  });

  it("asks for every read when automatic read approval is off", async () => {
    const fake = start({ ...defaults, autoApproveReads: false });
    await fake.permission({ id: "r1", name: "mcp__paseo-memorise__memory_read" });
    expect(fake.respondToPermission).not.toHaveBeenCalled();
  });

  it("keeps a folder outside git as its own project, for agents and the app, and refuses a secret-shaped memory", async () => {
    const fake = start();
    const plain = tempDir("plain-");
    const { fact } = await fake.call("memory.save", { where: { directory: plain }, scope: "repo", type: "howto", subject: "notes", body: "Drafts live in drafts/." });
    expect(fact.repoKey).toMatch(/^folder\/plain-/);
    const errors = vi.spyOn(console, "error");
    const { config } = await fake.create({ provider: "claude", cwd: plain });
    // No git history to diff, so changed files are not asked for (and no error is logged).
    expect(errors.mock.calls.flat().join("\n")).not.toMatch(/changed files/);
    errors.mockRestore();
    expect(config.systemPrompt).toContain("notes: Drafts live in drafts/.");
    expect(Object.keys(config.mcpServers)).toEqual(["paseo-memorise", "paseo-memorise-write"]);
    // A workspace's project folder outside git is a project root, so an agent in a subfolder gets the
    // same memories.
    fake.workspaces.push({ projectRootPath: plain, projectKind: "non_git" });
    await fake.workspaceCreated(plain);
    const sub = join(plain, "drafts");
    await mkdir(sub);
    await vi.waitFor(async () => expect((await fake.create({ provider: "claude", cwd: sub })).config.systemPrompt).toContain("notes: Drafts live in drafts/."));
    await expect(fake.call("memory.save", { where: { directory: plain }, scope: "global", type: "howto", subject: "x", body: "token: ghp_abcdefghijklmnopqrstuvwxyz0123456789" })).rejects.toThrow(/GitHub token/);
  });

  it("still creates the agent, with the problem named, when settings cannot be read", async () => {
    const fake = fakeServer(defaults, async () => {
      throw new Error("settings store offline");
    });
    cleanup = () => undefined;
    contributeMemory(fake.server, async () => root);
    const cwd = await repoWithOrigin("git@github.com:acme/api.git");
    const { config } = await fake.create({ provider: "codex", cwd, systemPrompt: "Own.", mcpServers: other });
    expect(config.systemPrompt).toMatch(/Memory problem: memory could not be loaded \(Error: settings store offline\)/);
    expect(Object.keys(config.mcpServers)).toEqual(["excalidraw"]);
  });

  it("restores a retired memory through the app", async () => {
    const fake = start();
    const cwd = await repoWithOrigin("git@github.com:acme/api.git");
    const { fact } = await fake.call("memory.save", { where: { directory: cwd }, scope: "repo", type: "howto", subject: "build", body: "Run make build." });
    await fake.call("memory.retire", { where: { directory: cwd }, id: fact.id });
    expect((await fake.call("memory.restore", { where: { directory: cwd }, id: fact.id })).fact.status).toBe("active");
  });

  it("gives the plugin's own workers no memory, and denies their permission requests", async () => {
    const fake = start();
    const cwd = await repoWithOrigin("git@github.com:acme/api.git");
    await fake.call("memory.save", { where: { directory: cwd }, scope: "global", type: "preference", subject: "commits", body: "Ask before committing." });
    const byMarker = (await fake.create({ provider: "codex", cwd, systemPrompt: "Extract facts.", mcpServers: other }, { MEMORISE_ROLE: "worker" })).config;
    expect(byMarker.systemPrompt).toBe("Extract facts.");
    expect(Object.keys(byMarker.mcpServers)).toEqual(["excalidraw"]);
    const byFolder = (await fake.create({ provider: "claude", cwd: join(root, "workers", "run-1"), systemPrompt: "Tidy." })).config;
    expect(byFolder.systemPrompt).toBe("Tidy.");
    await fake.permission({ id: "p1", name: "Bash" }, join(root, "workers", "run-1"));
    expect(fake.respondToPermission).toHaveBeenCalledWith({ requestId: "p1", response: { behavior: "deny", message: "Memory workers may not use tools." } });
  });

  it("pins only through the app, and pinned facts lead the index", async () => {
    const fake = start();
    const cwd = await repoWithOrigin("git@github.com:acme/api.git");
    const { fact: first } = await fake.call("memory.save", { where: { directory: cwd }, scope: "repo", type: "howto", subject: "first", body: "Older fact." });
    await fake.call("memory.save", { where: { directory: cwd }, scope: "repo", type: "howto", subject: "second", body: "Newer fact." });
    await fake.call("memory.pin", { where: { directory: cwd }, id: first.id, pinned: true });
    const { config } = await fake.create({ provider: "claude", cwd });
    const lines = config.systemPrompt.split("\n").filter((line: string) => line.startsWith("- ["));
    expect(lines[0]).toContain("(pinned): first");
    const listed = await fake.call("memory.list", { where: { directory: cwd } });
    expect(listed.facts.find((fact: { id: string }) => fact.id === first.id).usage.shown).toBe(1);
  });

  it("manages a repo's memories by repo key, without a workspace", async () => {
    const fake = start();
    const repo = { repoKey: "github.com/acme/api" };
    const { fact } = await fake.call("memory.save", { where: repo, scope: "repo", type: "howto", subject: "build", body: "Run make build.", paths: ["Makefile"], pinned: true });
    expect(fact).toMatchObject({ repoKey: "github.com/acme/api", paths: ["Makefile"], pinned: true, source: { by: "user" } });
    const { fact: edited } = await fake.call("memory.update", { where: repo, id: fact.id, subject: "build command", type: "gotcha", paths: ["Makefile", "scripts/**"] });
    expect(edited).toMatchObject({ subject: "build command", type: "gotcha", body: "Run make build.", paths: ["Makefile", "scripts/**"], supersedes: fact.id });
    const listed = await fake.call("memory.list", { where: repo });
    expect(listed.repoKey).toBe("github.com/acme/api");
    expect(listed.facts.filter((item: { superseded: boolean }) => !item.superseded).map((item: { id: string }) => item.id)).toEqual([edited.id]);
    expect((await fake.call("memory.history", { where: repo, id: fact.id })).versions.map((item: { id: string }) => item.id)).toEqual([edited.id, fact.id]);
  });

  it("treats a null repo key as global memory only", async () => {
    const fake = start();
    await fake.call("memory.save", { where: { repoKey: "github.com/acme/api" }, scope: "repo", type: "howto", subject: "repo", body: "Repo fact." });
    await fake.call("memory.save", { where: { repoKey: null }, scope: "global", type: "preference", subject: "global", body: "Global fact." });
    expect((await fake.call("memory.list", { where: { repoKey: null } })).facts.map((item: { body: string }) => item.body)).toEqual(["Global fact."]);
    await expect(fake.call("memory.save", { where: { repoKey: null }, scope: "repo", type: "howto", subject: "x", body: "y" })).rejects.toThrow(/save the memory as global/);
  });

  it("refuses an update that changes nothing", () => {
    const id = "01JB8Z6X3T5Q9V2M4N7P8R1S0W";
    expect(updateMemoryRpc.input.safeParse({ where: { repoKey: null }, id }).success).toBe(false);
    expect(updateMemoryRpc.input.safeParse({ where: { repoKey: null }, id, body: "new" }).success).toBe(true);
  });

  it("refuses an update whose new subject contains a secret", async () => {
    const fake = start();
    const repo = { repoKey: "github.com/acme/api" };
    const { fact } = await fake.call("memory.save", { where: repo, scope: "repo", type: "howto", subject: "token", body: "Where the token lives." });
    await expect(fake.call("memory.update", { where: repo, id: fact.id, subject: "ghp_abcdefghijklmnopqrstuvwxyz0123456789" })).rejects.toThrow(/Refused/);
  });

  it("reverts a memory to an older version and moves it between repo and global", async () => {
    const fake = start();
    const repo = { repoKey: "github.com/acme/api" };
    const { fact: v1 } = await fake.call("memory.save", { where: repo, scope: "repo", type: "howto", subject: "lint", body: "Run npm run lint." });
    const { fact: v2 } = await fake.call("memory.update", { where: repo, id: v1.id, body: "Run pnpm lint." });
    const { fact: v3 } = await fake.call("memory.revert", { where: repo, id: v2.id, versionId: v1.id });
    expect(v3).toMatchObject({ body: "Run npm run lint.", supersedes: v2.id });
    const { fact: global } = await fake.call("memory.move", { where: repo, id: v3.id, to: "global" });
    expect(global).toMatchObject({ scope: "global", repoKey: null, body: "Run npm run lint." });
    expect((await fake.call("memory.list", { where: { repoKey: "github.com/acme/web" } })).facts.map((item: { id: string }) => item.id)).toEqual([global.id]);
  });

  it("applies a bulk action and reports each memory's result", async () => {
    const fake = start();
    const repo = { repoKey: "github.com/acme/api" };
    const { fact: a } = await fake.call("memory.save", { where: repo, scope: "repo", type: "howto", subject: "a", body: "Fact a." });
    const { fact: b } = await fake.call("memory.save", { where: repo, scope: "repo", type: "howto", subject: "b", body: "Fact b." });
    const missing = "01JB8Z6X3T5Q9V2M4N7P8R1S0W";
    const { results } = await fake.call("memory.bulk", { where: repo, ids: [a.id, b.id, missing], action: "pin" });
    expect(results).toEqual([
      { id: a.id, ok: true },
      { id: b.id, ok: true },
      { id: missing, ok: false, error: `No memory with id ${missing} in this repo or in global memory` },
    ]);
    const pinned = (await fake.call("memory.list", { where: repo })).facts.filter((item: { pinned: boolean }) => item.pinned);
    expect(pinned.map((item: { id: string }) => item.id).sort()).toEqual([a.id, b.id].sort());
  });

  it("changes controls in place, and a content edit keeps them in the new version", async () => {
    const fake = start();
    const repo = { repoKey: "github.com/acme/api" };
    const { fact } = await fake.call("memory.save", { where: repo, scope: "repo", type: "howto", subject: "deploy", body: "Old steps." });
    const { fact: off } = await fake.call("memory.update", { where: repo, id: fact.id, enabled: false, activation: "title" });
    expect(off).toMatchObject({ id: fact.id, enabled: false, activation: "title" });
    const { fact: next } = await fake.call("memory.update", { where: repo, id: fact.id, body: "New steps.", until: "2027-01-01" });
    expect(next).toMatchObject({ supersedes: fact.id, body: "New steps.", enabled: false, activation: "title", until: "2027-01-01" });
  });

  it("keeps disabled and manual memories out of a new agent's index, and bulk-enables them", async () => {
    const fake = start();
    const cwd = await repoWithOrigin("git@github.com:acme/api.git");
    const where = { directory: cwd };
    await fake.call("memory.save", { where, scope: "repo", type: "howto", subject: "listed one", body: "Shown." });
    const { fact: off } = await fake.call("memory.save", { where, scope: "repo", type: "howto", subject: "disabled one", body: "Hidden.", enabled: false });
    const { fact: manual } = await fake.call("memory.save", { where, scope: "repo", type: "howto", subject: "manual one", body: "Search only.", activation: "manual" });
    const listedSubjects = async () => (await fake.create({ provider: "claude", cwd })).config.systemPrompt.split("\n").filter((line: string) => line.startsWith("- ["));
    const before = (await listedSubjects()).join("\n");
    expect(before).toContain("listed one");
    expect(before).not.toContain("disabled one");
    expect(before).not.toContain("manual one");
    expect((await fake.call("memory.bulk", { where, ids: [off.id], action: "enable" })).results).toEqual([{ id: off.id, ok: true }]);
    expect((await listedSubjects()).join("\n")).toContain("disabled one");
    expect((await fake.call("memory.bulk", { where, ids: [off.id, manual.id], action: "disable" })).results.every((result: { ok: boolean }) => result.ok)).toBe(true);
    expect((await fake.call("memory.list", { where })).facts.filter((item: { enabled: boolean }) => !item.enabled)).toHaveLength(2);
  });

  it("previews exactly what a new agent gets, with why each memory is listed", async () => {
    const fake = start();
    const cwd = await repoWithOrigin("git@github.com:acme/api.git");
    const where = { directory: cwd };
    const { fact: pinned } = await fake.call("memory.save", { where, scope: "repo", type: "howto", subject: "lint", body: "Run pnpm lint.", pinned: true });
    const { fact: title } = await fake.call("memory.save", { where, scope: "repo", type: "howto", subject: "deploy", body: "Long steps.", activation: "title" });
    const { fact: global } = await fake.call("memory.save", { where, scope: "global", type: "preference", subject: "commits", body: "Small commits." });
    const preview = await fake.call("memory.preview", { directory: cwd });
    expect(preview).toMatchObject({ repoKey: "github.com/acme/api", off: false, maxLines: 150, maxBytes: 8192 });
    expect(preview.listed).toEqual([
      { id: pinned.id, subject: "lint", reason: "pinned", titleOnly: false },
      { id: global.id, subject: "commits", reason: "global", titleOnly: false },
      { id: title.id, subject: "deploy", reason: "repo", titleOnly: true },
    ]);
    const { config } = await fake.create({ provider: "claude", cwd });
    expect(config.systemPrompt).toContain(preview.text);
    expect(preview.bytes).toBe(Buffer.byteLength(preview.text));
  });

  it("turns memory off for one repo, and can keep a repo apart from global memories", async () => {
    const fake = start();
    const cwd = await repoWithOrigin("git@github.com:acme/api.git");
    const repoKey = "github.com/acme/api";
    await fake.call("memory.save", { where: { directory: cwd }, scope: "repo", type: "howto", subject: "repo fact", body: "Repo only." });
    await fake.call("memory.save", { where: { directory: cwd }, scope: "global", type: "preference", subject: "global fact", body: "Everywhere." });
    expect((await fake.call("memory.repo-prefs.get", { repoKey })).prefs).toEqual({ enabled: true, includeGlobal: true, capture: "default", autoApprove: false });
    await fake.call("memory.repo-prefs.set", { repoKey, prefs: { enabled: false, includeGlobal: true, capture: "default" } });
    const off = (await fake.create({ provider: "claude", cwd, systemPrompt: "Own.", mcpServers: other })).config;
    expect(off.systemPrompt).toBe("Own.");
    expect(Object.keys(off.mcpServers)).toEqual(["excalidraw"]);
    expect((await fake.call("memory.preview", { directory: cwd })).off).toBe(true);
    await fake.call("memory.repo-prefs.set", { repoKey, prefs: { enabled: true, includeGlobal: false, capture: "default" } });
    const apart = (await fake.create({ provider: "claude", cwd })).config.systemPrompt;
    expect(apart).toContain("repo fact");
    expect(apart).not.toContain("global fact");
  });

  it("exports a repo's memories and imports them into another repo once, with a dry run first", async () => {
    const fake = start();
    const api = { repoKey: "github.com/acme/api" };
    const web = { repoKey: "github.com/acme/web" };
    await fake.call("memory.save", { where: api, scope: "repo", type: "howto", subject: "build", body: "Run make build.", paths: ["Makefile"] });
    await fake.call("memory.save", { where: api, scope: "repo", type: "gotcha", subject: "docker", body: "Tests need DOCKER_HOST." });
    await fake.call("memory.save", { where: api, scope: "global", type: "preference", subject: "style", body: "Small commits." });
    const exported = await fake.call("memory.export", { where: api, format: "json" });
    expect(exported.count).toBe(2);
    const dry = await fake.call("memory.import", { where: web, scope: "repo", text: exported.text, dryRun: true });
    // Both were saved in the same moment, so the test checks which were added, not their order.
    expect(dry.added.map((entry: { subject: string }) => entry.subject).sort()).toEqual(["build", "docker"]);
    expect((await fake.call("memory.list", { where: web })).facts.filter((item: { scope: string }) => item.scope === "repo")).toEqual([]);
    await fake.call("memory.import", { where: web, scope: "repo", text: exported.text, dryRun: false });
    const imported = (await fake.call("memory.list", { where: web })).facts.filter((item: { scope: string }) => item.scope === "repo");
    expect(imported.map((item: { subject: string; paths: string[]; source: { by: string } }) => [item.subject, item.paths, item.source.by]).sort()).toEqual([
      ["build", ["Makefile"], "user"],
      ["docker", [], "user"],
    ]);
    const again = await fake.call("memory.import", { where: web, scope: "repo", text: exported.text, dryRun: false });
    expect(again.added).toEqual([]);
    expect(again.skipped.map((entry: { reason: string }) => entry.reason)).toEqual(["already saved", "already saved"]);
  });

  it("applies the memory length setting to saves and skips longer entries in an import", async () => {
    const fake = start();
    const api = { repoKey: "github.com/acme/api" };
    await expect(fake.call("memory.save", { where: api, scope: "repo", type: "howto", subject: "long", body: "x".repeat(1_200) })).rejects.toThrow("Memory must be 1,000 characters or less; this one has 1,200");
    const text = JSON.stringify([{ type: "howto", subject: "short", body: "Run make." }, { type: "howto", subject: "long", body: "x".repeat(1_200) }]);
    const dry = await fake.call("memory.import", { where: api, scope: "repo", text, dryRun: true });
    expect(dry.added.map((entry: { subject: string }) => entry.subject)).toEqual(["short"]);
    expect(dry.skipped).toEqual([{ line: "long", reason: "longer than 1,000 characters" }]);
    const roomy = start({ ...defaults, memoryMaxChars: 5_000 });
    expect((await roomy.call("memory.save", { where: api, scope: "repo", type: "howto", subject: "long", body: "x".repeat(1_200) })).fact.body).toHaveLength(1_200);
  });

  it("lists, approves, and rejects a repo's proposals by repo key, and starts a tidy by repo key", async () => {
    const fake = start();
    const repo = { repoKey: "github.com/acme/api" };
    const source = { from: "capture" as const, agentId: "agent-1", provider: "claude", model: null };
    const base = { repoKey: "github.com/acme/api", kind: "new" as const, targets: [], type: "howto" as const, paths: [], reason: "", source };
    await new ProposalStore(root).add([{ ...base, subject: "keep", body: "Keep this." }, { ...base, subject: "drop", body: "Drop this." }], []);
    const listed = (await fake.call("memory.proposals.list", { where: repo })).proposals;
    expect(listed.map((proposal: { subject: string }) => proposal.subject).sort()).toEqual(["drop", "keep"]);
    const id = (subject: string) => listed.find((proposal: { subject: string }) => proposal.subject === subject).id;
    await fake.call("memory.proposals.approve", { where: repo, id: id("keep") });
    await fake.call("memory.proposals.reject", { where: repo, id: id("drop") });
    expect((await fake.call("memory.proposals.list", { where: repo })).proposals).toEqual([]);
    expect((await fake.call("memory.list", { where: repo })).facts.map((fact: { subject: string }) => fact.subject)).toEqual(["keep"]);
    // One memory is not enough to tidy, and the caller is told so instead of a tidy that does nothing.
    await expect(fake.call("memory.tidy", { where: repo })).rejects.toThrow(/at least 2 memories/);
  });

  it("counts pending proposals per repo", async () => {
    const fake = start();
    const source = { from: "capture" as const, agentId: null, provider: "claude", model: null };
    const proposal = (repoKey: string, subject: string) => ({ repoKey, kind: "new" as const, targets: [], type: "howto" as const, subject, body: `${subject} body.`, paths: [], reason: "", source });
    const store = new ProposalStore(root);
    await store.add([proposal("github.com/acme/api", "a")], []);
    await store.add([proposal("github.com/acme/web", "b"), proposal("github.com/acme/web", "c")], []);
    // A proposal file that cannot be read is skipped by the list, so it is not counted either.
    await mkdir(join(root, "proposals", "github.com", "acme", "docs"), { recursive: true });
    await writeFile(join(root, "proposals", "github.com", "acme", "docs", "broken.json"), "{");
    expect((await fake.call("memory.proposals.summary", {})).repos).toEqual([
      { repoKey: "github.com/acme/api", pending: 1 },
      { repoKey: "github.com/acme/web", pending: 2 },
    ]);
  });

  it("scans a project by repo key through an open workspace of it, and says what to do without one", async () => {
    const fake = start();
    const where = { repoKey: "github.com/acme/api" };
    await expect(fake.call("memory.project.scan", { where, mode: "create" })).rejects.toThrow(/Open a workspace of github.com\/acme\/api/);
    const other = await repoWithOrigin("git@github.com:acme/web.git");
    const cwd = await repoWithOrigin("git@github.com:acme/api.git");
    for (const folder of [other, cwd]) await writeFile(join(folder, "README.md"), "Run make dev.\n");
    // The repo's workspace is on the second page.
    fake.workspaces.push({ projectRootPath: other }, { workspaceDirectory: cwd, projectRootPath: cwd });
    expect(await fake.call("memory.project.scan", { where, mode: "create" })).toEqual({ started: true, folder: cwd });
    // A scan by folder needs no open workspace; a different repo, so it does not wait on the first.
    expect(await fake.call("memory.project.scan", { where: { directory: other }, mode: "refresh" })).toEqual({ started: true, folder: other });
    // The fake Paseo cannot start a worker, so each scan fails, and the inbox is told why.
    for (const scanned of [where, { repoKey: "github.com/acme/web" }]) {
      await vi.waitFor(async () => expect((await fake.call("memory.proposals.list", { where: scanned })).lastRun).toMatchObject({ kind: "scan", state: "failed" }));
    }
  });

  it("gives the very first agent in a subfolder of a Paseo project outside git that project's memories", async () => {
    const fake = start();
    const site = tempDir("plugin-site-");
    fake.workspaces.push({ projectRootPath: site, projectKind: "non_git" });
    await fake.call("memory.save", { where: { directory: site }, scope: "repo", type: "howto", subject: "deploy", body: "Upload with rsync." });
    const blog = join(site, "blog");
    await mkdir(blog);
    expect((await fake.create({ provider: "claude", cwd: blog })).config.systemPrompt).toContain("deploy: Upload with rsync.");
  });

  it("shows each agent a receipt of the memories it was given, updated as it uses them", async () => {
    const fake = start();
    const cwd = await repoWithOrigin("git@github.com:acme/api.git");
    const where = { repoKey: "github.com/acme/api" };
    for (const subject of ["one", "two"]) await fake.call("memory.save", { where, scope: "repo", type: "howto", subject, body: `${subject} body.` });
    await fake.create({ provider: "claude", cwd });
    // An agent Memorise did not prepare (another folder) gets no receipt.
    await fake.agentCreated("agent-8", tempDir("plugin-plain-"));
    const read = { type: "tool_call", callId: "c1", name: "mcp__paseo-memorise__memory_read", detail: { type: "unknown" }, status: "completed", error: null };
    // What is in the timeline before the agent is created is not its use.
    fake.addToTimeline("agent-9", [{ ...read, callId: "c0" }]);
    await fake.agentCreated("agent-9", cwd);
    expect(fake.appended).toEqual([{ agentId: "agent-9", row: { type: "plugin", id: "memorise-receipt", kind: "memorise-receipt", version: 1, data: { listed: 2, opened: 0, searched: 0, saved: 0, archived: 0, other: 0 } } }]);
    await fake.turnEnded("agent-9", cwd, [read, { ...read, callId: "c2" }]);
    await fake.turnEnded("agent-9", cwd, [{ type: "assistant_message", text: "done" }]);
    expect(fake.appended).toHaveLength(2);
    expect(fake.appended[1].row.data).toEqual({ listed: 2, opened: 2, searched: 0, saved: 0, archived: 0, other: 0 });
  });

  it("adds no receipt when the setting is off", async () => {
    const fake = start({ ...defaults, showMemoryUse: false });
    const cwd = await repoWithOrigin("git@github.com:acme/api.git");
    await fake.create({ provider: "claude", cwd });
    await fake.agentCreated("agent-1", cwd);
    await fake.turnEnded("agent-1", cwd, [{ type: "tool_call", callId: "c1", name: "memory_read", detail: {}, status: "completed", error: null }]);
    expect(fake.appended).toEqual([]);
  });

  it("lists a folder memory meant for matching files once a matching file changed this week", async () => {
    const fake = start();
    const plain = tempDir("plugin-plain-");
    const where = { directory: plain };
    await fake.call("memory.save", { where, scope: "repo", type: "howto", subject: "drafts", body: "Drafts use the template.", paths: ["drafts/**"], activation: "files" });
    const listed = async () => (await fake.create({ provider: "claude", cwd: plain })).config.systemPrompt as string;
    expect(await listed()).not.toContain("Drafts use the template.");
    await mkdir(join(plain, "drafts"));
    await writeFile(join(plain, "drafts", "trip.md"), "Day one.\n");
    expect(await listed()).toContain("Drafts use the template.");
  });

  it("scans a new workspace's project when automatic scans are on, and the inbox says how it went", async () => {
    const fake = start({ ...defaults, projectAutoScan: "once" });
    const cwd = tempDir("plugin-plain-");
    await writeFile(join(cwd, "README.md"), "Notes.\n");
    // The hook returns before the scan finishes, which takes longer than Paseo waits for a hook.
    await fake.workspaceCreated(cwd);
    // The fake Paseo cannot start a worker, so the scan that started fails, and the inbox is told.
    await vi.waitFor(async () => expect((await fake.call("memory.proposals.list", { where: { directory: cwd } })).lastRun).toMatchObject({ kind: "scan", state: "failed" }));
  });

  it("searches a repo's memories by repo key and lists every repo with counts", async () => {
    const fake = start();
    const repo = { repoKey: "github.com/acme/api" };
    const { fact } = await fake.call("memory.save", { where: repo, scope: "repo", type: "gotcha", subject: "docker", body: "Integration tests need DOCKER_HOST set." });
    await fake.call("memory.save", { where: repo, scope: "repo", type: "howto", subject: "build", body: "Run make build." });
    await fake.call("memory.save", { where: { repoKey: null }, scope: "global", type: "preference", subject: "style", body: "Prefer small commits." });
    expect((await fake.call("memory.search", { where: repo, query: "docker" })).ids).toEqual([fact.id]);
    const { repos } = await fake.call("memory.repos", {});
    expect(repos.map(({ repoKey, active }: { repoKey: string | null; active: number }) => ({ repoKey, active }))).toEqual([
      { repoKey: null, active: 1 },
      { repoKey: "github.com/acme/api", active: 2 },
    ]);
  });

  it("lists repos with an open workspace or only proposals beside those with memories, each once", async () => {
    const fake = start();
    await fake.call("memory.save", { where: { repoKey: "github.com/acme/api" }, scope: "repo", type: "howto", subject: "build", body: "Run make build." });
    const api = await repoWithOrigin("git@github.com:acme/api.git");
    const web = await repoWithOrigin("git@github.com:acme/web.git");
    const notGit = tempDir("plugin-plain-");
    // One workspace per page in the fake, so the web workspace is on the fourth page.
    // The plugin's own worker folders are never listed as projects.
    const worker = join(root, "workers", "w1");
    await mkdir(worker, { recursive: true });
    fake.workspaces.push({ workspaceDirectory: api, projectRootPath: api }, { projectRootPath: notGit }, { projectRootPath: worker }, { projectRootPath: web });
    const source = { from: "capture" as const, agentId: null, provider: "claude", model: null };
    await new ProposalStore(root).add([{ repoKey: "github.com/acme/docs", kind: "new", targets: [], type: "howto", subject: "docs", body: "Docs build with mkdocs.", paths: [], reason: "", source }], []);
    const { repos } = await fake.call("memory.repos", {});
    expect(repos).toEqual([
      { repoKey: null, active: 0, retired: 0, lastModified: null, label: null },
      // A workspace folder outside git is a project of its own, shown by its folder's name.
      { repoKey: expect.stringMatching(/^folder\/plugin-plain-/), active: 0, retired: 0, lastModified: null, label: basename(notGit) },
      { repoKey: "github.com/acme/api", active: 1, retired: 0, lastModified: expect.any(String), label: null },
      { repoKey: "github.com/acme/docs", active: 0, retired: 0, lastModified: null, label: null },
      { repoKey: "github.com/acme/web", active: 0, retired: 0, lastModified: null, label: null },
    ]);
  });
});
