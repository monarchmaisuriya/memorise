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

// Clones and worktrees of one repository share the key, whatever folder they live in.
export function repoKeyFromRemote(remoteUrl: string): string | null {
  const remote = splitRemote(remoteUrl.trim());
  if (!remote) return null;
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

// A folder outside git is one project: its key comes from its real path, and carries the folder's
// name so the manager can show which folder it is. Moving the folder gives it a new key.
export function folderKey(realPath: string): string {
  const name = basename(realPath).toLowerCase().replace(/[^a-z0-9._-]+/g, "-").replace(/^[-.]+|-+$/g, "").slice(0, FOLDER_NAME_MAX);
  return `${FOLDER_PREFIX}${name || "root"}-${createHash("sha256").update(realPath).digest("hex").slice(0, 12)}`;
}

function isOutsideRepo(error: unknown): boolean {
  return error instanceof GitError && error.stderr.includes("not a git repository");
}

// The key of the repo `cwd` is in, or of the folder itself when it is not in git.
export async function readRepoKey(cwd: string): Promise<string> {
  try {
    const remote = await git(cwd, ["config", "--get", "remote.origin.url"], GIT_TIMEOUT_MS).catch((error: unknown) => {
      // `git config --get` exits 1 when the key is absent: a repo without an origin.
      if (error instanceof GitError && error.exitCode === 1) return "";
      throw error;
    });
    const fromRemote = remote === "" ? null : repoKeyFromRemote(remote);
    if (fromRemote) return fromRemote;
    // Absolute and symlink-free, so /var and /private/var on macOS give one key.
    const commonDir = await git(cwd, ["rev-parse", "--path-format=absolute", "--git-common-dir"], GIT_TIMEOUT_MS);
    return repoKeyFromCommonDir(await realpath(commonDir));
  } catch (error) {
    if (isOutsideRepo(error)) return folderKey(await realpath(cwd));
    throw error;
  }
}
