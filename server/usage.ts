import { appendFile, readFile, rename, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";

// How often each fact reaches agents. "shown": listed in a new agent's index. "read": opened with
// memory_read. "found": returned by memory_search. Ids only; never fact text.
export type UsageKind = "shown" | "read" | "found";

export interface FactUsage {
  shown: number;
  read: number;
  found: number;
  lastShown: string | null;
}

const COMPACT_AT_BYTES = 2 * 1024 * 1024;
const eventSchema = z.object({ time: z.string(), kind: z.enum(["shown", "read", "found"]), ids: z.array(z.string()) });
const summarySchema = z.record(z.string(), z.object({ shown: z.number(), read: z.number(), found: z.number(), lastShown: z.string().nullable() }));

function empty(): FactUsage {
  return { shown: 0, read: 0, found: 0, lastShown: null };
}

export class UsageLog {
  private readonly eventsPath: string;
  private readonly summaryPath: string;
  private queue: Promise<unknown> = Promise.resolve();

  constructor(
    root: string,
    private readonly compactAtBytes = COMPACT_AT_BYTES,
  ) {
    this.eventsPath = join(root, "usage.jsonl");
    this.summaryPath = join(root, "usage-summary.json");
  }

  private serialize<T>(operation: () => Promise<T>): Promise<T> {
    const next = this.queue.then(operation, operation);
    this.queue = next.catch(() => undefined);
    return next;
  }

  record(kind: UsageKind, ids: readonly string[]): Promise<void> {
    if (ids.length === 0) return Promise.resolve();
    return this.serialize(async () => {
      // Each record starts on a new line, so a line left half-written by a crash cannot swallow it.
      await appendFile(this.eventsPath, `\n${JSON.stringify({ time: new Date().toISOString(), kind, ids })}\n`, { mode: 0o600 });
      const size = (await stat(this.eventsPath)).size;
      if (size > this.compactAtBytes) await this.compact();
    });
  }

  private async readSummary(): Promise<Record<string, FactUsage>> {
    const text = await readFile(this.summaryPath, "utf8").catch((error: unknown) => {
      if (Reflect.get(Object(error), "code") === "ENOENT") return "{}";
      throw error;
    });
    return summarySchema.parse(JSON.parse(text));
  }

  private async readEvents(): Promise<z.infer<typeof eventSchema>[]> {
    const text = await readFile(this.eventsPath, "utf8").catch((error: unknown) => {
      if (Reflect.get(Object(error), "code") === "ENOENT") return "";
      throw error;
    });
    const events: z.infer<typeof eventSchema>[] = [];
    for (const line of text.split("\n")) {
      if (line.trim() === "") continue;
      // A line cut short by a crash mid-append is skipped, not allowed to break every count.
      let value: unknown;
      try {
        value = JSON.parse(line);
      } catch {
        continue;
      }
      const parsed = eventSchema.safeParse(value);
      if (parsed.success) events.push(parsed.data);
    }
    return events;
  }

  private static fold(summary: Record<string, FactUsage>, events: readonly z.infer<typeof eventSchema>[]): Record<string, FactUsage> {
    const totals = structuredClone(summary);
    for (const event of events) {
      for (const id of event.ids) {
        const usage = (totals[id] ??= empty());
        usage[event.kind] += 1;
        if (event.kind === "shown" && (usage.lastShown === null || event.time > usage.lastShown)) usage.lastShown = event.time;
      }
    }
    return totals;
  }

  // Folds the event log into the summary so the log stays small.
  private async compact(): Promise<void> {
    const totals = UsageLog.fold(await this.readSummary(), await this.readEvents());
    const temp = `${this.summaryPath}.tmp`;
    await writeFile(temp, JSON.stringify(totals), { mode: 0o600 });
    await rename(temp, this.summaryPath);
    await writeFile(this.eventsPath, "", { mode: 0o600 });
  }

  counts(): Promise<Record<string, FactUsage>> {
    return this.serialize(async () => UsageLog.fold(await this.readSummary(), await this.readEvents()));
  }
}

export function usageOf(counts: Record<string, FactUsage>, id: string): FactUsage {
  return counts[id] ?? empty();
}
