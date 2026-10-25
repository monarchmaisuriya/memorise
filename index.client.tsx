import type { PluginClientContext } from "@getpaseo/plugin/client";
import { projectName } from "./client/copy";
import { ManagerScreen } from "./client/manager-screen";
import { memoryChanged } from "./client/memory-events";
import { MemoryPanel } from "./client/memory-panel";
import { ProposalsCard } from "./client/proposals-card";
import { ReceiptCard } from "./client/receipt-card";
import { parseRemember, REMEMBER_HINT } from "./client/remember";
import { MemorySettingsScreen } from "./client/settings-screen";
import { MemoriseSidebarItem } from "./client/sidebar-item";
import { listMemoriesRpc, PROPOSALS_CARD_KIND, proposalsCardSchema, RECEIPT_KIND, receiptSchema, saveMemoryRpc } from "./shared/memory";

export default function contribute(client: PluginClientContext) {
  const openManager = (repoKey: string | null) => client.openScreen({ screenId: "manager", params: repoKey ? { repo: repoKey } : {} });
  const removers = [
    client.addScreen({ id: "manager", title: (params) => (params.repo ? `Memorise: ${projectName(params.repo)}` : "Memorise"), Component: ManagerScreen }),
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
      title: "Open Memorise for this project",
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
      title: "Open Memorise for all projects",
      icon: "Brain",
      keywords: ["memory", "memories", "manager"],
      context: "global",
      onSelect({ openScreen }) {
        openScreen({ screenId: "manager" });
      },
    }),
    client.addSlashCommand({
      name: "remember",
      description: "Save a memory for agents in this project (add --global for every project)",
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
    client.addTimelineRenderer({ kind: RECEIPT_KIND, version: 1, schema: receiptSchema, Component: ReceiptCard }),
  ];
  return () => {
    for (const remove of removers) remove();
  };
}
