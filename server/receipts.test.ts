import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { AgentTimelineItem } from "./paseo-types";
import { memoryToolUse, Receipts } from "./receipts";
import { tempDir } from "./test-temp-dir";

function call(name: string, detail: Record<string, unknown> = { type: "unknown" }, status = "completed"): AgentTimelineItem {
  return { type: "tool_call", callId: name, name, detail, status, error: null } as unknown as AgentTimelineItem;
}

describe("memory tool use in a turn", () => {
  it("counts memory tool calls however the provider names them, and nothing else", () => {
    const items = [
      call("mcp__paseo-memorise__memory_read"),
      call("paseo-memorise.memory_read"),
      call("memory_search"),
      call("mcp__paseo-memorise-write__memory_write"),
      call("paseo-memorise-write.memory_update"),
      call("mcp__paseo-memorise-write__memory_retire"),
      call("paseo-memorise", { type: "unknown", server: "paseo-memorise" }),
      call("tool", { type: "mcp", server: "paseo-memorise", tool: "memory_read" }),
      call("Bash", { type: "shell", command: "echo memory_read" }),
      call("mcp__paseo-memorise__memory_read", { type: "unknown" }, "failed"),
      { type: "assistant_message", text: "I used memory_read" } as unknown as AgentTimelineItem,
    ];
    expect(memoryToolUse(items)).toEqual({ opened: 3, searched: 1, saved: 2, archived: 1, other: 1 });
  });
});

describe("receipts store", () => {
  it("keeps each agent's listed count and running totals across restarts", async () => {
    const root = tempDir("receipts-");
    const receipts = new Receipts(root);
    expect(await receipts.start("agent-1", 12)).toEqual({ listed: 12, opened: 0, searched: 0, saved: 0, archived: 0, other: 0 });
    await receipts.add("agent-1", { opened: 2, searched: 1, saved: 0, archived: 0, other: 0 });
    expect(await new Receipts(root).add("agent-1", { opened: 1, searched: 0, saved: 1, archived: 0, other: 0 })).toEqual({ listed: 12, opened: 3, searched: 1, saved: 1, archived: 0, other: 0 });
    expect(await receipts.add("unknown-agent", { opened: 1, searched: 0, saved: 0, archived: 0, other: 0 })).toBeNull();
    const saved = JSON.parse(await readFile(join(root, "receipts.json"), "utf8"));
    expect(Object.keys(saved.agents)).toEqual(["agent-1"]);
  });
});
