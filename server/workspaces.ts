import type { PaseoApi } from "./paseo-types";
import type { ProjectKeys } from "./project-keys";
import { isWorkerCwd } from "./workers";

// The repo (or folder) of every open Paseo workspace, across every page, with one checkout of each.
// A project's main checkout is preferred over a worktree of a branch; a folder that is gone, and the
// plugin's own worker folders under `root`, are skipped. A project outside git has its folder recorded
// as a project root, so agents in its subfolders share its memory.
export async function openRepoCheckouts(paseo: PaseoApi, root: string, keys: ProjectKeys): Promise<Map<string, string>> {
  const checkouts = new Map<string, string>();
  const seen = new Set<string>();
  let cursor: string | undefined;
  do {
    const { entries, pageInfo } = await paseo.workspaces.list({ page: { limit: 200, ...(cursor ? { cursor } : {}) } });
    for (const workspace of entries) {
      if (workspace.projectKind !== "git" && workspace.projectRootPath && !isWorkerCwd(root, workspace.projectRootPath)) {
        await keys.markRoot(workspace.projectRootPath).catch(() => undefined);
      }
      for (const folder of [workspace.projectRootPath, workspace.workspaceDirectory]) {
        if (!folder || seen.has(folder) || isWorkerCwd(root, folder)) continue;
        seen.add(folder);
        const repoKey = await keys.keyOf(folder).catch(() => null);
        if (repoKey && !checkouts.has(repoKey)) checkouts.set(repoKey, folder);
      }
    }
    cursor = pageInfo.hasMore && pageInfo.nextCursor ? pageInfo.nextCursor : undefined;
  } while (cursor);
  return checkouts;
}
