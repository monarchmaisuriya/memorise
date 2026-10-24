import type { PluginClientContext } from "@getpaseo/plugin/client";
import { ProposalsCard } from "./client/proposals-card";
import { memoryChanged } from "./client/memory-events";
import { MemoryPanel } from "./client/memory-panel";
import { parseRemember, REMEMBER_HINT } from "./client/remember";
import { MemorySettingsScreen } from "./client/settings-screen";
import { PROPOSALS_CARD_KIND, proposalsCardSchema, saveMemoryRpc } from "./shared/memory";

export default function contribute(client: PluginClientContext) {
  const removers = [
    client.addWorkspacePanel({ id: "memory", title: "Memorise", icon: "Brain", context: "workspace", Component: MemoryPanel }),
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
