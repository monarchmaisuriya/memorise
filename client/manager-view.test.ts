import { describe, expect, it } from "vitest";
import { activeFilters, applyFilters, attentionGroups, DEFAULT_FILTERS, type ListedFact, mergeScopes, shownSelection } from "./manager-view";

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
    expect(activeFilters(DEFAULT_FILTERS, false)).toEqual([]);
    expect(activeFilters({ ...DEFAULT_FILTERS, type: "gotcha", control: "off" }, false).map((filter) => filter.label)).toEqual(["Gotcha", "Off"]);
  });

  it("leaves out the sort chip while a search orders the list", () => {
    expect(activeFilters({ ...DEFAULT_FILTERS, sort: "most used" }, false).map((filter) => filter.label)).toEqual(["Most used"]);
    expect(activeFilters({ ...DEFAULT_FILTERS, sort: "most used" }, true)).toEqual([]);
  });

  it("filters by each control", () => {
    const plain = fact({ subject: "plain" });
    const pinned = fact({ subject: "pinned", pinned: true });
    const off = fact({ subject: "off", enabled: false });
    const ended = fact({ subject: "ended", until: "2026-10-01" });
    const files = fact({ subject: "files", activation: "files", paths: ["src/**"] });
    const title = fact({ subject: "title", activation: "title" });
    const manual = fact({ subject: "manual", activation: "manual" });
    const all = [plain, pinned, off, ended, files, title, manual];
    const by = (control: (typeof DEFAULT_FILTERS)["control"]) => applyFilters(all, { ...DEFAULT_FILTERS, control }, "repo", null, NOW).map((item) => item.subject);
    expect(by("pinned")).toEqual(["pinned"]);
    expect(by("off")).toEqual(["off"]);
    expect(by("ended")).toEqual(["ended"]);
    expect(by("files")).toEqual(["files"]);
    expect(by("title")).toEqual(["title"]);
    expect(by("manual")).toEqual(["manual"]);
  });

  it("filters replaced and all statuses, and sorts by use", () => {
    const current = fact({ subject: "current", usage: { shown: 5, read: 0, found: 0, lastShown: null } });
    const replaced = fact({ subject: "replaced", superseded: true, usage: { shown: 1, read: 0, found: 0, lastShown: null } });
    const retired = fact({ subject: "retired", status: "retired", usage: { shown: 9, read: 0, found: 0, lastShown: null } });
    expect(applyFilters([current, replaced, retired], { ...DEFAULT_FILTERS, status: "replaced" }, "repo", null, NOW).map((item) => item.subject)).toEqual(["replaced"]);
    expect(applyFilters([current, replaced, retired], { ...DEFAULT_FILTERS, status: "all", sort: "most used" }, "repo", null, NOW).map((item) => item.subject)).toEqual(["retired", "current", "replaced"]);
    expect(applyFilters([current, replaced, retired], { ...DEFAULT_FILTERS, status: "all", sort: "least used" }, "repo", null, NOW).map((item) => item.subject)).toEqual(["replaced", "current", "retired"]);
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

describe("selection and scopes", () => {
  it("acts only on selected memories that are shown", () => {
    const a = fact({ subject: "a" });
    const b = fact({ subject: "b" });
    expect(shownSelection(new Set([a.id, b.id, "gone"]), [a])).toEqual([a.id]);
  });

  it("keeps each global memory once when every repo's list also carries them", () => {
    const global = fact({ subject: "global", scope: "global", repoKey: null });
    const api = fact({ subject: "api" });
    const web = fact({ subject: "web", repoKey: "github.com/acme/web" });
    const merged = mergeScopes([
      { repoKey: null, facts: [global] },
      { repoKey: "github.com/acme/api", facts: [global, api] },
      { repoKey: "github.com/acme/web", facts: [global, web] },
    ]);
    expect(merged.map((item) => item.subject)).toEqual(["global", "api", "web"]);
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

  it("counts a memory as never used only after 14 days", () => {
    const day14 = fact({ subject: "day 14", created: new Date(NOW - 14 * DAY).toISOString() });
    const day15 = fact({ subject: "day 15", created: new Date(NOW - 15 * DAY).toISOString() });
    expect((attentionGroups([day14, day15], NOW).unused ?? []).map((item) => item.subject)).toEqual(["day 15"]);
  });
});
