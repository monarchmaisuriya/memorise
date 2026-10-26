import { describe, expect, it } from "vitest";
import { ACTIVATION, count, errorText, KIND, lengthNote, projectDetail, projectName, providerName, receiptText, relativeDate, shortDate, usageText } from "./copy";

// An RPC error as Paseo's client builds it: the handler's text, then requestType= and code=.
function rpcError(text: string, requestType: string, code: string): Error {
  return Object.assign(new Error(`${text} requestType=${requestType} code=${code}`), { requestType, code });
}

describe("error text", () => {
  it("shows a handler's own message without Paseo's request tail or prefix", () => {
    const error = rpcError("Request failed: Clean up needs at least 2 memories", "plugin.rpc.invoke.request", "handler_error");
    expect(errorText(error)).toBe("Clean up needs at least 2 memories");
  });

  it("keeps the prefix of an error that is not a handler error, and leaves other errors as they are", () => {
    expect(errorText(rpcError("Request failed: timed out", "plugin.rpc.invoke.request", "timeout"))).toBe("Request failed: timed out");
    expect(errorText(new Error("Disk full requestType=x"))).toBe("Disk full requestType=x");
    expect(errorText("plain text")).toBe("plain text");
  });

  it("turns validation issues into sentences that name the field, never JSON", () => {
    const issues = [
      { origin: "string", code: "too_big", maximum: 1000, inclusive: true, path: ["body"], message: "Too big: expected string to have <=1000 characters" },
      { origin: "string", code: "too_small", minimum: 1, inclusive: true, path: ["subject"], message: "Too small: expected string to have >=1 characters" },
      { code: "custom", path: ["body"], message: "A memory cannot contain a <memorise> tag" },
      { code: "invalid_format", format: "date", path: ["until"], message: "Invalid ISO date" },
    ];
    const zodError = Object.assign(new Error(JSON.stringify(issues, null, 2)), { name: "ZodError", issues });
    expect(errorText(zodError)).toBe("Memory must be 1,000 characters or less. Enter a title. Memory: A memory cannot contain a <memorise> tag. Expires on must be a date like 2026-12-31.");
    expect(errorText(rpcError(`Request failed: ${JSON.stringify(issues.slice(0, 1))}`, "plugin.rpc.invoke.request", "handler_error"))).toBe("Memory must be 1,000 characters or less.");
  });
});

describe("dates and counts", () => {
  const now = new Date(2026, 9, 25, 15, 0);
  it("says today, yesterday, or how many days ago within 30 days, and a short date after that", () => {
    expect(relativeDate(new Date(2026, 9, 25, 9, 0).toISOString(), now)).toBe("today");
    expect(relativeDate(new Date(2026, 9, 24, 23, 0).toISOString(), now)).toBe("yesterday");
    expect(relativeDate(new Date(2026, 9, 22, 12, 0).toISOString(), now)).toBe("3 days ago");
    expect(relativeDate(new Date(2026, 8, 1, 12, 0).toISOString(), now)).toBe("on 1 Sep");
    expect(relativeDate(new Date(2025, 11, 31, 12, 0).toISOString(), now)).toBe("on 31 Dec 2025");
  });

  it("writes a calendar date as a short date, with the year only when it is not this year", () => {
    expect(shortDate("2026-11-30", now)).toBe("30 Nov");
    expect(shortDate("2027-01-31", now)).toBe("31 Jan 2027");
  });

  it("counts with the right word", () => {
    expect(count(1, "memory", "memories")).toBe("1 memory");
    expect(count(12, "memory", "memories")).toBe("12 memories");
    expect(count(0, "memory", "memories")).toBe("0 memories");
  });
});

describe("providers", () => {
  it("writes provider ids as people write them", () => {
    expect([providerName("claude"), providerName("codex"), providerName("opencode"), providerName("other"), providerName(null)]).toEqual(["Claude", "Codex", "OpenCode", "other", "an agent"]);
  });
});

describe("usage", () => {
  it("says a memory was not used yet, or how agents used it in a sentence", () => {
    expect(usageText({ shown: 0, read: 0, found: 0 })).toBe("Not used yet");
    expect(usageText({ shown: 3, read: 1, found: 0 })).toBe("Shown to agents 3 times, opened once");
    expect(usageText({ shown: 0, read: 0, found: 2 })).toBe("Found by search 2 times");
  });
});

describe("memory receipts", () => {
  it("says how many memories an agent was given, and how it used them", () => {
    expect(receiptText({ listed: 12, opened: 0, searched: 0, saved: 0, archived: 0, other: 0 })).toBe("12 memories in this agent's prompt · not used yet");
    expect(receiptText({ listed: 1, opened: 2, searched: 1, saved: 1, archived: 0, other: 0 })).toBe("1 memory in this agent's prompt · opened 2, searched 1, saved 1");
    expect(receiptText({ listed: 0, opened: 0, searched: 0, saved: 0, archived: 1, other: 2 })).toBe("0 memories in this agent's prompt · archived 1, used the memory tools 2 times");
  });
});

describe("project names", () => {
  it("names a project by its repo name, a folder by its label or name, and keeps the full key as detail", () => {
    expect(projectName("github.com/pushowl/pushowl-mcp")).toBe("pushowl-mcp");
    expect(projectName("folder/trip-notes-0123456789ab")).toBe("trip-notes");
    expect(projectName("folder/trip-notes-0123456789ab", "Trip Notes")).toBe("Trip Notes");
    expect(projectName("local/0123456789abcdef")).toBe("Repo without a remote (012345)");
    expect(projectName(null)).toBe("Global");
    expect(projectDetail("github.com/pushowl/pushowl-mcp")).toBe("github.com/pushowl/pushowl-mcp");
    expect(projectDetail(null)).toBe("For every project");
  });
});

describe("glossary", () => {
  it("names every kind and every activation in everyday words", () => {
    expect(KIND).toEqual({ preference: "Preference", decision: "Decision", gotcha: "Gotcha", howto: "How-to", reference: "Reference" });
    expect(Object.fromEntries(Object.entries(ACTIVATION).map(([key, { label }]) => [key, label]))).toEqual({
      listed: "Always",
      files: "When matching files change",
      title: "Title only",
      manual: "Only when searched",
    });
  });
});

describe("length notes", () => {
  it("counts down to the limit, warns about long memories, and says how many are too many", () => {
    expect(lengthNote(12, 1_000, "body")).toEqual({ text: "988 characters left", tone: "muted" });
    expect(lengthNote(1_500, 5_000, "body")).toEqual({ text: "3,500 characters left. Long memories use more context each time an agent opens or finds them.", tone: "muted" });
    expect(lengthNote(1_234, 1_000, "body")).toEqual({ text: "234 characters too many", tone: "danger" });
    expect(lengthNote(999, 1_000, "body")).toEqual({ text: "1 character left", tone: "muted" });
  });

  it("shows a title count only near its limit", () => {
    expect(lengthNote(30, 80, "title")).toBeNull();
    expect(lengthNote(70, 80, "title")).toEqual({ text: "10 characters left", tone: "muted" });
    expect(lengthNote(81, 80, "title")).toEqual({ text: "1 character too many", tone: "danger" });
  });
});
