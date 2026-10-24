import type { FactListItem } from "../shared/memory";
import type { PathMatcher } from "./work-files";

const DAY_MS = 24 * 60 * 60 * 1000;

// What agents see: current versions only. Agent-written facts unused for expiryDays drop out of the
// index and search (they stay on disk and in the Memory panel). Facts the user saved or pinned never
// expire. expiryDays 0 means "never hide".
export function isVisibleToAgents(fact: FactListItem, expiryDays: number, now = Date.now()): boolean {
  if (fact.status !== "active" || fact.superseded) return false;
  if (expiryDays === 0 || fact.source.by === "user" || fact.pinned) return true;
  return now - Date.parse(fact.lastUsed) <= expiryDays * DAY_MS;
}

// Global facts first (they hold the user's preferences), then this repo's, most recently used first.
export function orderForAgents(facts: readonly FactListItem[]): FactListItem[] {
  return [...facts].sort((a, b) => {
    if (a.scope !== b.scope) return a.scope === "global" ? -1 : 1;
    return Date.parse(b.lastUsed) - Date.parse(a.lastUsed);
  });
}

// Order for a new agent's index: pinned facts, then facts about files this worktree is changing,
// then global facts (the user's preferences), then this repo's; most recently used first in each.
// Each fact's tier is worked out once, before sorting, never inside the comparison.
export function rankForAgent(facts: readonly FactListItem[], paths: PathMatcher): FactListItem[] {
  const keyed = facts.map((fact) => ({
    fact,
    tier: fact.pinned ? 0 : paths.matches(fact) ? 1 : fact.scope === "global" ? 2 : 3,
    used: Date.parse(fact.lastUsed),
  }));
  return keyed.sort((a, b) => a.tier - b.tier || b.used - a.used).map(({ fact }) => fact);
}
