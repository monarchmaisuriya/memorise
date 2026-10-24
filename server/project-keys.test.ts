import { execFileSync } from "node:child_process";
import { statSync } from "node:fs";
import { mkdir, readFile, realpath, rename, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ProjectKeys } from "./project-keys";
import { folderKey } from "./repo-key";
import { tempDir } from "./test-temp-dir";

async function folder(parent: string, name: string): Promise<string> {
  const path = join(parent, name);
  await mkdir(path, { recursive: true });
  return realpath(path);
}

describe("project keys", () => {
  it("resolves a git repo by its origin and its top level, from a subfolder", async () => {
    const repo = tempDir("keys-repo-");
    execFileSync("git", ["init", "-q", repo]);
    execFileSync("git", ["-C", repo, "remote", "add", "origin", "git@github.com:acme/api.git"]);
    const sub = await folder(repo, "src/api");
    expect(await new ProjectKeys(tempDir("keys-data-")).resolve(sub)).toEqual({ key: "github.com/acme/api", root: await realpath(repo) });
  });

  it("gives a new folder the same key 0.5.0 gave it, rooted at the folder", async () => {
    const notes = await folder(tempDir("keys-"), "Notes");
    expect(await new ProjectKeys(tempDir("keys-data-")).resolve(notes)).toEqual({ key: folderKey(notes), root: notes });
  });

  it("keeps a folder's key when it is renamed or moved on the same disk, and remembers that across restarts", async () => {
    const data = tempDir("keys-data-");
    const parent = tempDir("keys-");
    const notes = await folder(parent, "notes");
    const { key } = await new ProjectKeys(data).resolve(notes);
    const renamed = join(parent, "trip-notes");
    await rename(notes, renamed);
    expect(await new ProjectKeys(data).resolve(renamed)).toEqual({ key, root: await realpath(renamed) });
    const moved = join(await folder(parent, "archive"), "trip");
    await rename(renamed, moved);
    const keys = new ProjectKeys(data);
    expect(await keys.resolve(moved)).toEqual({ key, root: await realpath(moved) });
    expect(await keys.label(key)).toEqual({ name: "trip", path: await realpath(moved) });
  });

  it("gives a subfolder its project root's key, but a folder where an agent merely ran claims nothing below it", async () => {
    const keys = new ProjectKeys(tempDir("keys-data-"));
    const parent = tempDir("keys-");
    const project = await folder(parent, "site");
    await keys.markRoot(project);
    const page = await folder(project, "pages/blog");
    expect(await keys.resolve(page)).toEqual({ key: folderKey(project), root: project });
    const home = await folder(parent, "home");
    const homeKey = (await keys.resolve(home)).key;
    const inside = await folder(home, "scratch");
    expect((await keys.resolve(inside)).key).not.toBe(homeKey);
  });

  it("finds a moved project root from a subfolder, and gives a new folder at a moved folder's old path a key of its own", async () => {
    const keys = new ProjectKeys(tempDir("keys-data-"));
    const parent = tempDir("keys-");
    const project = await folder(parent, "site");
    await keys.markRoot(project);
    const rootKey = (await keys.resolve(project)).key;
    const moved = join(parent, "site-2024");
    await rename(project, moved);
    const blog = await folder(moved, "blog");
    expect(await keys.resolve(blog)).toEqual({ key: rootKey, root: await realpath(moved) });
    const fresh = await folder(parent, "site");
    const freshKey = (await keys.resolve(fresh)).key;
    expect(freshKey).not.toBe(rootKey);
    expect(freshKey.startsWith(folderKey(fresh))).toBe(true);
  });

  it("does not take a folder for a lost one that had the same inode but another creation time", async () => {
    const data = tempDir("keys-data-");
    const notes = await folder(tempDir("keys-"), "notes");
    const info = statSync(notes, { bigint: true });
    const lost = { key: "folder/old-0123456789ab", path: join(tempDir("keys-"), "gone"), dev: String(info.dev), ino: String(info.ino), born: String(info.birthtimeNs + 1n), root: false };
    await writeFile(join(data, "folders.json"), JSON.stringify({ version: 1, folders: [lost] }));
    expect((await new ProjectKeys(data).resolve(notes)).key).toBe(folderKey(notes));
  });

  it("keeps each folder's key when two folders swap paths, whichever is seen first", async () => {
    const parent = tempDir("keys-");
    for (const order of [["a", "x"], ["x", "a"]]) {
      const keys = new ProjectKeys(tempDir("keys-data-"));
      const base = await folder(parent, `swap-${order[0]}`);
      const a = await folder(base, "a");
      const b = await folder(base, "b");
      const keyA = (await keys.resolve(a)).key;
      const keyB = (await keys.resolve(b)).key;
      await rename(a, join(base, "x"));
      await rename(b, join(base, "a"));
      const found = new Map<string, string>();
      for (const name of order) found.set(name, (await keys.resolve(join(base, name))).key);
      expect(found.get("a")).toBe(keyB);
      expect(found.get("x")).toBe(keyA);
    }
  });

  it("lets a subfolder seen before its root was marked follow the root, unless it has memories of its own", async () => {
    const withData = new Set<string>();
    const keys = new ProjectKeys(tempDir("keys-data-"), async (key) => withData.has(key));
    const project = await folder(tempDir("keys-"), "site");
    const blog = await folder(project, "blog");
    const docs = await folder(project, "docs");
    await keys.resolve(blog);
    withData.add((await keys.resolve(docs)).key);
    await keys.markRoot(project);
    expect((await keys.resolve(blog)).key).toBe(folderKey(project));
    expect((await keys.resolve(docs)).key).toBe(folderKey(docs));
  });

  it("keeps memories saved under a subfolder's first key (0.5.0) with that subfolder when its parent becomes a root", async () => {
    const project = await folder(tempDir("keys-"), "work");
    const client = await folder(project, "client-a");
    const keys = new ProjectKeys(tempDir("keys-data-"), async (key) => key === folderKey(client));
    await keys.markRoot(project);
    expect(await keys.resolve(client)).toEqual({ key: folderKey(client), root: client });
  });

  it("never takes the home folder or the filesystem root as a project root", async () => {
    const data = tempDir("keys-data-");
    const keys = new ProjectKeys(data);
    await keys.markRoot(homedir());
    await keys.markRoot("/");
    const saved = await readFile(join(data, "folders.json"), "utf8").catch(() => '{"folders":[]}');
    expect(JSON.parse(saved).folders.filter((entry: { root: boolean }) => entry.root)).toEqual([]);
  });

  it("names the registry file when it cannot be read, and leaves repos working", async () => {
    const data = tempDir("keys-data-");
    await writeFile(join(data, "folders.json"), "{ broken");
    const keys = new ProjectKeys(data);
    await expect(keys.resolve(tempDir("keys-"))).rejects.toThrow(/folders\.json could not be read/);
    const repo = tempDir("keys-repo-");
    execFileSync("git", ["init", "-q", repo]);
    expect((await keys.resolve(repo)).key).toMatch(/^local\//);
  });

  it("stores the registry as one JSON file in the plugin data", async () => {
    const data = tempDir("keys-data-");
    const notes = await folder(tempDir("keys-"), "notes");
    await new ProjectKeys(data).resolve(notes);
    const saved = JSON.parse(await readFile(join(data, "folders.json"), "utf8"));
    expect(saved.folders).toMatchObject([{ key: folderKey(notes), path: notes, root: false }]);
  });
});
