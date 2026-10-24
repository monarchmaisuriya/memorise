import { useRpc } from "@getpaseo/plugin/client";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { Pressable, Text, TextInput, View } from "react-native";
import { exportMemoryRpc, getRepoPrefsRpc, importMemoryRpc, previewMemoryRpc, type RepoPrefsValue, type Scope, setRepoPrefsRpc, type Where } from "../shared/memory";
import { memoryChanged } from "./memory-events";
import { Button, Chip, type Styles } from "./panel-ui";

// The repo's own switches, shared by every worktree of the repo.
export function RepoPrefsCard({ repoKey, styles }: { repoKey: string; styles: Styles }) {
  const get = useRpc(getRepoPrefsRpc);
  const set = useRpc(setRepoPrefsRpc);
  const queryClient = useQueryClient();
  const key = ["memorise", "repo-prefs", repoKey];
  const query = useQuery({ queryKey: key, queryFn: () => get({ repoKey }) });
  const mutation = useMutation({
    mutationFn: (prefs: RepoPrefsValue) => set({ repoKey, prefs }),
    onSuccess: (result) => queryClient.setQueryData(key, result),
  });
  if (query.isPending) return <Text style={styles.muted}>Loading repo settings</Text>;
  if (query.error) return <Text style={styles.danger}>{query.error.message}</Text>;
  const prefs = query.data.prefs;
  const change = (next: Partial<RepoPrefsValue>) => mutation.mutate({ ...prefs, ...next });
  return (
    <View style={styles.card}>
      <Text style={styles.body}>This repo, for new agents</Text>
      <View style={styles.row}>
        <Chip label={prefs.enabled ? "Memory on" : "Memory off"} on={prefs.enabled} onPress={() => change({ enabled: !prefs.enabled })} styles={styles} />
        <Chip label={prefs.includeGlobal ? "Includes global memories" : "Repo memories only"} on={prefs.includeGlobal} onPress={() => change({ includeGlobal: !prefs.includeGlobal })} styles={styles} />
      </View>
      <View style={styles.row}>
        <Text style={styles.muted}>Capture:</Text>
        {(["default", "on", "off"] as const).map((value) => (
          <Chip key={value} label={value === "default" ? "Host setting" : value === "on" ? "On here" : "Off here"} on={prefs.capture === value} onPress={() => change({ capture: value })} styles={styles} />
        ))}
      </View>
      {mutation.error && <Text style={styles.danger}>{mutation.error.message}</Text>}
    </View>
  );
}

// Export as Markdown (for reading) or JSON (keeps paths and controls); import either, or lines
// copied from an assistant's memory export. Import always checks first.
export function TransferCard({ where, scope, styles }: { where: Where; scope: Scope; styles: Styles }) {
  const exportMemory = useRpc(exportMemoryRpc);
  const importMemory = useRpc(importMemoryRpc);
  const [format, setFormat] = useState<"markdown" | "json">("markdown");
  const [text, setText] = useState("");
  const exported = useMutation({ mutationFn: () => exportMemory({ where, format }) });
  const checked = useMutation({ mutationFn: () => importMemory({ where, scope, text, dryRun: true }) });
  const imported = useMutation({
    mutationFn: () => importMemory({ where, scope, text, dryRun: false }),
    onSuccess: () => {
      memoryChanged();
      checked.reset();
      setText("");
    },
  });
  return (
    <View style={styles.card}>
      <Text style={styles.body}>Export</Text>
      <View style={styles.row}>
        <Chip label="Markdown" on={format === "markdown"} onPress={() => setFormat("markdown")} styles={styles} />
        <Chip label="JSON" on={format === "json"} onPress={() => setFormat("json")} styles={styles} />
        <Button label="Export" styles={styles} onPress={() => exported.mutate()} />
      </View>
      {exported.data && (
        <>
          <Text style={styles.muted}>
            {exported.data.count} {exported.data.count === 1 ? "memory" : "memories"}. Select the text to copy it.
          </Text>
          <TextInput accessibilityLabel="Exported memories" multiline editable={false} selectTextOnFocus value={exported.data.text} style={[styles.input, { minHeight: 120, fontFamily: "monospace" }]} />
        </>
      )}
      {exported.error && <Text style={styles.danger}>{exported.error.message}</Text>}
      <Text style={styles.body}>Import into {scope === "global" ? "global memory" : "this repo"}</Text>
      <TextInput
        accessibilityLabel="Memories to import"
        multiline
        value={text}
        onChangeText={(value) => {
          setText(value);
          checked.reset();
        }}
        placeholder={"- [howto] build: Run make build.\nor a Memorise JSON export, or [2026-03-02] - lines from an assistant's memory"}
        style={[styles.input, { minHeight: 100 }]}
      />
      <View style={styles.row}>
        <Button label="Check" styles={styles} onPress={() => checked.mutate()} />
        {checked.data && checked.data.added.length > 0 && (
          <Pressable accessibilityRole="button" accessibilityLabel="Import checked memories" onPress={() => imported.mutate()} style={styles.primary}>
            <Text style={styles.primaryText}>{imported.isPending ? "Importing" : `Import ${checked.data.added.length}`}</Text>
          </Pressable>
        )}
      </View>
      {checked.data && (
        <Text style={styles.muted}>
          {checked.data.added.length} to add · {checked.data.skipped.length} skipped
        </Text>
      )}
      {checked.data?.skipped.map((entry) => (
        <Text key={`${entry.line}-${entry.reason}`} style={styles.muted}>
          skipped "{entry.line.slice(0, 60)}": {entry.reason}
        </Text>
      ))}
      {imported.data && <Text style={styles.muted}>Imported {imported.data.added.length}.</Text>}
      {(checked.error ?? imported.error) && <Text style={styles.danger}>{(checked.error ?? imported.error)?.message}</Text>}
    </View>
  );
}

const REASON_LABEL = { pinned: "pinned", files: "about files this worktree changed", global: "global", repo: "this repo" } as const;

// Exactly what a new agent started in this workspace now would be given, and why.
export function PreviewCard({ directory, styles }: { directory: string; styles: Styles }) {
  const preview = useRpc(previewMemoryRpc);
  const query = useQuery({ queryKey: ["memorise", "preview", directory], queryFn: () => preview({ directory }) });
  const [showText, setShowText] = useState(false);
  if (query.isPending) return <Text style={styles.muted}>Building the preview</Text>;
  if (query.error) return <Text style={styles.danger}>{query.error.message}</Text>;
  const { off, listed, bytes, text } = query.data;
  if (off) return <Text style={styles.muted}>Memory is off for this repo: new agents get no memories and no memory tools.</Text>;
  return (
    <View style={styles.card}>
      <Text style={styles.body}>
        A new agent here gets {listed.length} {listed.length === 1 ? "memory" : "memories"} ({bytes} bytes)
      </Text>
      {listed.map((item) => (
        <Text key={item.id} style={styles.muted}>
          {item.subject} · {REASON_LABEL[item.reason]}
          {item.titleOnly ? " · title only" : ""}
        </Text>
      ))}
      <View style={styles.row}>
        <Button label={showText ? "Hide prompt text" : "Show prompt text"} styles={styles} onPress={() => setShowText((value) => !value)} />
      </View>
      {showText && <Text style={[styles.muted, { fontFamily: "monospace" }]}>{text}</Text>}
    </View>
  );
}
