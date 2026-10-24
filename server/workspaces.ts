import type { PaseoApi } from "./paseo-types";
import { readRepoKey } from "./repo-key";
import { isWorkerCwd } from "./workers";

// The repo (or folder) of every open Paseo workspace, across every page, with one checkout of each.
// A project's main checkout is preferred over a worktree of a branch; a folder that is gone, and the
// plugin's own worker folders under `root`, are skipped.
export async function openRepoCheckouts(paseo: PaseoApi, root: string): Promise<Map<string, string>> {
  const checkouts = new Map<string, string>();
  const seen = new Set<string>();
  let cursor: string | undefined;
  do {
    const { entries, pageInfo } = await paseo.workspaces.list({ page: { limit: 200, ...(cursor ? { cursor } : {}) } });
    for (const workspace of entries) {
      for (const folder of [workspace.projectRootPath, workspace.workspaceDirectory]) {
        if (!folder || seen.has(folder) || isWorkerCwd(root, folder)) continue;
        seen.add(folder);
        const repoKey = await readRepoKey(folder).catch(() => null);
        if (repoKey && !checkouts.has(repoKey)) checkouts.set(repoKey, folder);
      }
    }
    cursor = pageInfo.hasMore && pageInfo.nextCursor ? pageInfo.nextCursor : undefined;
  } while (cursor);
  return checkouts;
}
