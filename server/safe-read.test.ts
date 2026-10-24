import { link, mkdir, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { hashProjectFile } from "./file-hash";
import { isInside, readInsideRoot } from "./safe-read";
import { tempDir } from "./test-temp-dir";

describe("reading a file inside a project root", () => {
  it("refuses a hard link, a symlink, a path through a symlinked folder, and a missing file, naming why", async () => {
    const root = tempDir("safe-");
    const outside = tempDir("safe-out-");
    await writeFile(join(outside, "secret.txt"), "outside\n");
    await link(join(outside, "secret.txt"), join(root, "hard.txt"));
    await symlink(join(outside, "secret.txt"), join(root, "soft.txt"));
    await symlink(outside, join(root, "linked"));
    await expect(hashProjectFile(root, "hard.txt")).rejects.toThrow("hard.txt is a hard link");
    await expect(hashProjectFile(root, "soft.txt")).rejects.toThrow("soft.txt is not a regular file");
    await writeFile(join(outside, "plain.txt"), "outside\n");
    await expect(hashProjectFile(root, "linked/plain.txt")).rejects.toThrow("linked/plain.txt is outside the project");
    await expect(hashProjectFile(root, "gone.txt")).rejects.toMatchObject({ missing: true });
  });

  it("reads at most the limit and says the file is longer", async () => {
    const root = tempDir("safe-");
    await mkdir(join(root, "docs"));
    await writeFile(join(root, "docs", "big.md"), "y".repeat(100));
    const { bytes, cut } = await readInsideRoot(root, "docs/big.md", 10);
    expect(bytes.toString()).toBe("y".repeat(10));
    expect(cut).toBe(true);
    expect((await readInsideRoot(root, "docs/big.md", 100)).cut).toBe(false);
  });

  it("treats every path below the filesystem root as inside it", () => {
    expect(isInside("/", "/Users/me/notes.md")).toBe(true);
    expect(isInside("/a/b", "/a/b/c")).toBe(true);
    expect(isInside("/a/b", "/a/bc")).toBe(false);
    expect(isInside("/a/b", "/a/b")).toBe(false);
    expect(isInside("/a/b", "/a/b/..x")).toBe(true);
  });
});
