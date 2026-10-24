import { mkdir, utimes, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { recentFiles } from "./work-files";
import { tempDir } from "./test-temp-dir";

const DAY_S = 24 * 60 * 60;

async function file(root: string, path: string, ageDays = 0): Promise<void> {
  const full = join(root, path);
  await mkdir(join(full, ".."), { recursive: true });
  await writeFile(full, "x");
  const when = Date.now() / 1000 - ageDays * DAY_S;
  await utimes(full, when, when);
}

describe("recently changed files in a folder outside git", () => {
  it("lists files changed in the last 7 days, relative to the root, leaving out tool and hidden folders", async () => {
    const root = tempDir("recent-");
    await file(root, "notes/today.md");
    await file(root, "plan.md", 6);
    await file(root, "old.md", 8);
    await file(root, "node_modules/pkg/index.js");
    await file(root, ".cache/x.json");
    await file(root, "dist/out.js");
    const { files, cutShort } = await recentFiles(root);
    expect(files.sort()).toEqual(["notes/today.md", "plan.md"]);
    expect(cutShort).toBe(false);
  });

  it("stops at its file limit and says the list was cut short", async () => {
    const root = tempDir("recent-");
    for (let index = 0; index < 5; index += 1) await file(root, `f${index}.md`);
    const { files, cutShort } = await recentFiles(root, { maxFiles: 3 });
    expect(files).toHaveLength(3);
    expect(cutShort).toBe(true);
  });
});
