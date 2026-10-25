import type { PluginTimelineItemProps } from "@getpaseo/plugin/client";
import { Text, View } from "react-native";
import type { Receipt } from "../shared/memory";
import { receiptText } from "./copy";

// One quiet line in an agent's chat: the memories its prompt listed, and how it has used them. The
// model never sees it.
export function ReceiptCard({ item, theme }: PluginTimelineItemProps<Receipt>) {
  return (
    <View accessibilityRole="text" style={{ paddingVertical: 4 }}>
      <Text style={{ color: theme.colors.foregroundMuted, fontSize: 12 }}>Memorise · {receiptText(item.data)}</Text>
    </View>
  );
}
