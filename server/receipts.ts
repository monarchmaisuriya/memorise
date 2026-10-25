import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { z } from "zod";
import { type MemoryUse, memoryUseSchema, type Receipt, receiptSchema } from "../shared/memory";
import type { AgentTimelineItem } from "./paseo-types";
import type { TimelineCursor } from "./timeline";

const KEEP_MS = 30 * 24 * 60 * 60 * 1000;
const NO_USE: MemoryUse = { opened: 0, searched: 0, saved: 0, archived: 0, other: 0 };
const TOOL = /(?:^|[^a-z])memory_(search|read|write|update|retire)(?![a-z_])/;
const SERVER = /paseo-memorise/;
const GROUP: Record<string, keyof MemoryUse> = { read: "opened", search: "searched", write: "saved", update: "saved", retire: "archived" };

// How a turn used the memory tools. A call is recognised by its name or by the tool and server its
// detail names, never by other text (a shell command that mentions memory_read is not a call).
// Providers name the same call differently ("mcp__paseo-memorise__memory_read",
// "paseo-memorise.memory_read", or only the server), so all of these are read. Failed and
// canceled calls do not count.
export function memoryToolUse(items: readonly AgentTimelineItem[]): MemoryUse {
  const use = { ...NO_USE };
  for (const item of items) {
    if (item.type !== "tool_call" || item.status === "failed" || item.status === "canceled") continue;
    const detail = (item.detail ?? {}) as Record<string, unknown>;
    const names = [item.name, detail.tool, detail.server, detail.name].filter((value): value is string => typeof value === "string");
    const tool = names.map((name) => TOOL.exec(name)?.[1]).find((match) => match !== undefined);
    if (tool) use[GROUP[tool]] += 1;
    else if (names.some((name) => SERVER.test(name))) use.other += 1;
  }
  return use;
}

// `cursor` is the timeline position counted up to; receipts saved before it existed have none.
const entrySchema = receiptSchema.extend({ at: z.string(), cursor: z.object({ epoch: z.string(), seq: z.number().int().nonnegative() }).optional() });
const fileSchema = z.object({ version: z.literal(1), agents: z.record(z.string(), entrySchema) });
type Entry = z.infer<typeof entrySchema>;

// Each agent's receipt, kept in receipts.json so totals survive a plugin restart. Entries not
// touched for 30 days are dropped.
export class Receipts {
  private readonly file: string;
  private queue: Promise<unknown> = Promise.resolve();

  constructor(root: string) {
    this.file = join(root, "receipts.json");
  }

  async start(agentId: string, listed: number, cursor: TimelineCursor): Promise<Receipt> {
    const started = await this.change((agents) => {
      agents[agentId] = { listed, ...NO_USE, at: new Date().toISOString(), cursor };
      return agents[agentId];
    });
    if (!started) throw new Error(`The receipt for agent ${agentId} was not saved`);
    return started;
  }

  // Where an agent's counting stopped: null for an agent that has no receipt, undefined for a receipt
  // saved before positions were kept.
  async cursor(agentId: string): Promise<TimelineCursor | undefined | null> {
    await this.queue;
    const agents = await this.read();
    return agentId in agents ? agents[agentId].cursor : null;
  }

  // Adds a turn's use to an agent's totals and saves the position counted up to, in one write; null
  // for an agent that has no receipt.
  add(agentId: string, use: MemoryUse, cursor: TimelineCursor): Promise<Receipt | null> {
    return this.change((agents) => {
      const entry = agents[agentId];
      if (!entry) return null;
      const next = memoryUseSchema.parse(Object.fromEntries(Object.keys(NO_USE).map((key) => [key, entry[key as keyof MemoryUse] + use[key as keyof MemoryUse]])));
      agents[agentId] = { listed: entry.listed, ...next, at: new Date().toISOString(), cursor };
      return agents[agentId];
    });
  }

  private async read(): Promise<Record<string, Entry>> {
    const text = await readFile(this.file, "utf8").catch((error: unknown) => {
      if (Reflect.get(Object(error), "code") === "ENOENT") return null;
      throw error;
    });
    return text === null ? {} : fileSchema.parse(JSON.parse(text)).agents;
  }

  private change<T extends Entry | null>(edit: (agents: Record<string, Entry>) => T): Promise<Receipt | null> {
    const next = this.queue.then(async () => {
      const agents = await this.read();
      const cutoff = Date.now() - KEEP_MS;
      for (const [id, entry] of Object.entries(agents)) if (Date.parse(entry.at) < cutoff) delete agents[id];
      const result = edit(agents);
      await mkdir(dirname(this.file), { recursive: true });
      const temporary = `${this.file}.${process.pid}.tmp`;
      await writeFile(temporary, `${JSON.stringify({ version: 1, agents }, null, 2)}\n`, { mode: 0o600 });
      await rename(temporary, this.file);
      if (!result) return null;
      const { at: _at, cursor: _cursor, ...receipt } = result;
      return receipt;
    });
    this.queue = next.catch(() => undefined);
    return next;
  }
}
