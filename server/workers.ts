import { mkdir, rm } from "node:fs/promises";
import { join, resolve, sep } from "node:path";
import type { PaseoApi } from "./paseo-types";
import type { Provider } from "./providers";
import { newFactId } from "./store";

// Background "worker" agents run the capture and tidy passes. They read untrusted text, so each one
// runs with its provider's tools switched off through provider options, in a restricted mode, in an
// empty folder of its own, and the plugin denies every permission request a worker raises. Workers
// never get memory themselves, and their own turns are never captured.
export const WORKER_ENV = "MEMORISE_ROLE";
export const WORKER_ROLE = "worker";

const RESTRICTED_MODES: Record<Provider, string> = { claude: "plan", codex: "auto", opencode: "plan" };

// Mode alone is not enough (checked live): in their restricted modes all three providers ran shell
// commands without asking, and OpenCode ran Paseo's own tools (which Paseo adds after plugin hooks).
// Claude: every built-in tool and Paseo's tool server are disallowed, and only the MCP servers given
// here are loaded, so the user's own servers are not. OpenCode: one deny-all rule; that rule also
// blocks Paseo's structured-output tool, so OpenCode workers get no output schema and their JSON reply
// is read from the final message, as for every provider. Codex cannot drop its shell: a read-only
// sandbox without network or web search (Codex rejects approval_policy "untrusted"), and anything
// that needs more than reading asks, which the plugin denies.
export const CLAUDE_BLOCKED_TOOLS = [
  "Bash", "BashOutput", "KillShell", "Read", "Write", "Edit", "MultiEdit", "NotebookEdit", "Glob", "Grep", "LS",
  "WebFetch", "WebSearch", "Task", "Agent", "TodoWrite", "Skill", "SlashCommand", "mcp__paseo",
];
export const LOCKDOWN_OPTIONS: Record<Provider, Record<string, unknown>> = {
  claude: { disallowedTools: CLAUDE_BLOCKED_TOOLS, settings: { permissions: { deny: CLAUDE_BLOCKED_TOOLS } }, extraArgs: { "strict-mcp-config": null } },
  codex: { sandbox_mode: "read-only", web_search: "disabled" },
  opencode: { permission: "deny" },
};
const POLL_MS = 15_000;
const PERMISSION_BACKOFF_MS = 2_000;
const MAX_PERMISSION_WAITS = 10;

export function workersDir(root: string): string {
  return join(root, "workers");
}

export function isWorkerCwd(root: string, cwd: string): boolean {
  const dir = resolve(workersDir(root));
  const target = resolve(cwd);
  return target === dir || target.startsWith(`${dir}${sep}`);
}

export function isWorkerRequest(root: string, cwd: string, env: Record<string, string> | undefined): boolean {
  return env?.[WORKER_ENV] === WORKER_ROLE || isWorkerCwd(root, cwd);
}

export interface WorkerJob {
  provider: Provider;
  model: string;
  title: string;
  prompt: string;
  outputSchema: Record<string, unknown>;
  timeoutMs: number;
}

// The SDK needs "provider/model". A configured model is a model id as `paseo provider models <provider>`
// lists it (OpenCode ids themselves contain a slash); with none, the provider's default model is used.
export async function resolveModel(paseo: PaseoApi, provider: Provider, model: string): Promise<string> {
  if (model) return `${provider}/${model}`;
  const { models } = await paseo.providers.listModels(provider);
  const chosen = models?.find((candidate) => candidate.isDefault) ?? models?.[0];
  if (!chosen) throw new Error(`Paseo lists no models for ${provider}; set a model in Settings > Plugins > Memorise`);
  return `${provider}/${chosen.id}`;
}

// Runs one worker to completion and returns its final message. The worker, its workspace, and its
// folder are removed afterwards whatever happens.
export async function runWorker(paseo: PaseoApi, root: string, job: WorkerJob, onCreated: (agentId: string) => void): Promise<string> {
  const cwd = join(workersDir(root), newFactId());
  await mkdir(cwd, { recursive: true, mode: 0o700 });
  let handle: Awaited<ReturnType<PaseoApi["agents"]["create"]>> | null = null;
  try {
    handle = await paseo.agents.create({
      cwd,
      title: job.title,
      config: { provider: await resolveModel(paseo, job.provider, job.model), modeId: RESTRICTED_MODES[job.provider], options: LOCKDOWN_OPTIONS[job.provider], mcpServers: {} },
      env: { [WORKER_ENV]: WORKER_ROLE },
      prompt: job.prompt,
      ...(job.provider === "opencode" ? {} : { outputSchema: job.outputSchema }),
      background: true,
    });
    onCreated(handle.id);
    const deadline = Date.now() + job.timeoutMs;
    let permissionWaits = 0;
    for (;;) {
      const left = deadline - Date.now();
      if (left <= 0) throw new Error(`${job.title} did not finish in ${Math.round(job.timeoutMs / 1000)} s`);
      const result = await handle.waitForFinish(Math.min(left, POLL_MS));
      if (result.status === "timeout") continue;
      // The worker asked for a tool. The plugin's permission hook denies it; Paseo answers this wait
      // at once while the request is pending, so wait before asking again instead of spinning.
      if (result.status === "permission") {
        permissionWaits += 1;
        if (permissionWaits > MAX_PERMISSION_WAITS) throw new Error(`${job.title} kept asking for tools; stopped`);
        await new Promise((resolve) => setTimeout(resolve, PERMISSION_BACKOFF_MS));
        continue;
      }
      if (result.status === "error") throw new Error(`${job.title} failed: ${result.error ?? "unknown error"}`);
      if (!result.lastMessage) throw new Error(`${job.title} finished without a reply`);
      return result.lastMessage;
    }
  } finally {
    const workspaceId = handle?.workspaceId ?? null;
    await handle?.archive().catch((error: unknown) => console.error(`[memorise] could not archive worker ${handle?.id}: ${String(error)}`));
    if (workspaceId) await paseo.workspaces.archive(workspaceId).catch((error: unknown) => console.error(`[memorise] could not archive worker workspace ${workspaceId}: ${String(error)}`));
    await rm(cwd, { recursive: true, force: true });
  }
}

// Workers answer with JSON, sometimes wrapped in a Markdown code fence or a sentence.
export function extractJson(text: string): unknown {
  const fenced = /```(?:json)?\s*([\s\S]*?)```/.exec(text);
  const candidate = (fenced ? fenced[1] : text).trim();
  const start = candidate.indexOf("{");
  const end = candidate.lastIndexOf("}");
  if (start === -1 || end <= start) throw new Error("The worker's reply contains no JSON object");
  return JSON.parse(candidate.slice(start, end + 1));
}
