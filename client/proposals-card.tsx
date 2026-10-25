import { type PluginTimelineItemProps, useAgent, useRpc, useWorkspace } from "@getpaseo/plugin/client";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { Pressable, Text, View } from "react-native";
import type { z } from "zod";
import { approveProposalRpc, listProposalsRpc, type proposalsCardSchema, rejectProposalRpc } from "../shared/memory";
import { memoryChanged } from "./memory-events";
import { errorText } from "./copy";

type CardData = z.infer<typeof proposalsCardSchema>;
type Theme = PluginTimelineItemProps<CardData>["theme"];

// A small text action; the padding keeps it easy to tap.
function TextAction({ label, accessibilityLabel, color, onPress }: { label: string; accessibilityLabel: string; color: string; onPress(): void }) {
  return (
    <Pressable accessibilityRole="button" accessibilityLabel={accessibilityLabel} onPress={onPress} hitSlop={6} style={{ paddingHorizontal: 4, paddingVertical: 4 }}>
      <Text style={{ color, fontSize: 13 }}>{label}</Text>
    </Pressable>
  );
}

// One suggestion on one line: its title, then Approve and Reject. Tapping the title shows its text.
function Suggestion({ subject, body, theme, onDecide }: { subject: string; body: string; theme: Theme; onDecide(approved: boolean): void }) {
  const [open, setOpen] = useState(false);
  return (
    <View style={{ gap: 2 }}>
      <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
        <Pressable accessibilityRole="button" accessibilityLabel={open ? `Hide the text of ${subject}` : `Show the text of ${subject}`} onPress={() => setOpen((value) => !value)} style={{ flexShrink: 1, flexGrow: 1 }}>
          <Text style={{ color: theme.colors.foreground, fontSize: 13 }} numberOfLines={open ? undefined : 1}>
            {subject}
          </Text>
        </Pressable>
        <TextAction label="Approve" accessibilityLabel={`Approve ${subject}`} color={theme.colors.accent} onPress={() => onDecide(true)} />
        <TextAction label="Reject" accessibilityLabel={`Reject ${subject}`} color={theme.colors.foregroundMuted} onPress={() => onDecide(false)} />
      </View>
      {open && <Text style={{ color: theme.colors.foregroundMuted, fontSize: 13 }}>{body}</Text>}
    </View>
  );
}

// This session's proposals that are still waiting, each with Approve and Reject.
function Pending({ agentId, workspaceId, theme }: { agentId: string; workspaceId: string; theme: Theme }) {
  const directory = useWorkspace(workspaceId, (workspace) => workspace.directory);
  const list = useRpc(listProposalsRpc);
  const approve = useRpc(approveProposalRpc);
  const reject = useRpc(rejectProposalRpc);
  const queryClient = useQueryClient();
  const where = { directory: directory ?? "" };
  const query = useQuery({ queryKey: ["memorise-proposals", where], queryFn: () => list({ where }), enabled: directory !== null });
  const decide = useMutation({
    mutationFn: async ({ id, approved }: { id: string; approved: boolean }) => {
      if (approved) await approve({ where, id });
      else await reject({ where, id });
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["memorise-proposals"] });
      memoryChanged();
    },
  });
  const muted = { color: theme.colors.foregroundMuted, fontSize: 13 };
  if (query.isPending) return <Text style={muted}>Loading suggestions</Text>;
  if (query.error) return <Text style={{ color: theme.colors.statusDanger, fontSize: 13 }}>{errorText(query.error)}</Text>;
  const mine = query.data.proposals.filter((proposal) => proposal.source.agentId === agentId);
  return (
    <View style={{ gap: 4 }}>
      {mine.length === 0 && <Text style={muted}>All reviewed.</Text>}
      {mine.map((proposal) => (
        <Suggestion key={proposal.id} subject={proposal.subject} body={proposal.body} theme={theme} onDecide={(approved) => decide.mutate({ id: proposal.id, approved })} />
      ))}
      {decide.error && <Text style={{ color: theme.colors.statusDanger, fontSize: 13 }}>{errorText(decide.error)}</Text>}
    </View>
  );
}

// Shown in the source agent's chat after a capture pass; the model never sees it.
export function ProposalsCard({ agentId, item, theme, openPanel }: PluginTimelineItemProps<CardData> & { openPanel(workspaceId: string): void }) {
  const { count, autoSaved } = item.data;
  const workspaceId = useAgent(agentId, (agent) => agent.workspaceId);
  return (
    <View style={{ borderWidth: 1, borderColor: theme.colors.border, borderRadius: 10, paddingHorizontal: 12, paddingVertical: 8, gap: 6 }}>
      <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
        <Text style={{ color: theme.colors.foregroundMuted, fontSize: 12, flexShrink: 1, flexGrow: 1 }}>
          {[count > 0 ? `${count === 1 ? "1 suggested memory" : `${count} suggested memories`} · agents see them once approved` : null, autoSaved > 0 ? `${autoSaved} saved without review` : null].filter(Boolean).join(" · ")}
        </Text>
        {workspaceId && <TextAction label="Edit in Memorise" accessibilityLabel="Edit suggestions in the Memorise panel" color={theme.colors.foregroundMuted} onPress={() => openPanel(workspaceId)} />}
      </View>
      {workspaceId ? (
        <Pending agentId={agentId} workspaceId={workspaceId} theme={theme} />
      ) : (
        <Text style={{ color: theme.colors.foregroundMuted, fontSize: 13 }}>Review them in Memorise, under Suggestions.</Text>
      )}
    </View>
  );
}
