import { execFileSync } from "node:child_process";
import { mkdirSync, realpathSync, symlinkSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { isFolderKey, repoKeySchema } from "../shared/memory";
import { ProjectKeys } from "./project-keys";
import { folderKey, readGitRepo, repoKeyFromRemote } from "./repo-key";
import { tempDir } from "./test-temp-dir";

describe("repoKeyFromRemote", () => {
  it.each([
    ["https://github.com/Acme/Api.git", "github.com/acme/api"],
    ["git@github.com:acme/api.git", "github.com/acme/api"],
    ["ssh://git@gitlab.example.com:2222/group/sub/repo", "gitlab.example.com/group/sub/repo"],
    ["work-github:acme/api.git", "work-github/acme/api"],
  ])("%s -> %s", (remote, key) => {
    expect(repoKeyFromRemote(remote)).toBe(key);
  });

  it.each(["", "not a url", "C:/src/app", "file:///tmp/repo", "git@folder:notes-0123456789ab", "https://local/abc"])("rejects %s", (remote) => {
    expect(repoKeyFromRemote(remote)).toBeNull();
  });
});

describe("readGitRepo and folder keys", () => {
  function initRepo(dir: string): void {
    execFileSync("git", ["init", "-q", dir]);
  }

  it("finds no repo outside git, and keys a folder by its name and real path, the same through a symlink", async () => {
    const parent = tempDir("no-repo-");
    const folder = join(parent, "My Notes!");
    mkdirSync(folder);
    symlinkSync(folder, join(parent, "link"));
    expect(await readGitRepo(folder)).toBeNull();
    const keys = new ProjectKeys(tempDir("keys-data-"));
    const { key } = await keys.resolve(folder);
    expect(key).toMatch(/^folder\/my-notes-[0-9a-f]{12}$/);
    expect((await keys.resolve(join(parent, "link"))).key).toBe(key);
    expect((await keys.resolve(parent)).key).not.toBe(key);
    expect(isFolderKey(key)).toBe(true);
  });

  it("names the filesystem root and long folder names within the repo key rules", () => {
    expect(folderKey("/")).toMatch(/^folder\/root-[0-9a-f]{12}$/);
    const long = folderKey(`/tmp/${"A".repeat(80)}`);
    expect(long).toMatch(/^folder\/a{40}-[0-9a-f]{12}$/);
    expect(isFolderKey("github.com/acme/api")).toBe(false);
    // A name with no letters the key can hold is not shown as the filesystem root.
    expect(folderKey("/tmp/日本語")).toMatch(/^folder\/folder-[0-9a-f]{12}$/);
    for (const path of ["/", "/tmp/..x", "/tmp/~a", "/tmp/日本語", `/tmp/${"z".repeat(300)}`]) expect(repoKeySchema.safeParse(folderKey(path)).success).toBe(true);
  });

  it("uses the origin remote, shared by every worktree", async () => {
    const repo = tempDir("repo-");
    initRepo(repo);
    execFileSync("git", ["-C", repo, "remote", "add", "origin", "git@github.com:acme/api.git"]);
    expect(await readGitRepo(repo)).toEqual({ key: "github.com/acme/api", top: realpathSync(repo) });
  });

  it("falls back to one key for all worktrees of a repo with no origin", async () => {
    const repo = tempDir("repo-");
    initRepo(repo);
    execFileSync("git", ["-C", repo, "-c", "user.email=t@t", "-c", "user.name=t", "commit", "-q", "--allow-empty", "-m", "init"]);
    const worktree = join(tempDir("wt-"), "wt");
    execFileSync("git", ["-C", repo, "worktree", "add", "-q", worktree]);
    const key = (await readGitRepo(repo))?.key;
    expect(key).toMatch(/^local\/[0-9a-f]{16}$/);
    expect((await readGitRepo(worktree))?.key).toBe(key);
  });
});
