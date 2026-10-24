import { describe, expect, it } from "vitest";
import { activeFilters, applyFilters, attentionGroups, DEFAULT_FILTERS, type ListedFact } from "./manager-view";

const DAY = 24 * 60 * 60 * 1000;
const NOW = Date.parse("2026-10-24T12:00:00Z");

let next = 10;
function fact(overrides: Partial<ListedFact> = {}): ListedFact {
  const created = new Date(NOW - 30 * DAY).toISOString();
  next += 1;
  return {
    id: `01JB8Z6X3T5Q9V2M4N7P8R1S${next}`,
    scope: "repo",
    repoKey: "github.com/acme/api",
    type: "howto",
    subject: "s",
    body: "b",
    status: "active",
    pinned: false,
    paths: [],
    activation: "listed",
    enabled: true,
    until: null,
    supersedes: null,
    created,
    modified: created,
    lastUsed: created,
    source: { by: "user", provider: null, branch: null, commit: null },
    citations: [],
    superseded: false,
    visibleToAgents: true,
    usage: { shown: 0, read: 0, found: 0, lastShown: null },
    ...overrides,
  };
}

describe("manager filters", () => {
  it("names only the filters that differ from the defaults", () => {
    expect(activeFilters(DEFAULT_FILTERS)).toEqual([]);
    expect(activeFilters({ ...DEFAULT_FILTERS, type: "gotcha", control: "off" }).map((filter) => filter.label)).toEqual(["gotcha", "off for agents"]);
  });

  it("keeps the chosen scope and status, then sorts", () => {
    const old = fact({ id: "01JB8Z6X3T5Q9V2M4N7P8R1S01", subject: "old", modified: "2026-10-01T00:00:00.000Z" });
    const recent = fact({ id: "01JB8Z6X3T5Q9V2M4N7P8R1S02", subject: "recent", modified: "2026-10-20T00:00:00.000Z" });
    const global = fact({ id: "01JB8Z6X3T5Q9V2M4N7P8R1S03", scope: "global", repoKey: null, subject: "global" });
    const retired = fact({ id: "01JB8Z6X3T5Q9V2M4N7P8R1S04", status: "retired", subject: "retired" });
    expect(applyFilters([old, global, retired, recent], DEFAULT_FILTERS, "repo", null, NOW).map((item) => item.subject)).toEqual(["recent", "old"]);
    expect(applyFilters([old, retired], { ...DEFAULT_FILTERS, status: "retired" }, "repo", null, NOW).map((item) => item.subject)).toEqual(["retired"]);
  });

  it("orders by search rank when a search ran, ignoring the sort", () => {
    const a = fact({ id: "01JB8Z6X3T5Q9V2M4N7P8R1S0A", subject: "a" });
    const b = fact({ id: "01JB8Z6X3T5Q9V2M4N7P8R1S0B", subject: "b" });
    const c = fact({ id: "01JB8Z6X3T5Q9V2M4N7P8R1S0C", subject: "c" });
    expect(applyFilters([a, b, c], DEFAULT_FILTERS, "repo", [c.id, a.id], NOW).map((item) => item.subject)).toEqual(["c", "a"]);
  });
});

describe("needs attention", () => {
  it("groups current memories by the first reason that applies, and leaves the rest out", () => {
    const off = fact({ subject: "off", enabled: false });
    const ended = fact({ subject: "ended", until: "2026-10-01" });
    const hidden = fact({ subject: "hidden", visibleToAgents: false, source: { by: "agent", provider: "codex", branch: null, commit: null } });
    const unused = fact({ subject: "unused" });
    const fresh = fact({ subject: "fresh", created: new Date(NOW - 3 * DAY).toISOString() });
    const used = fact({ subject: "used", usage: { shown: 4, read: 0, found: 0, lastShown: null } });
    const replaced = fact({ subject: "replaced", superseded: true, enabled: false });
    const groups = attentionGroups([off, ended, hidden, unused, fresh, used, replaced], NOW);
    const subjects = Object.fromEntries(Object.entries(groups).map(([reason, facts]) => [reason, facts.map((item) => item.subject)]));
    expect(subjects).toEqual({ off: ["off"], ended: ["ended"], hidden: ["hidden"], unused: ["unused"] });
  });
});
