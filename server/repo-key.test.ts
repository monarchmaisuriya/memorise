import { execFileSync } from "node:child_process";
import { mkdirSync, symlinkSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { isFolderKey } from "../shared/memory";
import { folderKey, readRepoKey, repoKeyFromRemote } from "./repo-key";
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

  it.each(["", "not a url", "C:/src/app", "file:///tmp/repo"])("rejects %s", (remote) => {
    expect(repoKeyFromRemote(remote)).toBeNull();
  });
});

describe("readRepoKey", () => {
  function initRepo(dir: string): void {
    execFileSync("git", ["init", "-q", dir]);
  }

  it("gives a folder outside git its own key, named after the folder, the same through a symlink", async () => {
    const parent = tempDir("no-repo-");
    const folder = join(parent, "My Notes!");
    mkdirSync(folder);
    symlinkSync(folder, join(parent, "link"));
    const key = await readRepoKey(folder);
    expect(key).toMatch(/^folder\/my-notes-[0-9a-f]{12}$/);
    expect(await readRepoKey(join(parent, "link"))).toBe(key);
    expect(await readRepoKey(parent)).not.toBe(key);
    expect(isFolderKey(key ?? "")).toBe(true);
  });

  it("names the filesystem root and long folder names within the repo key rules", () => {
    expect(folderKey("/")).toMatch(/^folder\/root-[0-9a-f]{12}$/);
    const long = folderKey(`/tmp/${"A".repeat(80)}`);
    expect(long).toMatch(/^folder\/a{40}-[0-9a-f]{12}$/);
    expect(isFolderKey("github.com/acme/api")).toBe(false);
  });

  it("uses the origin remote, shared by every worktree", async () => {
    const repo = tempDir("repo-");
    initRepo(repo);
    execFileSync("git", ["-C", repo, "remote", "add", "origin", "git@github.com:acme/api.git"]);
    expect(await readRepoKey(repo)).toBe("github.com/acme/api");
  });

  it("falls back to one key for all worktrees of a repo with no origin", async () => {
    const repo = tempDir("repo-");
    initRepo(repo);
    execFileSync("git", ["-C", repo, "-c", "user.email=t@t", "-c", "user.name=t", "commit", "-q", "--allow-empty", "-m", "init"]);
    const worktree = join(tempDir("wt-"), "wt");
    execFileSync("git", ["-C", repo, "worktree", "add", "-q", worktree]);
    const key = await readRepoKey(repo);
    expect(key).toMatch(/^local\/[0-9a-f]{16}$/);
    expect(await readRepoKey(worktree)).toBe(key);
  });
});
