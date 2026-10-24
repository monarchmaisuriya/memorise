import { createHash } from "node:crypto";
import { lstat, readFile, realpath } from "node:fs/promises";
import { join, sep } from "node:path";

const MAX_HASHED_BYTES = 5 * 1024 * 1024;

// A cited file's content hash (16 hex of sha256), for citations in a folder outside git. The file
// must be a regular file (not a symlink) whose real path is inside the project root; anything else
// throws, naming the problem.
export async function hashProjectFile(root: string, path: string): Promise<string> {
  const full = join(root, path);
  const info = await lstat(full).catch(() => null);
  if (!info) throw new Error(`${path} does not exist in this folder`);
  if (!info.isFile()) throw new Error(`${path} is not a regular file`);
  if (info.size > MAX_HASHED_BYTES) throw new Error(`${path} is larger than 5 MB`);
  const realRoot = await realpath(root);
  if (!(await realpath(full)).startsWith(`${realRoot}${sep}`)) throw new Error(`${path} is outside this folder`);
  return createHash("sha256").update(await readFile(full)).digest("hex").slice(0, 16);
}
