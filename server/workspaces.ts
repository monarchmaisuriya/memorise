import type { PaseoApi } from "./paseo-types";
import type { ProjectKeys } from "./project-keys";
import { isWorkerCwd } from "./workers";

type Workspace = Awaited<ReturnType<PaseoApi["workspaces"]["list"]>>["entries"][number];

// Every open Paseo workspace, across every page.
async function* allWorkspaces(paseo: PaseoApi): AsyncGenerator<Workspace> {
  let cursor: string | undefined;
  do {
    const { entries, pageInfo } = await paseo.workspaces.list({ page: { limit: 200, ...(cursor ? { cursor } : {}) } });
    yield* entries;
    cursor = pageInfo.hasMore && pageInfo.nextCursor ? pageInfo.nextCursor : undefined;
  } while (cursor);
}

// The one rule for project roots: the project folder of a workspace outside git (never a plugin
// worker's folder), so agents in its subfolders share its memory.
async function markRootOf(workspace: Workspace, root: string, keys: ProjectKeys): Promise<void> {
  if (workspace.projectKind === "git" || !workspace.projectRootPath || isWorkerCwd(root, workspace.projectRootPath)) return;
  await keys.markRoot(workspace.projectRootPath).catch((error: unknown) => console.error(`[memorise] could not record ${workspace.projectRootPath} as a project root: ${error instanceof Error ? error.message : String(error)}`));
}

// Records the root of every open workspace's project outside git.
export async function markProjectRoots(paseo: PaseoApi, root: string, keys: ProjectKeys): Promise<void> {
  for await (const workspace of allWorkspaces(paseo)) await markRootOf(workspace, root, keys);
}

// The repo (or folder) of every open Paseo workspace, with one checkout of each, after recording
// project roots. A project's main checkout is preferred over a worktree of a branch; a folder that is
// gone, and the plugin's own worker folders under `root`, are skipped.
export async function openRepoCheckouts(paseo: PaseoApi, root: string, keys: ProjectKeys): Promise<Map<string, string>> {
  const checkouts = new Map<string, string>();
  const seen = new Set<string>();
  for await (const workspace of allWorkspaces(paseo)) {
    await markRootOf(workspace, root, keys);
    for (const folder of [workspace.projectRootPath, workspace.workspaceDirectory]) {
      if (!folder || seen.has(folder) || isWorkerCwd(root, folder)) continue;
      seen.add(folder);
      const repoKey = await keys.keyOf(folder).catch(() => null);
      if (repoKey && !checkouts.has(repoKey)) checkouts.set(repoKey, folder);
    }
  }
  return checkouts;
}
