import type { FactListItem } from "../shared/memory";
import type { PathMatcher } from "./work-files";

const DAY_MS = 24 * 60 * 60 * 1000;

// What agents see: current versions only, not turned off, and not past their end date (which lasts
// to the end of that day, UTC). Agent-written facts unused for expiryDays drop out of the index and
// search (they stay on disk and in the Memory panel). Facts the user saved or pinned never expire.
// expiryDays 0 means "never hide".
export function isVisibleToAgents(fact: FactListItem, expiryDays: number, now = Date.now()): boolean {
  if (fact.status !== "active" || fact.superseded || !fact.enabled) return false;
  if (fact.until !== null && now >= Date.parse(fact.until) + DAY_MS) return false;
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

export type ListReason = "pinned" | "files" | "global" | "repo";
const TIER: Record<ListReason, number> = { pinned: 0, files: 1, global: 2, repo: 3 };

// Why a fact is listed in a new agent's index, or null when its activation keeps it out. A pinned
// fact is always listed; a manual one never; a files one only when the worktree changed a match.
export function listReason(fact: FactListItem, paths: PathMatcher): ListReason | null {
  if (fact.pinned) return "pinned";
  if (fact.activation === "manual") return null;
  const matches = paths.matches(fact);
  if (fact.activation === "files" && !matches) return null;
  return matches ? "files" : fact.scope === "global" ? "global" : "repo";
}

// Order for a new agent's index: pinned facts, then facts about files this worktree is changing,
// then global facts (the user's preferences), then this repo's; most recently used first in each.
// Each fact's reason is worked out once, before sorting, never inside the comparison.
export function rankWithReasons(facts: readonly FactListItem[], paths: PathMatcher): { fact: FactListItem; reason: ListReason }[] {
  const keyed = facts.flatMap((fact) => {
    const reason = listReason(fact, paths);
    return reason ? [{ fact, reason, tier: TIER[reason], used: Date.parse(fact.lastUsed) }] : [];
  });
  return keyed.sort((a, b) => a.tier - b.tier || b.used - a.used).map(({ fact, reason }) => ({ fact, reason }));
}

export function rankForAgent(facts: readonly FactListItem[], paths: PathMatcher): FactListItem[] {
  return rankWithReasons(facts, paths).map(({ fact }) => fact);
}
