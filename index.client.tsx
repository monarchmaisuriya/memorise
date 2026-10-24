import type { PluginClientContext } from "@getpaseo/plugin/client";
import { ManagerScreen } from "./client/manager-screen";
import { memoryChanged } from "./client/memory-events";
import { MemoryPanel } from "./client/memory-panel";
import { ProposalsCard } from "./client/proposals-card";
import { parseRemember, REMEMBER_HINT } from "./client/remember";
import { MemorySettingsScreen } from "./client/settings-screen";
import { MemoriseSidebarItem } from "./client/sidebar-item";
import { listMemoriesRpc, PROPOSALS_CARD_KIND, proposalsCardSchema, saveMemoryRpc } from "./shared/memory";

export default function contribute(client: PluginClientContext) {
  const openManager = (repoKey: string | null) => client.openScreen({ screenId: "manager", params: repoKey ? { repo: repoKey } : {} });
  const removers = [
    client.addScreen({ id: "manager", title: (params) => (params.repo ? `Memorise: ${params.repo}` : "Memorise"), Component: ManagerScreen }),
    client.addSidebarHeaderItem({ id: "memorise", title: "Memorise", Component: MemoriseSidebarItem }),
    client.addWorkspacePanel({ id: "memory", title: "Memorise", icon: "Brain", context: "workspace", Component: (props) => <MemoryPanel {...props} openManager={openManager} /> }),
    client.addCommandCenterItem({
      id: "open-memory",
      title: "Open Memorise",
      icon: "Brain",
      keywords: ["memory", "remember", "notes"],
      context: "workspace",
      onSelect({ openPanel }) {
        openPanel("memory");
      },
    }),
    client.addCommandCenterItem({
      id: "open-manager-repo",
      title: "Open Memorise manager for this repo",
      icon: "Brain",
      keywords: ["memory", "memories", "manager"],
      context: "workspace",
      async onSelect({ workspace, rpc, openScreen }) {
        const { repoKey } = await rpc(listMemoriesRpc, { where: { directory: workspace.directory } });
        openScreen({ screenId: "manager", params: repoKey ? { repo: repoKey } : {} });
      },
    }),
    client.addCommandCenterItem({
      id: "open-manager",
      title: "Open Memorise manager",
      icon: "Brain",
      keywords: ["memory", "memories", "manager"],
      context: "global",
      onSelect({ openScreen }) {
        openScreen({ screenId: "manager" });
      },
    }),
    client.addSlashCommand({
      name: "remember",
      description: "Save a memory for agents in this repo (or --global for all repos)",
      argumentHint: REMEMBER_HINT,
      context: "workspace",
      async onSubmit({ args, workspace, rpc, openPanel }) {
        await rpc(saveMemoryRpc, { where: { directory: workspace.directory }, ...parseRemember(args) });
        memoryChanged();
        openPanel("memory");
      },
    }),
    client.addSettingsScreen({ id: "memory", title: "Memorise", icon: "Brain", Component: MemorySettingsScreen }),
    client.addTimelineRenderer({
      kind: PROPOSALS_CARD_KIND,
      version: 1,
      schema: proposalsCardSchema,
      Component: (props) => <ProposalsCard {...props} openPanel={(workspaceId) => client.openPanel("memory", { workspaceId })} />,
    }),
  ];
  return () => {
    for (const remove of removers) remove();
  };
}
