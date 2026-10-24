import { lstat, readdir, readFile, realpath } from "node:fs/promises";
import { join, relative, sep } from "node:path";
import { git } from "./git";
import { redactSecrets } from "./secrets";

export const MAX_FILE_BYTES = 8 * 1024;
export const MAX_TOTAL_BYTES = 64 * 1024;
const MAX_DOCS = 8;

export interface ProjectFile {
  path: string;
  text: string;
  // Instruction files reach agents directly, so a scan must not repeat them as memories.
  instructions: boolean;
}

const PACKAGE_FIELDS = ["name", "scripts", "engines", "packageManager", "workspaces"] as const;
const MANIFESTS = ["package.json", "Makefile", "justfile", "pyproject.toml", "Cargo.toml", "go.mod", ".tool-versions", ".nvmrc"];
const INSTRUCTIONS = ["AGENTS.md", "CLAUDE.md", ".github/copilot-instructions.md"];

async function repoRoot(cwd: string): Promise<string> {
  const top = await git(cwd, ["rev-parse", "--show-toplevel"], 2_000).catch(() => "");
  if (!top) throw new Error(`${cwd} is not in a git repo, so there is no project to read`);
  return realpath(top);
}

// Only regular files whose real path stays inside the repo: a symlink, or a file reached through a
// symlinked folder, is never read.
async function readInside(root: string, path: string): Promise<string | null> {
  const full = join(root, path);
  const info = await lstat(full).catch(() => null);
  if (!info?.isFile()) return null;
  const real = await realpath(full);
  if (!real.startsWith(`${root}${sep}`)) return null;
  return readFile(real, "utf8");
}

function capped(text: string): string {
  const bytes = Buffer.from(text);
  return bytes.length <= MAX_FILE_BYTES ? text : `${bytes.subarray(0, MAX_FILE_BYTES).toString("utf8")}\n[cut at 8 KB]`;
}

// package.json is mostly dependencies; only the parts that say how to work in the repo are kept.
function packageSummary(text: string): string {
  try {
    const parsed = JSON.parse(text) as Record<string, unknown>;
    return JSON.stringify(Object.fromEntries(PACKAGE_FIELDS.filter((key) => key in parsed).map((key) => [key, parsed[key]])), null, 2);
  } catch {
    return text;
  }
}

async function namesMatching(dir: string, pattern: RegExp): Promise<string[]> {
  return (await readdir(dir).catch(() => [] as string[])).filter((name) => pattern.test(name)).sort();
}

// The fixed list of project files a scan reads, in order, under per-file and total caps, with
// secret-shaped text removed.
export async function readProjectFiles(cwd: string): Promise<ProjectFile[]> {
  const root = await repoRoot(cwd);
  const readme = (await namesMatching(root, /^readme(\.(md|markdown|txt|rst))?$/i)).slice(0, 1);
  const contributing = (await namesMatching(root, /^contributing(\.(md|markdown|txt|rst))?$/i)).slice(0, 1);
  const docs = (await namesMatching(join(root, "docs"), /\.md$/i)).slice(0, MAX_DOCS).map((name) => `docs/${name}`);
  const paths = [...readme, ...contributing, ...docs, ...MANIFESTS];
  const files: ProjectFile[] = [];
  let total = 0;
  for (const [path, instructions] of [...paths.map((path) => [path, false] as const), ...INSTRUCTIONS.map((path) => [path, true] as const)]) {
    const raw = await readInside(root, path);
    if (raw === null || raw.trim() === "") continue;
    const text = capped(redactSecrets(path === "package.json" ? packageSummary(raw) : raw));
    total += Buffer.byteLength(text);
    if (total > MAX_TOTAL_BYTES) break;
    files.push({ path: relative(root, join(root, path)), text, instructions });
  }
  return files;
}
