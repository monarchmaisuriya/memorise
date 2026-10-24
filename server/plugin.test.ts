import { execFileSync } from "node:child_process";
import { join } from "node:path";
import type { PluginServerContext } from "@getpaseo/plugin/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { type MemorySettings, memorySettings } from "../shared/memory";
import { contributeMemory } from "./plugin";
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
  const paseo = { agents: { ref: () => ({ respondToPermission }), list: async () => ({ entries: [] }) } };
  return {
    server,
    respondToPermission,
    create: (config: Record<string, unknown>, env?: Record<string, string>) => (before.get("agent.create") as (input: unknown, context: unknown) => Promise<{ config: Record<string, any> }>)({ request: { config, ...(env ? { env } : {}) } }, { paseo }),
    call: (name: string, input: unknown) => (rpc.get(name) as (input: unknown, context: unknown) => Promise<any>)(input, { paseo }),
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
  let cleanup: () => unknown;
  let root: string;
  beforeEach(async () => {
    root = tempDir("plugin-root-");
  });
  afterEach(async () => {
    await cleanup?.();
  });

  function start(values: MemorySettings = defaults) {
    const fake = fakeServer(values);
    cleanup = contributeMemory(fake.server, async () => root) as () => unknown;
    return fake;
  }

  it("gives a new agent the index and both tool servers, keeping other plugins' servers", async () => {
    const fake = start();
    const cwd = await repoWithOrigin("git@github.com:acme/api.git");
    await fake.call("memory.save", { directory: cwd, scope: "global", type: "preference", subject: "commits", body: "Ask before running git commit." });
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

  it("refuses a repo memory outside a git repo and a secret-shaped one", async () => {
    const fake = start();
    const plain = tempDir("plain-");
    await expect(fake.call("memory.save", { directory: plain, scope: "repo", type: "howto", subject: "x", body: "y" })).rejects.toThrow(/not in a git repo/);
    await expect(fake.call("memory.save", { directory: plain, scope: "global", type: "howto", subject: "x", body: "token: ghp_abcdefghijklmnopqrstuvwxyz0123456789" })).rejects.toThrow(/GitHub token/);
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
    const { fact } = await fake.call("memory.save", { directory: cwd, scope: "repo", type: "howto", subject: "build", body: "Run make build." });
    await fake.call("memory.retire", { directory: cwd, id: fact.id });
    expect((await fake.call("memory.restore", { directory: cwd, id: fact.id })).fact.status).toBe("active");
  });

  it("gives the plugin's own workers no memory, and denies their permission requests", async () => {
    const fake = start();
    const cwd = await repoWithOrigin("git@github.com:acme/api.git");
    await fake.call("memory.save", { directory: cwd, scope: "global", type: "preference", subject: "commits", body: "Ask before committing." });
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
    const { fact: first } = await fake.call("memory.save", { directory: cwd, scope: "repo", type: "howto", subject: "first", body: "Older fact." });
    await fake.call("memory.save", { directory: cwd, scope: "repo", type: "howto", subject: "second", body: "Newer fact." });
    await fake.call("memory.pin", { directory: cwd, id: first.id, pinned: true });
    const { config } = await fake.create({ provider: "claude", cwd });
    const lines = config.systemPrompt.split("\n").filter((line: string) => line.startsWith("- ["));
    expect(lines[0]).toContain("(pinned): first");
    const listed = await fake.call("memory.list", { directory: cwd });
    expect(listed.facts.find((fact: { id: string }) => fact.id === first.id).usage.shown).toBe(1);
  });
});
