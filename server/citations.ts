import type { FactListItem } from "../shared/memory";
import { git } from "./git";

// For each fact whose cited code changed since the commit it was saved at, a short note for the
// index. One `git diff` per distinct commit (not per fact) keeps this inside the hook budget; work
// that does not fit is reported as "not checked", never as a pass.
export async function checkCitations(cwd: string, facts: readonly FactListItem[], budgetMs: number): Promise<Map<string, string>> {
  const notes = new Map<string, string>();
  const byCommit = new Map<string, FactListItem[]>();
  for (const fact of facts) {
    for (const citation of fact.citations) {
      const list = byCommit.get(citation.commit) ?? [];
      if (!list.includes(fact)) list.push(fact);
      byCommit.set(citation.commit, list);
    }
  }
  const deadline = Date.now() + budgetMs;
  for (const [commit, citing] of byCommit) {
    const remaining = deadline - Date.now();
    if (remaining <= 50) {
      for (const fact of citing) if (!notes.has(fact.id)) notes.set(fact.id, "citations not checked (time budget)");
      continue;
    }
    let changed: Set<string>;
    try {
      changed = new Set((await git(cwd, ["diff", "--name-only", commit, "--"], remaining)).split("\n").filter((line) => line !== ""));
    } catch {
      for (const fact of citing) if (!notes.has(fact.id)) notes.set(fact.id, `commit ${commit} is not in this checkout`);
      continue;
    }
    for (const fact of citing) {
      const stale = fact.citations.filter((citation) => citation.commit === commit && changed.has(citation.path)).map((citation) => citation.path);
      if (stale.length > 0 && !notes.has(fact.id)) notes.set(fact.id, `${stale.join(", ")} changed since ${commit}`);
    }
  }
  return notes;
}
