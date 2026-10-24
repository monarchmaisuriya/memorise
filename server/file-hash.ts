import { createHash } from "node:crypto";
import { readInsideRoot, ReadRefused } from "./safe-read";

const MAX_HASHED_BYTES = 5 * 1024 * 1024;

// A cited file's content hash (16 hex of sha256), for citations in a folder outside git. The file is
// read with readInsideRoot's rules; anything it refuses, or a file over 5 MB, throws naming why.
export async function hashProjectFile(root: string, path: string): Promise<string> {
  const { bytes, cut } = await readInsideRoot(root, path, MAX_HASHED_BYTES);
  if (cut) throw new ReadRefused(path, false, "is larger than 5 MB");
  return createHash("sha256").update(bytes).digest("hex").slice(0, 16);
}
