import { describe, expect, it } from "vitest";
import { ACTIVATION, count, errorText, KIND, projectDetail, projectName, providerName, relativeDate, shortDate, usageText } from "./copy";

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
