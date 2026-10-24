import { constants } from "node:fs";
import { lstat, open, realpath } from "node:fs/promises";
import { isAbsolute, join, relative, sep } from "node:path";

// Why a file inside a project was not read. "missing" is told apart, so a deleted file can be named.
export class ReadRefused extends Error {
  constructor(
    readonly path: string,
    readonly missing: boolean,
    reason: string,
  ) {
    super(`${path} ${reason}`);
  }
}

export function isInside(root: string, path: string): boolean {
  const rel = relative(root, path);
  return rel !== "" && rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel);
}

// The start of a file inside a project root, read safely: only a regular file with one link (never
// a symlink or a hard link) whose real path is inside the root. The file opened must be the one that
// was checked (same device and inode, opened without following a symlink), so swapping it between
// the check and the read is refused. At most `maxBytes` are read; `cut` says the file is longer.
export async function readInsideRoot(root: string, path: string, maxBytes: number): Promise<{ bytes: Buffer; cut: boolean }> {
  const realRoot = await realpath(root);
  const full = join(realRoot, path);
  const info = await lstat(full).catch(() => null);
  if (!info) throw new ReadRefused(path, true, "does not exist");
  if (!info.isFile()) throw new ReadRefused(path, false, "is not a regular file");
  if (info.nlink > 1) throw new ReadRefused(path, false, "is a hard link");
  const real = await realpath(full);
  if (!isInside(realRoot, real)) throw new ReadRefused(path, false, "is outside the project");
  const file = await open(real, constants.O_RDONLY | constants.O_NOFOLLOW).catch(() => {
    throw new ReadRefused(path, false, "could not be opened");
  });
  try {
    const opened = await file.stat();
    if (opened.dev !== info.dev || opened.ino !== info.ino) throw new ReadRefused(path, false, "changed while being read");
    const buffer = Buffer.alloc(maxBytes + 1);
    let filled = 0;
    while (filled < buffer.length) {
      const { bytesRead } = await file.read(buffer, filled, buffer.length - filled, filled);
      if (bytesRead === 0) break;
      filled += bytesRead;
    }
    return { bytes: buffer.subarray(0, Math.min(filled, maxBytes)), cut: filled > maxBytes };
  } finally {
    await file.close();
  }
}
