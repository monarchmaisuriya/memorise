import { type PluginTimelineItemProps, useAgent } from "@getpaseo/plugin/client";
import { Pressable, Text, View } from "react-native";
import type { z } from "zod";
import type { proposalsCardSchema } from "../shared/memory";

type CardData = z.infer<typeof proposalsCardSchema>;

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
      <Pressable accessibilityRole="button" accessibilityLabel="Review proposed memories" onPress={() => openPanel(workspaceId)} style={{ alignSelf: "flex-start", borderRadius: 8, paddingHorizontal: 12, paddingVertical: 6, backgroundColor: theme.colors.accent }}>
        <Text style={{ color: theme.colors.accentForeground, fontSize: 13 }}>Review</Text>
      </Pressable>
      ) : (
        <Text style={{ color: theme.colors.foregroundMuted, fontSize: 13 }}>Review them in the Memorise panel of this repo's workspace.</Text>
      )}
    </View>
  );
}
