import { type PluginTimelineItemProps, useAgent, useRpc, useWorkspace } from "@getpaseo/plugin/client";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Pressable, Text, View } from "react-native";
import type { z } from "zod";
import { approveProposalRpc, listProposalsRpc, type proposalsCardSchema, rejectProposalRpc } from "../shared/memory";
import { memoryChanged } from "./memory-events";

type CardData = z.infer<typeof proposalsCardSchema>;
type Theme = PluginTimelineItemProps<CardData>["theme"];

function action(theme: Theme, primary: boolean) {
  return { alignSelf: "flex-start" as const, borderRadius: 8, paddingHorizontal: 12, paddingVertical: 6, backgroundColor: primary ? theme.colors.accent : theme.colors.surface2 };
}

// This session's proposals that are still waiting, each with Approve and Reject.
function Pending({ agentId, workspaceId, theme, openPanel }: { agentId: string; workspaceId: string; theme: Theme; openPanel(workspaceId: string): void }) {
  const directory = useWorkspace(workspaceId, (workspace) => workspace.directory);
  const list = useRpc(listProposalsRpc);
  const approve = useRpc(approveProposalRpc);
  const reject = useRpc(rejectProposalRpc);
  const queryClient = useQueryClient();
  const query = useQuery({ queryKey: ["memorise-proposals", directory], queryFn: () => list({ directory: directory ?? "" }), enabled: directory !== null });
  const decide = useMutation({
    mutationFn: async ({ id, approved }: { id: string; approved: boolean }) => {
      if (approved) await approve({ directory: directory ?? "", id });
      else await reject({ directory: directory ?? "", id });
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["memorise-proposals"] });
      memoryChanged();
    },
  });
  const muted = { color: theme.colors.foregroundMuted, fontSize: 13 };
  if (query.isPending) return <Text style={muted}>Loading proposals</Text>;
  if (query.error) return <Text style={{ color: theme.colors.statusDanger, fontSize: 13 }}>{query.error.message}</Text>;
  const mine = query.data.proposals.filter((proposal) => proposal.source.agentId === agentId);
  return (
    <View style={{ gap: 8 }}>
      {mine.length === 0 && <Text style={muted}>All reviewed.</Text>}
      {mine.map((proposal) => (
        <View key={proposal.id} style={{ gap: 4 }}>
          <Text style={{ color: theme.colors.foreground, fontSize: 13 }}>
            {proposal.subject}: {proposal.body}
          </Text>
          <View style={{ flexDirection: "row", gap: 8 }}>
            <Pressable accessibilityRole="button" accessibilityLabel={`Approve ${proposal.subject}`} onPress={() => decide.mutate({ id: proposal.id, approved: true })} style={action(theme, true)}>
              <Text style={{ color: theme.colors.accentForeground, fontSize: 13 }}>Approve</Text>
            </Pressable>
            <Pressable accessibilityRole="button" accessibilityLabel={`Reject ${proposal.subject}`} onPress={() => decide.mutate({ id: proposal.id, approved: false })} style={action(theme, false)}>
              <Text style={{ color: theme.colors.foreground, fontSize: 13 }}>Reject</Text>
            </Pressable>
          </View>
        </View>
      ))}
      {decide.error && <Text style={{ color: theme.colors.statusDanger, fontSize: 13 }}>{decide.error.message}</Text>}
      <Pressable accessibilityRole="button" accessibilityLabel="Edit proposed memories in the panel" onPress={() => openPanel(workspaceId)} style={action(theme, false)}>
        <Text style={{ color: theme.colors.foreground, fontSize: 13 }}>Edit in the panel</Text>
      </Pressable>
    </View>
  );
}

// Shown in the source agent's chat after a capture pass; the model never sees it.
export function ProposalsCard({ agentId, item, theme, openPanel }: PluginTimelineItemProps<CardData> & { openPanel(workspaceId: string): void }) {
  const { count } = item.data;
  const workspaceId = useAgent(agentId, (agent) => agent.workspaceId);
  return (
    <View style={{ borderWidth: 1, borderColor: theme.colors.border, borderRadius: 10, padding: 10, gap: 6, backgroundColor: theme.colors.surface1 }}>
      <Text style={{ color: theme.colors.foreground, fontSize: 14 }}>
        {count === 1 ? "1 memory proposed" : `${count} memories proposed`} from this session. Nothing reaches agents until you approve it.
      </Text>
      {workspaceId ? (
        <Pending agentId={agentId} workspaceId={workspaceId} theme={theme} openPanel={openPanel} />
      ) : (
        <Text style={{ color: theme.colors.foregroundMuted, fontSize: 13 }}>Review them in the Memorise panel of this repo's workspace.</Text>
      )}
    </View>
  );
}
