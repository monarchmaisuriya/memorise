import { createHash } from "node:crypto";
import { realpath } from "node:fs/promises";
import { basename } from "node:path";
import { repoKeySchema } from "../shared/memory";
import { git, GitError } from "./git";

const GIT_TIMEOUT_MS = 1_500;
// A one-letter host is a Windows drive, as in "C:/src/app".
const SCP_LIKE_REMOTE = /^(?:[^/@]+@)?([^:/\\]{2,}):(.+)$/;

function splitRemote(url: string): { host: string; path: string } | null {
  const scpLike = url.includes("://") ? null : SCP_LIKE_REMOTE.exec(url);
  if (scpLike) return { host: scpLike[1], path: scpLike[2] };
  if (!URL.canParse(url)) return null;
  const { hostname, pathname } = new URL(url);
  return hostname === "" ? null : { host: hostname, path: pathname };
}

// Keys under these hosts are made by this plugin, so a remote can never claim one.
const RESERVED_HOSTS = new Set(["folder", "local"]);

// Clones and worktrees of one repository share the key, whatever folder they live in.
export function repoKeyFromRemote(remoteUrl: string): string | null {
  const remote = splitRemote(remoteUrl.trim());
  if (!remote || RESERVED_HOSTS.has(remote.host.toLowerCase())) return null;
  const segments = remote.path
    .toLowerCase()
    .replace(/\.git\/?$/, "")
    .split("/")
    .filter((segment) => segment !== "");
  const key = [remote.host.toLowerCase(), ...segments].join("/");
  return repoKeySchema.safeParse(key).success ? key : null;
}

// Worktrees of a repository with no origin share one git common dir.
export function repoKeyFromCommonDir(commonDir: string): string {
  return `local/${createHash("sha256").update(commonDir).digest("hex").slice(0, 16)}`;
}

const FOLDER_PREFIX = "folder/";
const FOLDER_NAME_MAX = 40;

// The key a folder outside git gets when it is first seen: from its real path at that time, with the
// folder's name so the manager can show which folder it is. server/project-keys.ts keeps the key
// when the folder is later renamed or moved.
export function folderKey(realPath: string): string {
  const name = basename(realPath).toLowerCase().replace(/[^a-z0-9._-]+/g, "-").replace(/^[-.]+|-+$/g, "").slice(0, FOLDER_NAME_MAX);
  return `${FOLDER_PREFIX}${name || (realPath === "/" ? "root" : "folder")}-${createHash("sha256").update(realPath).digest("hex").slice(0, 12)}`;
}

function isOutsideRepo(error: unknown): boolean {
  return error instanceof GitError && error.stderr.includes("not a git repository");
}

// The git repo `cwd` is in: its key and its top level, or null when `cwd` is not in git. Any other git
// failure is thrown, so a folder in a repo is never taken for a folder outside git.
export async function readGitRepo(cwd: string): Promise<{ key: string; top: string } | null> {
  try {
    const remote = await git(cwd, ["config", "--get", "remote.origin.url"], GIT_TIMEOUT_MS).catch((error: unknown) => {
      // `git config --get` exits 1 when the key is absent: a repo without an origin.
      if (error instanceof GitError && error.exitCode === 1) return "";
      throw error;
    });
    // Absolute and symlink-free, so /var and /private/var on macOS give one key and one top level.
    const top = await realpath(await git(cwd, ["rev-parse", "--show-toplevel"], GIT_TIMEOUT_MS));
    const fromRemote = remote === "" ? null : repoKeyFromRemote(remote);
    if (fromRemote) return { key: fromRemote, top };
    const commonDir = await git(cwd, ["rev-parse", "--path-format=absolute", "--git-common-dir"], GIT_TIMEOUT_MS);
    return { key: repoKeyFromCommonDir(await realpath(commonDir)), top };
  } catch (error) {
    if (isOutsideRepo(error)) return null;
    throw error;
  }
}
