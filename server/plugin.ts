import type { Server } from "node:http";
import type { PluginServerContext } from "@getpaseo/plugin/server";
import {
  approveProposalRpc,
  type BulkAction,
  bulkMemoryRpc,
  deleteMemoryRpc,
  listMemoriesRpc,
  listProposalsRpc,
  listReposRpc,
  MAX_BULK_IDS,
  memoryHistoryRpc,
  memorySettings,
  type MemorySettings,
  moveMemoryRpc,
  pinMemoryRpc,
  rejectProposalRpc,
  restoreMemoryRpc,
  retireMemoryRpc,
  revertMemoryRpc,
  saveMemoryRpc,
  searchMemoriesRpc,
  tidyMemoryRpc,
  updateMemoryRpc,
  type Where,
} from "../shared/memory";
import { Capture } from "./capture";
import { checkCitations } from "./citations";
import { buildMemorySection, withMemorySection, withoutMemorySection } from "./index-prompt";
import { MemoryMcp, mcpServerEntries, READ_SERVER, WRITE_SERVER } from "./mcp";
import { loadTokenSecret, TokenAuthority } from "./mcp-auth";
import { ProposalStore } from "./proposals";
import { supportedProvider } from "./providers";
import { readRepoKey } from "./repo-key";
import { SearchIndex } from "./search-index";
import { assertNoSecret } from "./secrets";
import { MemoryStore } from "./store";
import { UsageLog, usageOf } from "./usage";
import { isVisibleToAgents, orderForAgents, rankForAgent } from "./visibility";
import { PathMatcher, workFiles } from "./work-files";
import { isWorkerRequest } from "./workers";

const CITATION_BUDGET_MS = 1_000;
const PATH_MATCH_BUDGET_MS = 500;
const BY_USER = { by: "user" as const, provider: null, branch: null, commit: null };

interface Runtime {
  root: string;
  store: MemoryStore;
  tokens: TokenAuthority;
  search: SearchIndex | null;
  usage: UsageLog;
  proposals: ProposalStore;
  capture: Capture;
  port: number;
  mcpProblem: string | null;
  http: Server | null;
}

export function contributeMemory(server: PluginServerContext, resolveRoot: () => Promise<string>) {
  const settings = server.registerSettings(memorySettings);

  async function currentSettings(): Promise<MemorySettings> {
    const state = await settings.read();
    if (state.status === "ready") return state.values;
    console.error(`[memorise] settings are invalid (${state.error}); using defaults until they are fixed`);
    return memorySettings.schema.parse({});
  }

  const runtime: Promise<Runtime> = (async () => {
    const root = await resolveRoot();
    const store = new MemoryStore(root);
    const tokens = new TokenAuthority(await loadTokenSecret(root));
    // Search is one feature; a SQLite failure must not take the whole plugin down with it.
    let search: SearchIndex | null = null;
    let searchProblem: string | undefined;
    try {
      search = new SearchIndex(root);
    } catch (error) {
      searchProblem = String(error);
      console.error(`[memorise] the search index could not be opened (${searchProblem}); keyword search is off`);
    }
    const usage = new UsageLog(root);
    const proposals = new ProposalStore(root);
    const capture = new Capture({ root, store, proposals, usage, settings: currentSettings });
    capture.startWeeklyTidy(() => store.repoKeys());
    const { mcpPort } = await currentSettings();
    const mcp = new MemoryMcp({ store, tokens, search, searchProblem, usage, expiryDays: async () => (await currentSettings()).expiryDays });
    const base = { root, store, tokens, search, usage, proposals, capture, port: mcpPort };
    try {
      const http = await mcp.listen(mcpPort);
      console.log(`[memorise] store ${root}; MCP on 127.0.0.1:${mcpPort}`);
      return { ...base, mcpProblem: null, http };
    } catch (error) {
      // Agents keep their stored MCP address, so never silently move to another port.
      const problem = `the memory tool server could not listen on 127.0.0.1:${mcpPort} (${String(error)}); change the port in Settings > Plugins > Memorise and reload the plugin`;
      console.error(`[memorise] ${problem}`);
      return { ...base, mcpProblem: problem, http: null };
    }
  })();
  runtime.catch((error: unknown) => console.error(`[memorise] failed to start: ${String(error)}`));

  server.before("agent.create", async ({ request }, { paseo }) => {
    const { config } = request;
    // Always drop what a parent agent passed down: a child may run in another repo.
    const ownNames = new Set<string>([READ_SERVER, WRITE_SERVER]);
    const otherServers = Object.fromEntries(Object.entries(config.mcpServers ?? {}).filter(([name]) => !ownNames.has(name)));
    const stripped = { ...config, systemPrompt: withoutMemorySection(config.systemPrompt), mcpServers: otherServers };
    const provider = supportedProvider(config.provider);
    if (!provider) return { ...request, config: stripped };

    // Memory enriches an agent; a memory failure (settings included) must not block agent creation,
    // so it is reported to the agent in the section and to the plugin log instead.
    try {
      const values = await currentSettings();
      if (!values.enabled) return { ...request, config: stripped };
      const { root, store, tokens, usage, capture, port, mcpProblem } = await runtime;
      capture.remember(paseo);
      // The plugin's own capture and tidy workers get no memory and no memory tools.
      if (isWorkerRequest(root, config.cwd, request.env)) return { ...request, config: stripped };
      const problems: string[] = mcpProblem ? [mcpProblem] : [];
      const repoKey = await readRepoKey(config.cwd).catch((error: unknown) => {
        problems.push(`repo memory is unavailable for this session (${String(error)})`);
        console.error(`[memorise] repo key for ${config.cwd} failed: ${String(error)}`);
        return null;
      });
      const changed = repoKey
        ? await workFiles(config.cwd).catch((error: unknown) => {
            console.error(`[memorise] changed files for ${config.cwd} unavailable: ${String(error)}`);
            return [];
          })
        : [];
      const paths = new PathMatcher(changed, PATH_MATCH_BUDGET_MS);
      const visible = rankForAgent((await store.list(repoKey)).filter((fact) => isVisibleToAgents(fact, values.expiryDays)), paths);
      if (paths.skipped) problems.push("ranking by changed files was cut short (time budget); some memories about those files may be listed lower");
      const notes = repoKey ? await checkCitations(config.cwd, visible.filter((fact) => fact.scope === "repo"), CITATION_BUDGET_MS) : new Map<string, string>();
      const section = buildMemorySection({ repoKey, facts: visible, notes, maxLines: values.indexMaxLines, toolsAvailable: mcpProblem === null, problems });
      await usage.record("shown", section.shownIds).catch((error: unknown) => console.error(`[memorise] usage log write failed: ${String(error)}`));
      const token = tokens.mint({ repoKey, cwd: config.cwd, provider });
      return {
        ...request,
        config: {
          ...stripped,
          systemPrompt: withMemorySection(stripped.systemPrompt, section.text),
          mcpServers: mcpProblem === null ? { ...otherServers, ...mcpServerEntries(port, token) } : otherServers,
        },
      };
    } catch (error) {
      console.error(`[memorise] could not prepare memory for a ${provider} agent in ${config.cwd}: ${String(error)}`);
      const section = buildMemorySection({ repoKey: null, facts: [], notes: new Map(), maxLines: 0, toolsAvailable: false, problems: [`memory could not be loaded (${String(error)})`] });
      return { ...request, config: { ...stripped, systemPrompt: withMemorySection(stripped.systemPrompt, section.text) } };
    }
  });

  // Reads are approved for the agent; writes still go to the user. Claude names the tool
  // mcp__<server>__<tool>; Codex only names the server. Every request from the plugin's own
  // workers is denied: they only read the text they were given.
  server.on("agent.permission_requested", async ({ agent, request }, { paseo }) => {
    const { capture } = await runtime;
    capture.remember(paseo);
    if (capture.isWorker(agent.id, agent.cwd)) {
      await paseo.agents.ref(agent.id).respondToPermission({ requestId: request.id, response: { behavior: "deny", message: "Memory workers may not use tools." } });
      return;
    }
    const isRead = request.name.startsWith(`mcp__${READ_SERVER}__`) || (request.name === "CodexMcpElicitation" && request.metadata?.serverName === READ_SERVER);
    if (!isRead || !(await currentSettings()).autoApproveReads) return;
    await paseo.agents.ref(agent.id).respondToPermission({ requestId: request.id, response: { behavior: "allow" } });
  });

  server.on("agent.turn_started", async ({ agent }) => {
    const { capture } = await runtime;
    capture.onTurnStarted(agent.id);
  });

  server.on("agent.turn_ended", async ({ agent }, { paseo }) => {
    const { capture } = await runtime;
    await capture.onTurnEnded(agent, paseo);
  });

  // The panel names a workspace folder; the manager names a repo key, or null for global only.
  const repoKeyOf = (where: Where): Promise<string | null> => ("directory" in where ? readRepoKey(where.directory) : Promise.resolve(where.repoKey));

  server.handle(listMemoriesRpc, async ({ where }) => {
    const [{ store, usage }, repoKey, values] = await Promise.all([runtime, repoKeyOf(where), currentSettings()]);
    const counts = await usage.counts();
    const facts = orderForAgents(await store.list(repoKey)).map((fact) => ({ ...fact, visibleToAgents: isVisibleToAgents(fact, values.expiryDays), usage: usageOf(counts, fact.id) }));
    return { repoKey, facts };
  });

  server.handle(saveMemoryRpc, async ({ where, scope, type, subject, body, paths, pinned, activation, enabled, until }) => {
    const [{ store }, repoKey] = await Promise.all([runtime, repoKeyOf(where)]);
    if (scope === "repo" && !repoKey) throw new Error("directory" in where ? "This folder is not in a git repo; save the memory as global instead." : "No repo was chosen; save the memory as global instead.");
    assertNoSecret(subject, body);
    const fact = await store.create({ scope, repoKey: scope === "repo" ? repoKey : null, type, subject, body, paths, pinned, activation, enabled, until, supersedes: null, source: BY_USER, citations: [] });
    return { fact };
  });

  // A content change is a new version that also carries any control change; controls alone change
  // in place. Either way it is one write.
  server.handle(updateMemoryRpc, async ({ where, id, subject, body, type, paths, activation, enabled, until }) => {
    const [{ store }, repoKey] = await Promise.all([runtime, repoKeyOf(where)]);
    assertNoSecret(subject ?? "", body ?? "");
    const content = { ...(subject !== undefined && { subject }), ...(body !== undefined && { body }), ...(type !== undefined && { type }), ...(paths !== undefined && { paths }) };
    const controls = { ...(activation !== undefined && { activation }), ...(enabled !== undefined && { enabled }), ...(until !== undefined && { until }) };
    if (Object.keys(content).length === 0) return { fact: await store.setControls(id, repoKey, controls) };
    return { fact: await store.supersede(id, repoKey, { ...content, ...controls, source: BY_USER }) };
  });

  server.handle(pinMemoryRpc, async ({ where, id, pinned }) => {
    const [{ store }, repoKey] = await Promise.all([runtime, repoKeyOf(where)]);
    return { fact: await store.setPinned(id, repoKey, pinned) };
  });

  server.handle(retireMemoryRpc, async ({ where, id }) => {
    const [{ store }, repoKey] = await Promise.all([runtime, repoKeyOf(where)]);
    return { fact: await store.retire(id, repoKey) };
  });

  server.handle(restoreMemoryRpc, async ({ where, id }) => {
    const [{ store }, repoKey] = await Promise.all([runtime, repoKeyOf(where)]);
    return { fact: await store.restore(id, repoKey) };
  });

  server.handle(deleteMemoryRpc, async ({ where, id }) => {
    const [{ store }, repoKey] = await Promise.all([runtime, repoKeyOf(where)]);
    await store.delete(id, repoKey);
    return { deleted: true as const };
  });

  server.handle(listReposRpc, async () => ({ repos: await (await runtime).store.summaries() }));

  server.handle(searchMemoriesRpc, async ({ where, query }) => {
    const [{ store, search }, repoKey] = await Promise.all([runtime, repoKeyOf(where)]);
    if (!search) throw new Error("Keyword search is unavailable: the search index could not be opened (see the plugin log).");
    const facts = await store.list(repoKey);
    const current = new Set(facts.filter((fact) => !fact.superseded).map((fact) => fact.id));
    return { ids: search.search(repoKey ?? "global", facts, current, query, MAX_BULK_IDS) };
  });

  server.handle(memoryHistoryRpc, async ({ where, id }) => {
    const [{ store }, repoKey] = await Promise.all([runtime, repoKeyOf(where)]);
    return { versions: await store.history(id, repoKey) };
  });

  server.handle(revertMemoryRpc, async ({ where, id, versionId }) => {
    const [{ store }, repoKey] = await Promise.all([runtime, repoKeyOf(where)]);
    return { fact: await store.revert(id, versionId, repoKey, BY_USER) };
  });

  server.handle(moveMemoryRpc, async ({ where, id, to }) => {
    const [{ store }, repoKey] = await Promise.all([runtime, repoKeyOf(where)]);
    return { fact: await store.move(id, repoKey, to) };
  });

  // Each id is applied on its own and reported, so one missing or retired memory does not stop the rest.
  server.handle(bulkMemoryRpc, async ({ where, ids, action }) => {
    const [{ store }, repoKey] = await Promise.all([runtime, repoKeyOf(where)]);
    const apply: Record<BulkAction, (id: string) => Promise<unknown>> = {
      retire: (id) => store.retire(id, repoKey),
      restore: (id) => store.restore(id, repoKey),
      pin: (id) => store.setPinned(id, repoKey, true),
      unpin: (id) => store.setPinned(id, repoKey, false),
      enable: (id) => store.setControls(id, repoKey, { enabled: true }),
      disable: (id) => store.setControls(id, repoKey, { enabled: false }),
      delete: (id) => store.delete(id, repoKey),
    };
    const results: { id: string; ok: boolean; error?: string }[] = [];
    for (const id of ids) {
      try {
        await apply[action](id);
        results.push({ id, ok: true });
      } catch (error) {
        results.push({ id, ok: false, error: error instanceof Error ? error.message : String(error) });
      }
    }
    return { results };
  });

  server.handle(listProposalsRpc, async ({ directory }) => {
    const [{ store, proposals, capture }, repoKey] = await Promise.all([runtime, readRepoKey(directory)]);
    if (!repoKey) return { repoKey, proposals: [], captureRunsToday: await capture.runsToday() };
    const facts = new Map((await store.list(repoKey)).map((fact) => [fact.id, fact]));
    const pending = (await proposals.list(repoKey)).map((proposal) => ({
      ...proposal,
      targetFacts: proposal.targets.flatMap((id) => {
        const fact = facts.get(id);
        return fact ? [{ id, subject: fact.subject, body: fact.body }] : [];
      }),
    }));
    return { repoKey, proposals: pending, captureRunsToday: await capture.runsToday() };
  });

  server.handle(approveProposalRpc, async ({ directory, id, subject, body, paths }) => {
    const [{ store, proposals }, repoKey] = await Promise.all([runtime, readRepoKey(directory)]);
    if (!repoKey) throw new Error("This folder is not in a git repo, so it has no proposals.");
    await proposals.approve(id, repoKey, store, { subject, body, paths });
    return { approved: true as const };
  });

  server.handle(rejectProposalRpc, async ({ directory, id }) => {
    const [{ proposals }, repoKey] = await Promise.all([runtime, readRepoKey(directory)]);
    if (!repoKey) throw new Error("This folder is not in a git repo, so it has no proposals.");
    await proposals.reject(id, repoKey);
    return { rejected: true as const };
  });

  // Starts a tidy pass and returns at once; its proposals appear in the inbox when it finishes.
  server.handle(tidyMemoryRpc, async ({ directory }, { paseo }) => {
    const [{ capture }, repoKey] = await Promise.all([runtime, readRepoKey(directory)]);
    if (!repoKey) throw new Error("This folder is not in a git repo, so it has no repo memory to tidy.");
    if (capture.isTidying(repoKey)) throw new Error("A tidy of this repo's memory is already running; its proposals will appear here.");
    capture.remember(paseo);
    void capture.tidyNow(repoKey, directory).catch((error: unknown) => console.error(`[memorise] tidy of ${repoKey} failed: ${String(error)}`));
    return { started: true as const };
  });

  return async () => {
    const resolved = await runtime.catch(() => null);
    if (!resolved) return;
    resolved.capture.stop();
    resolved.search?.close();
    const { http } = resolved;
    if (!http) return;
    const closed = new Promise<void>((resolve) => http.close(() => resolve()));
    // close() waits for open connections; agents keep theirs alive between requests.
    http.closeAllConnections();
    await closed;
  };
}
