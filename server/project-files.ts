import { readdir, realpath } from "node:fs/promises";
import { join, relative } from "node:path";
import { readInsideRoot, ReadRefused } from "./safe-read";
import { redactSecrets } from "./secrets";

export const MAX_FILE_BYTES = 8 * 1024;
export const MAX_TOTAL_BYTES = 64 * 1024;
const MAX_DOCS = 8;
// Read past the cap so a secret cut at the boundary is still whole when redaction runs.
const READ_BYTES = MAX_FILE_BYTES + 1024;
// Doc names go into the prompt's fence labels, so only plain names are read.
const DOC_NAME = /^[\w.-]+\.md$/i;

export interface ProjectFile {
  path: string;
  text: string;
  // Instruction files reach agents directly, so a scan must not repeat them as memories.
  instructions: boolean;
}

const PACKAGE_FIELDS = ["name", "scripts", "engines", "packageManager", "workspaces"] as const;
const MANIFESTS = ["package.json", "Makefile", "justfile", "pyproject.toml", "Cargo.toml", "go.mod", ".tool-versions", ".nvmrc"];
const INSTRUCTIONS = ["AGENTS.md", "CLAUDE.md", ".github/copilot-instructions.md"];

// Read with readInsideRoot's rules (no symlinks or hard links, inside the root, the file checked is
// the file read); a file with a NUL byte in what was read is taken as binary and skipped.
async function readInside(root: string, path: string): Promise<{ text: string; cut: boolean } | null> {
  const read = await readInsideRoot(root, path, READ_BYTES).catch((error: unknown) => {
    if (error instanceof ReadRefused) return null;
    throw error;
  });
  if (!read || read.bytes.includes(0)) return null;
  return { text: read.bytes.toString("utf8"), cut: read.cut };
}

function capped(text: string, cut: boolean): string {
  const bytes = Buffer.from(text);
  return bytes.length <= MAX_FILE_BYTES && !cut ? text : `${bytes.subarray(0, MAX_FILE_BYTES).toString("utf8")}\n[cut at 8 KB]`;
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

// The fixed list of project files a scan reads from a project root (see ProjectKeys), under per-file and total caps, with secret-shaped
// text removed. Instruction files and manifests come first, as they are short and the scan needs them
// most; a file that would pass the total cap is left out and the smaller ones after it still fit.
export async function readProjectFiles(projectRoot: string): Promise<ProjectFile[]> {
  // Real, so the inside-the-root check compares real paths with real paths.
  const root = await realpath(projectRoot);
  const readme = (await namesMatching(root, /^readme(\.(md|markdown|txt|rst))?$/i)).slice(0, 1);
  const contributing = (await namesMatching(root, /^contributing(\.(md|markdown|txt|rst))?$/i)).slice(0, 1);
  const docs = (await namesMatching(join(root, "docs"), DOC_NAME)).slice(0, MAX_DOCS).map((name) => `docs/${name}`);
  const paths = [...MANIFESTS, ...readme, ...contributing, ...docs];
  const files: ProjectFile[] = [];
  let total = 0;
  for (const [path, instructions] of [...INSTRUCTIONS.map((path) => [path, true] as const), ...paths.map((path) => [path, false] as const)]) {
    const raw = await readInside(root, path);
    if (raw === null || raw.text.trim() === "") continue;
    // A cut package.json is not JSON, so it is sent as text.
    const text = capped(redactSecrets(path === "package.json" && !raw.cut ? packageSummary(raw.text) : raw.text), raw.cut);
    if (total + Buffer.byteLength(text) > MAX_TOTAL_BYTES) continue;
    total += Buffer.byteLength(text);
    files.push({ path: relative(root, join(root, path)), text, instructions });
  }
  return files;
}
