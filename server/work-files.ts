import { readdir, stat } from "node:fs/promises";
import { join } from "node:path";
import { matchesGlob } from "node:path/posix";
import type { FactListItem } from "../shared/memory";
import { git } from "./git";

const GIT_TIMEOUT_MS = 1_000;
const MAX_FILES = 2_000;

// Files this checkout is working on: changed since it branched from the default branch, plus
// uncommitted and untracked ones. Paths are relative to the repo root, as git prints them.
export async function workFiles(cwd: string): Promise<string[]> {
  const files = new Set<string>();
  // Plain path lists (not `git status --porcelain`, whose column layout breaks under trimming).
  const [uncommitted, untracked] = await Promise.all([
    git(cwd, ["diff", "--name-only", "HEAD"], GIT_TIMEOUT_MS).catch(() => ""),
    // From a subfolder, ls-files lists only that folder and prints paths relative to it: ":/" asks
    // for the whole repo and --full-name prints paths from the root.
    git(cwd, ["ls-files", "--others", "--exclude-standard", "--full-name", "--", ":/"], GIT_TIMEOUT_MS),
  ]);
  for (const path of [...uncommitted.split("\n"), ...untracked.split("\n")]) if (path !== "") files.add(path);
  // A repo without origin/HEAD (no remote, or never fetched) has no branch point; uncommitted
  // files are then all there is to go on.
  const base = await git(cwd, ["merge-base", "HEAD", "origin/HEAD"], GIT_TIMEOUT_MS).catch(() => null);
  if (base) {
    const diff = await git(cwd, ["diff", "--name-only", base], GIT_TIMEOUT_MS);
    for (const path of diff.split("\n")) if (path !== "") files.add(path);
  }
  return [...files].slice(0, MAX_FILES);
}

const RECENT_MS = 7 * 24 * 60 * 60 * 1000;
// Folders of tools, builds, and dependencies, never the files someone is working on.
const SKIPPED_FOLDERS = new Set(["node_modules", "dist", "build", "out", "target", "vendor", "__pycache__", "venv", "coverage"]);

// Files a folder outside git is working on: changed in the last 7 days, relative to its root. There
// is no history to diff, so the modification time stands in for it. Hidden and tool folders are
// skipped and symlinks are not followed. The walk stops at its entry, file, or time limit and then
// says the list was cut short.
export async function recentFiles(
  root: string,
  { maxFiles = MAX_FILES, maxEntries = 20_000, budgetMs = 300 }: { maxFiles?: number; maxEntries?: number; budgetMs?: number } = {},
): Promise<{ files: string[]; cutShort: boolean }> {
  const since = Date.now() - RECENT_MS;
  const deadline = Date.now() + budgetMs;
  const files: string[] = [];
  const folders = [""];
  let entries = 0;
  while (folders.length > 0) {
    const folder = folders.shift() ?? "";
    for (const entry of await readdir(join(root, folder), { withFileTypes: true }).catch(() => [])) {
      entries += 1;
      if (files.length >= maxFiles || entries > maxEntries || Date.now() > deadline) return { files, cutShort: true };
      if (entry.name.startsWith(".")) continue;
      const path = folder ? `${folder}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        if (!SKIPPED_FOLDERS.has(entry.name)) folders.push(path);
      } else if (entry.isFile()) {
        const info = await stat(join(root, path)).catch(() => null);
        if (info && info.mtimeMs >= since) files.push(path);
      }
    }
  }
  return { files, cutShort: false };
}

// Answers "is this fact about any of these files?" (by its path globs or the files it cites). Each
// distinct glob is matched against the files once and remembered, and glob matching stops when the
// time budget is spent: later globs count as no match and `skipped` says so, so ranking can never
// hold up agent creation.
export class PathMatcher {
  private readonly files: readonly string[];
  private readonly fileSet: ReadonlySet<string>;
  private readonly globs = new Map<string, boolean>();
  private readonly deadline: number;
  skipped = false;

  constructor(files: readonly string[], budgetMs = Number.POSITIVE_INFINITY) {
    this.files = files;
    this.fileSet = new Set(files);
    this.deadline = Date.now() + budgetMs;
  }

  private globMatches(glob: string): boolean {
    const known = this.globs.get(glob);
    if (known !== undefined) return known;
    if (Date.now() >= this.deadline) {
      this.skipped = true;
      return false;
    }
    const result = this.files.some((file) => matchesGlob(file, glob));
    this.globs.set(glob, result);
    return result;
  }

  matches(fact: Pick<FactListItem, "paths" | "citations">): boolean {
    if (this.files.length === 0) return false;
    return fact.citations.some((citation) => this.fileSet.has(citation.path)) || fact.paths.some((glob) => this.globMatches(glob));
  }
}

export function factMatchesFiles(fact: Pick<FactListItem, "paths" | "citations">, files: readonly string[]): boolean {
  return new PathMatcher(files).matches(fact);
}
