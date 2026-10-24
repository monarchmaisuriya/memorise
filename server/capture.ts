import { mkdir, readdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { PluginHookAgent } from "@getpaseo/plugin/server";
import { z } from "zod";
import { type FactListItem, type MemorySettings, PROPOSALS_CARD_KIND } from "../shared/memory";
import { checkCitations } from "./citations";
import { buildCapturePrompt, buildTidyPrompt, CAPTURE_OUTPUT_SCHEMA, parseCandidates, parseTidyActions, TIDY_OUTPUT_SCHEMA } from "./extractor";
import type { PaseoApi } from "./paseo-types";
import type { NewProposal, ProposalStore } from "./proposals";
import { type Provider, supportedProvider } from "./providers";
import { readRepoKey } from "./repo-key";
import type { MemoryStore } from "./store";
import { sliceTranscript } from "./transcript";
import { usageOf, type UsageLog } from "./usage";
import { isVisibleToAgents } from "./visibility";
import { extractJson, isWorkerCwd, runWorker, workersDir } from "./workers";

const MINUTE_MS = 60_000;
const WORKER_TIMEOUT_MS = 5 * MINUTE_MS;
const TIMELINE_PAGE = 200;
// At most this many timeline pages are read forward per capture; the transcript keeps the newest.
const MAX_TIMELINE_PAGES = 5;
const TIDY_INTERVAL_MS = 7 * 24 * 60 * MINUTE_MS;
const DAY_MS = 24 * 60 * MINUTE_MS;
const CURSOR_KEEP_MS = 30 * DAY_MS;
const WORKER_ID_KEEP_MS = 10 * MINUTE_MS;

const stateSchema = z.object({
  // Last timeline position captured per agent (a new epoch means the timeline was rebuilt), and when.
  agents: z.record(z.string(), z.object({ epoch: z.string(), seq: z.number(), at: z.string().optional() })).default({}),
  // Background runs today, capture and tidy together, against captureMaxPerDay.
  day: z.object({ date: z.string(), runs: z.number() }).default({ date: "", runs: 0 }),
  // When each repo's tidy was last attempted (successful or not), so a failing one is not retried hourly.
  tidiedAt: z.record(z.string(), z.string()).default({}),
});
type CaptureState = z.infer<typeof stateSchema>;

export interface CaptureDeps {
  root: string;
  store: MemoryStore;
  proposals: ProposalStore;
  usage: UsageLog;
  settings(): Promise<MemorySettings>;
}

// Turns finished sessions into proposals. Off unless captureEnabled; one pass per agent after it has
// been idle for captureIdleMinutes, bounded by captureMaxPerDay. Paseo replays no events, so turns
// that end while the plugin is stopped are not captured.
export class Capture {
  private readonly timers = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly running = new Set<string>();
  private readonly tidying = new Set<string>();
  private readonly workerIds = new Set<string>();
  private swept = false;
  private readonly statePath: string;
  private paseo: PaseoApi | null = null;
  private tidyTimer: ReturnType<typeof setInterval> | null = null;
  private queue: Promise<unknown> = Promise.resolve();

  constructor(private readonly deps: CaptureDeps) {
    this.statePath = join(deps.root, "capture-state.json");
  }

  isWorker(agentId: string, cwd: string): boolean {
    return this.workerIds.has(agentId) || isWorkerCwd(this.deps.root, cwd);
  }

  // Paseo hands the plugin one API object for its whole life; timers reuse the latest one seen. The
  // first time, workers left behind by an earlier run of the plugin (a reload mid-run) are removed.
  remember(paseo: PaseoApi): void {
    this.paseo = paseo;
    if (this.swept) return;
    this.swept = true;
    void this.sweepLeftoverWorkers(paseo).catch((error: unknown) => console.error(`[memorise] could not remove leftover workers: ${String(error)}`));
  }

  private async sweepLeftoverWorkers(paseo: PaseoApi): Promise<void> {
    const { entries } = await paseo.agents.list();
    for (const { agent } of entries) {
      if (isWorkerCwd(this.deps.root, agent.cwd) && !this.workerIds.has(agent.id)) await paseo.agents.ref(agent.id).archive();
    }
    const dir = workersDir(this.deps.root);
    for (const name of await readdir(dir).catch(() => [])) await rm(join(dir, name), { recursive: true, force: true });
  }

  private trackWorker(id: string): void {
    this.workerIds.add(id);
    // Long enough for the worker's last events to arrive after it is archived.
    setTimeout(() => this.workerIds.delete(id), WORKER_ID_KEEP_MS + WORKER_TIMEOUT_MS).unref?.();
  }

  // Takes one background run from today's allowance; false when the daily limit is reached.
  private takeRun(label: string, limit: number): Promise<boolean> {
    return this.serializeState((state) => {
      if (state.day.date !== today()) state.day = { date: today(), runs: 0 };
      if (state.day.runs >= limit) {
        console.log(`[memorise] ${label} skipped: ${state.day.runs} background runs today reached the daily limit`);
        return false;
      }
      state.day.runs += 1;
      return true;
    });
  }

  private saveCursor(agentId: string, cursor: { epoch: string; seq: number }): Promise<void> {
    return this.serializeState((state) => {
      state.agents[agentId] = { ...cursor, at: new Date().toISOString() };
      const cutoff = Date.now() - CURSOR_KEEP_MS;
      for (const [id, entry] of Object.entries(state.agents)) if (entry.at && Date.parse(entry.at) < cutoff) delete state.agents[id];
    });
  }

  // Timeline entries after the saved cursor, paging forward. A rebuilt timeline (new epoch, or a
  // cursor Paseo no longer knows) starts again from the most recent page.
  private async newEntries(paseo: PaseoApi, agentId: string, previous: { epoch: string; seq: number } | undefined) {
    const timeline = paseo.agents.ref(agentId).timeline;
    if (previous) {
      const entries = [];
      let cursor = { epoch: previous.epoch, seq: previous.seq };
      for (let pageNumber = 0; pageNumber < MAX_TIMELINE_PAGES; pageNumber += 1) {
        const page = await timeline.refetch({ direction: "after", cursor, limit: TIMELINE_PAGE, projection: "projected" });
        if (page.epoch !== previous.epoch || page.reset || page.staleCursor) break;
        entries.push(...page.entries.filter((entry) => entry.seqEnd > cursor.seq));
        const end = page.entries.at(-1)?.seqEnd;
        if (!page.hasNewer || end === undefined) return { epoch: page.epoch, entries, end: end ?? cursor.seq };
        cursor = { epoch: page.epoch, seq: end };
      }
      if (entries.length > 0) return { epoch: previous.epoch, entries, end: cursor.seq };
    }
    const tail = await timeline.refetch({ direction: "tail", limit: TIMELINE_PAGE, projection: "projected" });
    return { epoch: tail.epoch, entries: tail.entries, end: tail.entries.at(-1)?.seqEnd ?? 0 };
  }

  private serializeState<T>(operation: (state: CaptureState) => Promise<T> | T): Promise<T> {
    const next = this.queue.then(async () => {
      const state = await this.readState();
      const result = await operation(state);
      await this.writeState(state);
      return result;
    });
    this.queue = next.catch(() => undefined);
    return next;
  }

  private async readState(): Promise<CaptureState> {
    const text = await readFile(this.statePath, "utf8").catch((error: unknown) => {
      if (Reflect.get(Object(error), "code") === "ENOENT") return "{}";
      throw error;
    });
    return stateSchema.parse(JSON.parse(text));
  }

  private async writeState(state: CaptureState): Promise<void> {
    await mkdir(this.deps.root, { recursive: true, mode: 0o700 });
    const temp = `${this.statePath}.tmp`;
    await writeFile(temp, JSON.stringify(state), { mode: 0o600 });
    await rename(temp, this.statePath);
  }

  async runsToday(): Promise<number> {
    const state = await this.readState();
    return state.day.date === today() ? state.day.runs : 0;
  }

  // A new turn means the session is not idle: any pending capture waits for this turn to end.
  onTurnStarted(agentId: string): void {
    clearTimeout(this.timers.get(agentId));
    this.timers.delete(agentId);
  }

  async onTurnEnded(agent: PluginHookAgent, paseo: PaseoApi): Promise<void> {
    this.remember(paseo);
    if (this.isWorker(agent.id, agent.cwd) || !supportedProvider(agent.provider)) return;
    const values = await this.deps.settings();
    if (!values.captureEnabled) return;
    clearTimeout(this.timers.get(agent.id));
    this.timers.set(
      agent.id,
      setTimeout(() => {
        this.timers.delete(agent.id);
        void this.captureNow(agent).catch((error: unknown) => console.error(`[memorise] capture for agent ${agent.id} failed: ${String(error)}`));
      }, values.captureIdleMinutes * MINUTE_MS),
    );
  }

  // One capture pass for one agent. Returns how many proposals it added.
  async captureNow(agent: PluginHookAgent): Promise<number> {
    const paseo = this.paseo;
    if (!paseo || this.running.has(agent.id)) return 0;
    this.running.add(agent.id);
    try {
      const values = await this.deps.settings();
      const provider = values.captureProvider === "session" ? supportedProvider(agent.provider) : values.captureProvider;
      // A model id belongs to one provider, so it applies only when one provider reads every session.
      const model = values.captureProvider === "session" ? "" : values.captureModel;
      if (!values.captureEnabled || !provider) return 0;
      const repoKey = await readRepoKey(agent.cwd).catch(() => null);
      // Captured memories belong to a repo; global memories come only from the user.
      if (!repoKey) return 0;
      const previous = (await this.readState()).agents[agent.id];
      const fresh = await this.newEntries(paseo, agent.id, previous);
      const cursor = { epoch: fresh.epoch, seq: fresh.end };
      const slice = sliceTranscript(fresh.entries.map((entry) => entry.item));
      // Too little new conversation yet: the cursor stays, so later turns add up until there is enough.
      if (slice.userMessages < values.captureMinUserMessages) {
        console.log(`[memorise] capture for agent ${agent.id} waits: ${slice.userMessages} new user message(s) since the last capture, needs ${values.captureMinUserMessages}`);
        return 0;
      }
      // The run counts against the daily limit as soon as it starts (each attempt costs a model call).
      if (!(await this.takeRun(`capture for agent ${agent.id}`, values.captureMaxPerDay))) return 0;
      const facts = await this.deps.store.list(repoKey);
      const current = facts.filter((fact) => fact.status === "active" && !fact.superseded);
      const reply = await runWorker(
        paseo,
        this.deps.root,
        {
          provider,
          model,
          title: "memorise: capture",
          prompt: buildCapturePrompt({ repoKey, transcript: slice.text, existingSubjects: current.map((fact) => fact.subject).slice(0, 100), instructions: values.captureInstructions, exclusions: values.captureExclusions }),
          outputSchema: CAPTURE_OUTPUT_SCHEMA as unknown as Record<string, unknown>,
          timeoutMs: WORKER_TIMEOUT_MS,
        },
        (id) => this.trackWorker(id),
      );
      // A worker that could not run (it throws above) leaves the cursor, so the turns are retried at
      // the next idle. A reply that is not valid will not get better by resending the same turns, so
      // the cursor moves past them.
      let candidates: ReturnType<typeof parseCandidates>;
      try {
        candidates = parseCandidates(extractJson(reply));
      } catch (error) {
        await this.saveCursor(agent.id, cursor);
        console.error(`[memorise] capture for agent ${agent.id}: the worker's reply was not valid (${error instanceof Error ? error.message : String(error)}); these turns are skipped`);
        return 0;
      }
      const added = await this.deps.proposals.add(
        candidates.map(
          (candidate): NewProposal => ({
            repoKey,
            kind: "new",
            targets: [],
            type: candidate.type,
            subject: candidate.subject,
            body: candidate.body,
            paths: candidate.paths,
            reason: "",
            source: { from: "capture", agentId: agent.id, provider, model: model || null },
          }),
        ),
        facts,
      );
      await this.saveCursor(agent.id, cursor);
      if (added.length > 0) {
        // A card in the source agent's chat; the app renders it, the model never sees it.
        await paseo.agents
          .ref(agent.id)
          .timeline.append({ type: "plugin", id: PROPOSALS_CARD_KIND, kind: PROPOSALS_CARD_KIND, version: 1, data: { count: added.length } })
          .catch((error: unknown) => console.error(`[memorise] could not add the proposals card: ${String(error)}`));
      }
      return added.length;
    } finally {
      this.running.delete(agent.id);
    }
  }

  isTidying(repoKey: string): boolean {
    return this.tidying.has(repoKey);
  }

  // One tidy pass over a repo's current facts. Returns how many proposals it added. One pass per
  // repo at a time; the attempt is recorded before it runs and counts against the daily limit.
  async tidyNow(repoKey: string, cwd: string | null): Promise<number> {
    if (this.tidying.has(repoKey)) throw new Error("A tidy of this repo's memory is already running");
    // Marked before the first await, so a second call can never slip in between.
    this.tidying.add(repoKey);
    try {
      const values = await this.deps.settings();
      const facts = (await this.deps.store.list(repoKey)).filter((fact) => fact.scope === "repo" && isVisibleToAgents(fact, 0));
      if (facts.length < 2) return 0;
      const paseo = this.paseo;
      if (!paseo) throw new Error("The plugin has not seen Paseo yet; open an agent and try again");
      await this.serializeState((state) => {
        state.tidiedAt[repoKey] = new Date().toISOString();
      });
      if (!(await this.takeRun(`tidy of ${repoKey}`, values.captureMaxPerDay))) return 0;
      return await this.runTidy(paseo, repoKey, cwd, facts, values);
    } finally {
      this.tidying.delete(repoKey);
    }
  }

  private async runTidy(paseo: PaseoApi, repoKey: string, cwd: string | null, facts: FactListItem[], values: MemorySettings): Promise<number> {
    const notes = cwd ? await checkCitations(cwd, facts, 2_000) : new Map<string, string>();
    const counts = await this.deps.usage.counts();
    const listed = facts.slice(0, 200).map((fact) => {
      const usage = usageOf(counts, fact.id);
      return { fact, note: notes.get(fact.id), shown: usage.shown, readOrFound: usage.read + usage.found };
    });
    const provider: Provider = values.tidyProvider;
    const reply = await runWorker(
      paseo,
      this.deps.root,
      { provider, model: values.tidyModel, title: "memorise: tidy", prompt: buildTidyPrompt(repoKey, listed), outputSchema: TIDY_OUTPUT_SCHEMA as unknown as Record<string, unknown>, timeoutMs: WORKER_TIMEOUT_MS },
      (id) => this.trackWorker(id),
    );
    const byId = new Map(facts.map((fact) => [fact.id, fact]));
    let actions: ReturnType<typeof parseTidyActions>;
    try {
      actions = parseTidyActions(extractJson(reply), new Set(byId.keys()));
    } catch (error) {
      console.error(`[memorise] tidy of ${repoKey}: the worker's reply was not valid (${error instanceof Error ? error.message : String(error)}); nothing proposed`);
      return 0;
    }
    const source = { from: "tidy" as const, agentId: null, provider, model: values.tidyModel || null };
    const proposals = actions.map((action): NewProposal => {
      if (action.action === "merge") return { repoKey, kind: "merge", targets: action.ids, type: action.type, subject: action.subject, body: action.body, paths: [], reason: action.reason, source };
      const target = byId.get(action.id);
      if (!target) throw new Error(`tidy named unknown fact ${action.id}`);
      if (action.action === "replace") return { repoKey, kind: "replace", targets: [action.id], type: target.type, subject: action.subject, body: action.body, paths: target.paths, reason: action.reason, source };
      return { repoKey, kind: "retire", targets: [action.id], type: target.type, subject: target.subject, body: target.body, paths: target.paths, reason: action.reason, source };
    });
    const added = await this.deps.proposals.add(proposals, await this.deps.store.list(repoKey));
    return added.length;
  }

  // With tidyWeekly on, each repo with memories is tidied at most once a week (checked hourly).
  startWeeklyTidy(repoKeys: () => Promise<string[]>): void {
    this.tidyTimer = setInterval(() => {
      void (async () => {
        if (!(await this.deps.settings()).tidyWeekly) return;
        const state = await this.readState();
        for (const repoKey of await repoKeys()) {
          const last = state.tidiedAt[repoKey];
          if (last && Date.now() - Date.parse(last) < TIDY_INTERVAL_MS) continue;
          await this.tidyNow(repoKey, null).catch((error: unknown) => console.error(`[memorise] weekly tidy of ${repoKey} failed: ${String(error)}`));
        }
      })();
    }, 60 * MINUTE_MS);
  }

  stop(): void {
    for (const timer of this.timers.values()) clearTimeout(timer);
    this.timers.clear();
    if (this.tidyTimer) clearInterval(this.tidyTimer);
  }
}

function today(): string {
  return new Date().toISOString().slice(0, 10);
}
