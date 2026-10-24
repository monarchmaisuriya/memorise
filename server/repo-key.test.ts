import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { readRepoKey, repoKeyFromRemote } from "./repo-key";
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

  it("returns null outside a git repo", async () => {
    expect(await readRepoKey(tempDir("no-repo-"))).toBeNull();
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
