import type { PluginWorkspacePanelProps } from "@getpaseo/plugin/client";
import { useMemo } from "react";
import { Pressable, Text, View } from "react-native";

type Theme = PluginWorkspacePanelProps["theme"];
export function useStyles(theme: Theme, compact: boolean) {
  return useMemo(
    () => ({
      screen: { flex: 1, backgroundColor: theme.colors.surface0 },
      content: { padding: compact ? 12 : 20, gap: 12 },
      title: { color: theme.colors.foreground, fontSize: compact ? 18 : 20, fontWeight: "600" as const },
      muted: { color: theme.colors.foregroundMuted, fontSize: 13 },
      body: { color: theme.colors.foreground, fontSize: 14 },
      danger: { color: theme.colors.statusDanger, fontSize: 13 },
      card: { borderWidth: 1, borderColor: theme.colors.border, borderRadius: 10, padding: 12, gap: 6, backgroundColor: theme.colors.surface1 },
      row: { flexDirection: "row" as const, flexWrap: "wrap" as const, gap: 8, alignItems: "center" as const },
      input: { borderWidth: 1, borderColor: theme.colors.border, borderRadius: 8, padding: 10, color: theme.colors.foreground, backgroundColor: theme.colors.surface0, minHeight: 60, textAlignVertical: "top" as const },
      chip: { borderWidth: 1, borderColor: theme.colors.border, borderRadius: 999, paddingHorizontal: 10, paddingVertical: 4 },
      chipOn: { borderColor: theme.colors.accent, backgroundColor: theme.colors.accent },
      chipText: { color: theme.colors.foreground, fontSize: 13 },
      chipTextOn: { color: theme.colors.accentForeground, fontSize: 13 },
      button: { borderRadius: 8, paddingHorizontal: 12, paddingVertical: 6, backgroundColor: theme.colors.surface2 },
      primary: { borderRadius: 8, paddingHorizontal: 12, paddingVertical: 8, backgroundColor: theme.colors.accent, alignSelf: "flex-start" as const },
      primaryText: { color: theme.colors.accentForeground, fontSize: 14 },
      badge: { borderWidth: 1, borderColor: theme.colors.border, borderRadius: 6, paddingHorizontal: 6, paddingVertical: 1 },
      badgeText: { color: theme.colors.foregroundMuted, fontSize: 12 },
      label: { color: theme.colors.foregroundMuted, fontSize: 12, fontWeight: "600" as const, textTransform: "uppercase" as const, letterSpacing: 0.5 },
      nav: { borderRadius: 8, paddingHorizontal: 10, paddingVertical: 8, gap: 2 },
      navOn: { backgroundColor: theme.colors.surface2 },
    }),
    [theme, compact],
  );
}
export type Styles = ReturnType<typeof useStyles>;

export function Chip({ label, on, onPress, styles }: { label: string; on: boolean; onPress(): void; styles: Styles }) {
  return (
    <Pressable accessibilityRole="button" accessibilityState={{ selected: on }} onPress={onPress} style={[styles.chip, on && styles.chipOn]}>
      <Text style={on ? styles.chipTextOn : styles.chipText}>{label}</Text>
    </Pressable>
  );
}

export function Badge({ label, styles }: { label: string; styles: Styles }) {
  return (
    <View style={styles.badge}>
      <Text style={styles.badgeText}>{label}</Text>
    </View>
  );
}

export function Button({ label, onPress, styles, tone, disabled = false }: { label: string; onPress(): void; styles: Styles; tone?: "danger"; disabled?: boolean }) {
  return (
    <Pressable accessibilityRole="button" accessibilityLabel={label} accessibilityState={{ disabled }} disabled={disabled} onPress={onPress} style={styles.button}>
      <Text style={disabled ? styles.muted : tone === "danger" ? styles.danger : styles.chipText}>{label}</Text>
    </Pressable>
  );
}
