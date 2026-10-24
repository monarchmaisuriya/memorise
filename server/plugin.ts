import type { Server } from "node:http";
import type { PluginServerContext } from "@getpaseo/plugin/server";
import {
  approveProposalRpc,
  type BulkAction,
  getRepoPrefsRpc,
  bulkMemoryRpc,
  deleteMemoryRpc,
  exportMemoryRpc,
  importMemoryRpc,
  listMemoriesRpc,
  isFolderKey,
  listProposalsRpc,
  listReposRpc,
  MAX_BULK_IDS,
  memoryHistoryRpc,
  memorySettings,
  type MemorySettings,
  type MemoryType,
  moveMemoryRpc,
  pinMemoryRpc,
  previewMemoryRpc,
  proposalsSummaryRpc,
  rejectProposalRpc,
  restoreMemoryRpc,
  retireMemoryRpc,
  revertMemoryRpc,
  saveMemoryRpc,
  scanProjectRpc,
  searchMemoriesRpc,
  setRepoPrefsRpc,
  tidyMemoryRpc,
  updateMemoryRpc,
  type Where,
} from "../shared/memory";
import { Capture } from "./capture";
import { checkCitations } from "./citations";
import { buildMemorySection, INDEX_MAX_BYTES, withMemorySection, withoutMemorySection } from "./index-prompt";
import { MemoryMcp, mcpServerEntries, READ_SERVER, WRITE_SERVER } from "./mcp";
import { loadTokenSecret, TokenAuthority } from "./mcp-auth";
import { ProposalStore } from "./proposals";
import type { PaseoApi } from "./paseo-types";
import { supportedProvider } from "./providers";
import { readRepoKey } from "./repo-key";
import { RepoPrefs } from "./repo-prefs";
import { SearchIndex } from "./search-index";
import { assertNoSecret } from "./secrets";
import { MemoryStore } from "./store";
import { formatExport, importKey, parseImport } from "./transfer";
import { UsageLog, usageOf } from "./usage";
import { isVisibleToAgents, orderForAgents, rankWithReasons } from "./visibility";
import { PathMatcher, workFiles } from "./work-files";
import { openRepoCheckouts } from "./workspaces";
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
  repoPrefs: RepoPrefs;
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
    const repoPrefs = new RepoPrefs(root);
    const capture = new Capture({ root, store, proposals, usage, repoPrefs, settings: currentSettings });
    capture.startWeeklyTidy(() => store.repoKeys());
    capture.startProjectScans();
    const { mcpPort } = await currentSettings();
    const mcp = new MemoryMcp({
      store,
      tokens,
      search,
      searchProblem,
      usage,
      expiryDays: async () => (await currentSettings()).expiryDays,
      includeGlobal: async (repoKey) => (await repoPrefs.get(repoKey)).includeGlobal,
    });
    const base = { root, store, tokens, search, usage, proposals, repoPrefs, capture, port: mcpPort };
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

  // What a new agent in `cwd` gets, built the same way for the create hook and the preview. `off`
  // when the repo has memory turned off.
  async function prepareMemory(cwd: string, values: MemorySettings) {
    const { store, repoPrefs, mcpProblem } = await runtime;
    const problems: string[] = mcpProblem ? [mcpProblem] : [];
    const repoKey = await readRepoKey(cwd).catch((error: unknown) => {
      problems.push(`repo memory is unavailable for this session (${String(error)})`);
      console.error(`[memorise] repo key for ${cwd} failed: ${String(error)}`);
      return null;
    });
    const prefs = repoKey ? await repoPrefs.get(repoKey) : null;
    if (prefs && !prefs.enabled) return { off: true as const, repoKey };
    // A folder outside git has no history, so no files are known to be changed.
    const changed = repoKey && !isFolderKey(repoKey)
      ? await workFiles(cwd).catch((error: unknown) => {
          console.error(`[memorise] changed files for ${cwd} unavailable: ${String(error)}`);
          return [];
        })
      : [];
    const paths = new PathMatcher(changed, PATH_MATCH_BUDGET_MS);
    const reachable = (await store.list(repoKey)).filter((fact) => (prefs?.includeGlobal ?? true) || fact.scope === "repo");
    const ranked = rankWithReasons(reachable.filter((fact) => isVisibleToAgents(fact, values.expiryDays)), paths);
    if (paths.skipped) problems.push("ranking by changed files was cut short (time budget); some memories about those files may be listed lower");
    const visible = ranked.map(({ fact }) => fact);
    const notes = repoKey ? await checkCitations(cwd, visible.filter((fact) => fact.scope === "repo"), CITATION_BUDGET_MS) : new Map<string, string>();
    const section = buildMemorySection({ repoKey, facts: visible, notes, maxLines: values.indexMaxLines, toolsAvailable: mcpProblem === null, problems });
    return { off: false as const, repoKey, section, ranked };
  }

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
      const { root, tokens, usage, capture, port, mcpProblem } = await runtime;
      capture.remember(paseo);
      // The plugin's own capture and tidy workers get no memory and no memory tools.
      if (isWorkerRequest(root, config.cwd, request.env)) return { ...request, config: stripped };
      const prepared = await prepareMemory(config.cwd, values);
      if (prepared.off) return { ...request, config: stripped };
      const { repoKey, section } = prepared;
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

  // A new workspace's project is scanned when automatic project scans are on and it is due.
  server.on("workspace.created", async ({ workspace }, { paseo }) => {
    const { capture } = await runtime;
    capture.remember(paseo);
    const repoKey = await readRepoKey(workspace.cwd);
    await capture.scanIfDue(repoKey, workspace.cwd).catch((error: unknown) => console.error(`[memorise] automatic project scan of ${repoKey} failed: ${error instanceof Error ? error.message : String(error)}`));
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
    if (scope === "repo" && !repoKey) throw new Error("No repo was chosen; save the memory as global instead.");
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

  server.handle(previewMemoryRpc, async ({ directory }) => {
    const values = await currentSettings();
    const prepared = await prepareMemory(directory, values);
    const limits = { maxLines: values.indexMaxLines, maxBytes: INDEX_MAX_BYTES };
    if (prepared.off) return { repoKey: prepared.repoKey, off: true, text: "", bytes: 0, ...limits, listed: [] };
    const shown = new Set(prepared.section.shownIds);
    const listed = prepared.ranked
      .filter(({ fact }) => shown.has(fact.id))
      .map(({ fact, reason }) => ({ id: fact.id, subject: fact.subject, reason, titleOnly: fact.activation === "title" && !fact.pinned }));
    return { repoKey: prepared.repoKey, off: false, text: prepared.section.text, bytes: Buffer.byteLength(prepared.section.text), ...limits, listed };
  });

  server.handle(exportMemoryRpc, async ({ where, format }) => {
    const [{ store }, repoKey] = await Promise.all([runtime, repoKeyOf(where)]);
    const scope = repoKey ? "repo" : "global";
    const facts = (await store.list(repoKey)).filter((fact) => fact.scope === scope && fact.status === "active" && !fact.superseded).sort((a, b) => a.created.localeCompare(b.created) || a.id.localeCompare(b.id));
    return { text: formatExport(facts, format, repoKey), count: facts.length };
  });

  // Imported memories are the user's own. Duplicates of current memories in the target scope, and
  // repeats within the same import, are skipped and named.
  server.handle(importMemoryRpc, async ({ where, scope, text, dryRun }) => {
    const [{ store }, repoKey] = await Promise.all([runtime, repoKeyOf(where)]);
    if (scope === "repo" && !repoKey) throw new Error("No repo was chosen; import the memories as global instead.");
    const { entries, skipped } = parseImport(text);
    const saved = new Set((await store.list(repoKey)).filter((fact) => fact.scope === scope && !fact.superseded).map((fact) => importKey(fact.subject, fact.body)));
    const seen = new Set<string>();
    const added: { type: MemoryType; subject: string }[] = [];
    for (const entry of entries) {
      const key = importKey(entry.subject, entry.body);
      if (saved.has(key) || seen.has(key)) {
        skipped.push({ line: entry.subject, reason: saved.has(key) ? "already saved" : "repeated in this import" });
        continue;
      }
      seen.add(key);
      added.push({ type: entry.type, subject: entry.subject });
      if (!dryRun) await store.create({ ...entry, scope, repoKey: scope === "repo" ? repoKey : null, supersedes: null, source: BY_USER, citations: [] });
    }
    return { added, skipped };
  });

  server.handle(getRepoPrefsRpc, async ({ repoKey }) => ({ prefs: await (await runtime).repoPrefs.get(repoKey) }));

  server.handle(setRepoPrefsRpc, async ({ repoKey, prefs }) => ({ prefs: await (await runtime).repoPrefs.set(repoKey, prefs) }));

  // Every repo the manager can work on: those with memories (with counts), those with an open Paseo
  // workspace, and those with proposals waiting. Global comes first, then repos by key.
  server.handle(listReposRpc, async (_input, { paseo }) => {
    const { store, proposals } = await runtime;
    const [withMemories, open, waiting] = await Promise.all([store.summaries(), openRepoCheckouts(paseo), proposals.summary()]);
    const known = new Set(withMemories.map((repo) => repo.repoKey));
    const others = [...new Set([...open.keys(), ...waiting.map((repo) => repo.repoKey)])].filter((repoKey) => !known.has(repoKey));
    const repos = [...withMemories, ...others.map((repoKey) => ({ repoKey, active: 0, retired: 0, lastModified: null }))];
    return { repos: repos.sort((a, b) => (a.repoKey === null ? -1 : b.repoKey === null ? 1 : a.repoKey.localeCompare(b.repoKey))) };
  });

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

  server.handle(listProposalsRpc, async ({ where }) => {
    const [{ store, proposals, capture }, repoKey] = await Promise.all([runtime, repoKeyOf(where)]);
    if (!repoKey) return { repoKey, proposals: [], captureRunsToday: await capture.runsToday(), lastRun: null };
    const facts = new Map((await store.list(repoKey)).map((fact) => [fact.id, fact]));
    const pending = (await proposals.list(repoKey)).map((proposal) => ({
      ...proposal,
      targetFacts: proposal.targets.flatMap((id) => {
        const fact = facts.get(id);
        return fact ? [{ id, subject: fact.subject, body: fact.body }] : [];
      }),
    }));
    return { repoKey, proposals: pending, captureRunsToday: await capture.runsToday(), lastRun: capture.lastRun(repoKey) };
  });

  server.handle(approveProposalRpc, async ({ where, id, subject, body, paths }) => {
    const [{ store, proposals }, repoKey] = await Promise.all([runtime, repoKeyOf(where)]);
    if (!repoKey) throw new Error("Proposals belong to a repo; choose one.");
    await proposals.approve(id, repoKey, store, { subject, body, paths });
    return { approved: true as const };
  });

  server.handle(rejectProposalRpc, async ({ where, id }) => {
    const [{ proposals }, repoKey] = await Promise.all([runtime, repoKeyOf(where)]);
    if (!repoKey) throw new Error("Proposals belong to a repo; choose one.");
    await proposals.reject(id, repoKey);
    return { rejected: true as const };
  });

  server.handle(proposalsSummaryRpc, async () => ({ repos: await (await runtime).proposals.summary() }));

  // A checkout to read for a project scan: the given workspace folder, or the folder of an open
  // workspace that belongs to the repo.
  async function checkoutFor(where: Where, paseo: PaseoApi): Promise<{ repoKey: string; folder: string }> {
    if ("directory" in where) {
      return { repoKey: await readRepoKey(where.directory), folder: where.directory };
    }
    if (!where.repoKey) throw new Error("A project scan reads one repo; choose a repo.");
    const folder = (await openRepoCheckouts(paseo)).get(where.repoKey);
    if (folder) return { repoKey: where.repoKey, folder };
    throw new Error(`Open a workspace of ${where.repoKey} in Paseo first; a project scan reads that checkout's files.`);
  }

  // Starts a project scan and returns at once; its proposals appear in the inbox when it finishes.
  server.handle(scanProjectRpc, async ({ where, mode }, { paseo }) => {
    const { capture } = await runtime;
    capture.remember(paseo);
    const { repoKey, folder } = await checkoutFor(where, paseo);
    if (capture.isScanning(repoKey)) throw new Error("A project scan of this repo is already running; its proposals will appear here.");
    const { done } = await capture.startScan(repoKey, folder, mode);
    void done.catch((error: unknown) => console.error(`[memorise] project scan of ${repoKey} failed: ${error instanceof Error ? error.message : String(error)}`));
    return { started: true as const, folder };
  });

  // Starts a tidy pass and returns at once; its proposals appear in the inbox when it finishes. With a
  // workspace folder, tidy also checks citations against that checkout.
  server.handle(tidyMemoryRpc, async ({ where }, { paseo }) => {
    const [{ capture }, repoKey] = await Promise.all([runtime, repoKeyOf(where)]);
    if (!repoKey) throw new Error("Tidy works on one repo's memory; choose a repo.");
    const directory = "directory" in where ? where.directory : null;
    if (capture.isTidying(repoKey)) throw new Error("A tidy of this repo's memory is already running; its proposals will appear here.");
    capture.remember(paseo);
    const { done } = await capture.startTidy(repoKey, directory);
    void done.catch((error: unknown) => console.error(`[memorise] tidy of ${repoKey} failed: ${error instanceof Error ? error.message : String(error)}`));
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
