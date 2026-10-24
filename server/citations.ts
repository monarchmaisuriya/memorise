import type { FactListItem } from "../shared/memory";
import { hashProjectFile } from "./file-hash";
import { git } from "./git";

// For each fact whose cited code changed since it was saved, a short note for the index. A repo's
// citations are checked with one `git diff` per distinct commit (not per fact), which keeps this
// inside the hook budget; a folder's citations by hashing each cited file again, relative to the
// project root. Work that does not fit is reported as "not checked", never as a pass.
export async function checkCitations({ cwd, root }: { cwd: string; root: string }, facts: readonly FactListItem[], budgetMs: number): Promise<Map<string, string>> {
  const notes = new Map<string, string>();
  const byCommit = new Map<string, FactListItem[]>();
  for (const fact of facts) {
    for (const citation of fact.citations) {
      if (citation.commit === undefined) continue;
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
  for (const fact of facts) {
    const hashed = fact.citations.filter((citation) => citation.hash !== undefined);
    if (hashed.length === 0 || notes.has(fact.id)) continue;
    if (deadline - Date.now() <= 50) {
      notes.set(fact.id, "citations not checked (time budget)");
      continue;
    }
    const missing: string[] = [];
    const changed: string[] = [];
    for (const citation of hashed) {
      const now = await hashProjectFile(root, citation.path).catch(() => null);
      if (now === null) missing.push(citation.path);
      else if (now !== citation.hash) changed.push(citation.path);
    }
    const parts = [...(changed.length > 0 ? [`${changed.join(", ")} changed since it was cited`] : []), ...(missing.length > 0 ? [`${missing.join(", ")} is missing`] : [])];
    if (parts.length > 0) notes.set(fact.id, parts.join("; "));
  }
  return notes;
}
