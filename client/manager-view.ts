import type { z } from "zod";
import type { Activation, listMemoriesRpc, MemoryType, Scope } from "../shared/memory";

// What the manager shows, worked out without React so it can be tested.
export type ListedFact = z.infer<typeof listMemoriesRpc.output>["facts"][number];

export type Status = "current" | "retired" | "replaced" | "all";
export type Control = "any" | "pinned" | "off" | "ended" | Exclude<Activation, "listed">;
export type Sort = "changed" | "created" | "most used" | "least used";

export interface ViewFilters {
  status: Status;
  type: MemoryType | "any";
  control: Control;
  sort: Sort;
}

export const DEFAULT_FILTERS: ViewFilters = { status: "current", type: "any", control: "any", sort: "changed" };

const DAY_MS = 24 * 60 * 60 * 1000;
// A memory nobody has been shown, read, or found this long after it was saved needs a look.
export const UNUSED_AFTER_DAYS = 14;

export const CONTROL_LABEL: Record<Control, string> = {
  any: "any control",
  pinned: "pinned",
  off: "off for agents",
  ended: "ended",
  files: "only for matching files",
  title: "title only",
  manual: "search only",
};

export function isEnded(fact: ListedFact, now = Date.now()): boolean {
  return fact.until !== null && now >= Date.parse(fact.until) + DAY_MS;
}

const isCurrent = (fact: ListedFact) => fact.status === "active" && !fact.superseded;

function matchesStatus(fact: ListedFact, status: Status): boolean {
  if (status === "all") return true;
  if (status === "replaced") return fact.superseded;
  if (status === "retired") return !fact.superseded && fact.status === "retired";
  return isCurrent(fact);
}

function matchesControl(fact: ListedFact, control: Control, now: number): boolean {
  if (control === "any") return true;
  if (control === "pinned") return fact.pinned;
  if (control === "off") return !fact.enabled;
  if (control === "ended") return isEnded(fact, now);
  return fact.activation === control;
}

const uses = (fact: ListedFact) => fact.usage.shown + fact.usage.read + fact.usage.found;
const SORTS: Record<Sort, (a: ListedFact, b: ListedFact) => number> = {
  changed: (a, b) => b.modified.localeCompare(a.modified),
  created: (a, b) => b.created.localeCompare(a.created),
  "most used": (a, b) => uses(b) - uses(a),
  "least used": (a, b) => uses(a) - uses(b),
};

// The filters that differ from the defaults, labelled for the chips under the search box. While a
// search orders the list, the sort does not apply, so it gets no chip.
export function activeFilters(filters: ViewFilters, searching: boolean): { key: keyof ViewFilters; label: string }[] {
  const active: { key: keyof ViewFilters; label: string }[] = [];
  if (filters.status !== DEFAULT_FILTERS.status) active.push({ key: "status", label: filters.status });
  if (filters.type !== DEFAULT_FILTERS.type) active.push({ key: "type", label: filters.type });
  if (filters.control !== DEFAULT_FILTERS.control) active.push({ key: "control", label: CONTROL_LABEL[filters.control] });
  if (!searching && filters.sort !== DEFAULT_FILTERS.sort) active.push({ key: "sort", label: `sorted by ${filters.sort}` });
  return active;
}

// The chosen scope's memories that pass the filters. With search results (ids, best first), they
// keep that order and the sort is ignored.
export function applyFilters(facts: readonly ListedFact[], filters: ViewFilters, scope: Scope, searchIds: readonly string[] | null, now = Date.now()): ListedFact[] {
  const rank = searchIds ? new Map(searchIds.map((id, index) => [id, index])) : null;
  const kept = facts.filter(
    (fact) => fact.scope === scope && (!rank || rank.has(fact.id)) && matchesStatus(fact, filters.status) && (filters.type === "any" || fact.type === filters.type) && matchesControl(fact, filters.control, now),
  );
  return rank ? kept.sort((a, b) => (rank.get(a.id) ?? 0) - (rank.get(b.id) ?? 0)) : kept.sort(SORTS[filters.sort]);
}

// Bulk actions act only on selected memories that are on screen now, so a search or filter that
// hides a selected memory also keeps it out of the action.
export function shownSelection(selected: ReadonlySet<string>, shown: readonly ListedFact[]): string[] {
  return shown.filter((fact) => selected.has(fact.id)).map((fact) => fact.id);
}

// Every repo's list also carries the global memories; each list contributes only its own scope, so
// a global memory appears once (from the global list, repoKey null).
export function mergeScopes(lists: readonly { repoKey: string | null; facts: readonly ListedFact[] }[]): ListedFact[] {
  return lists.flatMap(({ repoKey, facts }) => facts.filter((fact) => fact.scope === (repoKey ? "repo" : "global")));
}

export type AttentionReason = "off" | "ended" | "hidden" | "unused";

export const ATTENTION: { reason: AttentionReason; title: string; rule: string }[] = [
  { reason: "off", title: "Off for agents", rule: "Turned off; agents never see these." },
  { reason: "ended", title: "Ended", rule: "Past their end date; agents no longer see these." },
  { reason: "hidden", title: "Hidden from agents", rule: "Agent-written and unused for longer than the expiry setting." },
  { reason: "unused", title: "Never used", rule: `Saved over ${UNUSED_AFTER_DAYS} days ago and never shown, read, or found by an agent.` },
];

// Current memories that need a look, each under the first reason that applies.
export function attentionGroups(facts: readonly ListedFact[], now = Date.now()): Partial<Record<AttentionReason, ListedFact[]>> {
  const groups: Partial<Record<AttentionReason, ListedFact[]>> = {};
  for (const fact of facts.filter(isCurrent)) {
    const reason: AttentionReason | null = !fact.enabled
      ? "off"
      : isEnded(fact, now)
        ? "ended"
        : !fact.visibleToAgents
          ? "hidden"
          : uses(fact) === 0 && now - Date.parse(fact.created) > UNUSED_AFTER_DAYS * DAY_MS
            ? "unused"
            : null;
    if (reason) (groups[reason] ??= []).push(fact);
  }
  return groups;
}
