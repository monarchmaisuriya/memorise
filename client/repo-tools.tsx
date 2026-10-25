import { useRpc } from "@getpaseo/plugin/client";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { SettingsCard, SettingsSelect, SettingsSwitch } from "@getpaseo/plugin/client/ui";
import { useState } from "react";
import { Pressable, Text, TextInput, View } from "react-native";
import { exportMemoryRpc, getRepoPrefsRpc, importMemoryRpc, previewMemoryRpc, type RepoPrefsValue, type Scope, setRepoPrefsRpc, type Where } from "../shared/memory";
import { memoryChanged } from "./memory-events";
import { Button, Chip, type Styles } from "./panel-ui";
import { count, errorText } from "./copy";

const SESSION_SUGGESTIONS = [
  { label: "Use global setting", value: "default" as const },
  { label: "On", value: "on" as const },
  { label: "Off", value: "off" as const },
];

// The project's own settings, shared by every worktree of it. Each applies at once.
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
  if (query.isPending) return <Text style={styles.muted}>Loading project settings</Text>;
  if (query.error) return <Text style={styles.danger}>{errorText(query.error)}</Text>;
  const prefs = query.data.prefs;
  const change = (next: Partial<RepoPrefsValue>) => mutation.mutate({ ...prefs, ...next });
  return (
    <SettingsCard>
      <SettingsSwitch
        label="Memory for this project"
        hint={prefs.enabled ? "New agents here get memories and the memory tools." : "New agents here get no memories and no memory tools. Saved memories are kept."}
        value={prefs.enabled}
        disabled={mutation.isPending}
        onValueChange={(enabled) => change({ enabled })}
      />
      <SettingsSwitch
        label="Include global memories"
        hint={prefs.includeGlobal ? "Agents here also see your global memories." : "Agents here see only this project's memories."}
        value={prefs.includeGlobal}
        disabled={mutation.isPending}
        onValueChange={(includeGlobal) => change({ includeGlobal })}
      />
      <SettingsSelect
        label="Suggestions from sessions"
        hint="Whether finished sessions here suggest memories. “Use global setting” follows Settings."
        value={prefs.capture}
        options={SESSION_SUGGESTIONS}
        disabled={mutation.isPending}
        onValueChange={(capture) => change({ capture })}
      />
      <SettingsSwitch
        label="Save suggestions without review"
        hint={
          prefs.autoApprove
            ? "New memories suggested by sessions and project files are saved straight away. Rewrites, archives, and clean-ups still wait for you."
            : "Every suggestion waits for your review, which keeps unhelpful memories out of agents' prompts."
        }
        value={prefs.autoApprove}
        disabled={mutation.isPending}
        onValueChange={(autoApprove) => change({ autoApprove })}
        error={mutation.error ? errorText(mutation.error) : null}
      />
    </SettingsCard>
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
      <Text style={styles.body}>Export memories</Text>
      <Text style={styles.muted}>Markdown is easy to read; JSON keeps files and visibility settings.</Text>
      <View style={styles.row}>
        <Chip label="Markdown" on={format === "markdown"} onPress={() => setFormat("markdown")} styles={styles} />
        <Chip label="JSON" on={format === "json"} onPress={() => setFormat("json")} styles={styles} />
        <Button label="Export" styles={styles} onPress={() => exported.mutate()} />
      </View>
      {exported.data && (
        <>
          <Text style={styles.muted}>
            Exported {count(exported.data.count, "memory", "memories")}. Select the text to copy it.
          </Text>
          <TextInput accessibilityLabel="Exported memories" multiline editable={false} selectTextOnFocus value={exported.data.text} style={[styles.input, { minHeight: 120, fontFamily: "monospace" }]} />
        </>
      )}
      {exported.error && <Text style={styles.danger}>{errorText(exported.error)}</Text>}
      <Text style={styles.body}>Import into {scope === "global" ? "global memories" : "this project"}</Text>
      <Text style={styles.muted}>Paste a Memorise export, or lines from another assistant's memory. Nothing is saved until you import.</Text>
      <TextInput
        accessibilityLabel="Memories to import"
        multiline
        value={text}
        onChangeText={(value) => {
          setText(value);
          checked.reset();
        }}
        placeholderTextColor={styles.muted.color} placeholder={"- [howto] build: Run make build."}
        style={[styles.input, { minHeight: 100 }]}
      />
      <View style={styles.row}>
        <Button label="Preview import" styles={styles} onPress={() => checked.mutate()} />
        {checked.data && checked.data.added.length > 0 && (
          <Pressable accessibilityRole="button" accessibilityLabel="Import checked memories" onPress={() => imported.mutate()} style={styles.primary}>
            <Text style={styles.primaryText}>{imported.isPending ? "Importing" : `Import ${count(checked.data.added.length, "memory", "memories")}`}</Text>
          </Pressable>
        )}
      </View>
      {checked.data && (
        <Text style={styles.muted}>
          {count(checked.data.added.length, "memory", "memories")} to add · {checked.data.skipped.length} skipped
        </Text>
      )}
      {checked.data?.skipped.map((entry) => (
        <Text key={`${entry.line}-${entry.reason}`} style={styles.muted}>
          Skipped “{entry.line.slice(0, 60)}”: {entry.reason}
        </Text>
      ))}
      {imported.data && <Text style={styles.muted}>Imported {count(imported.data.added.length, "memory", "memories")}.</Text>}
      {(checked.error ?? imported.error) && <Text style={styles.danger}>{errorText(checked.error ?? imported.error)}</Text>}
    </View>
  );
}

const REASON_LABEL = { pinned: "Pinned", files: "About files this workspace changed", global: "Global", repo: "This project" } as const;

// Exactly what a new agent started in this workspace now would be given, and why.
export function PreviewCard({ directory, styles }: { directory: string; styles: Styles }) {
  const preview = useRpc(previewMemoryRpc);
  const query = useQuery({ queryKey: ["memorise", "preview", directory], queryFn: () => preview({ directory }) });
  const [showText, setShowText] = useState(false);
  if (query.isPending) return <Text style={styles.muted}>Building the preview</Text>;
  if (query.error) return <Text style={styles.danger}>{errorText(query.error)}</Text>;
  const { off, listed, bytes, text, maxLines, maxBytes } = query.data;
  if (off) return <Text style={styles.muted}>Memory is off for this project, so new agents here get no memories and no memory tools.</Text>;
  return (
    <View style={styles.card}>
      <Text style={styles.body}>
        A new agent here sees {count(listed.length, "memory", "memories")}
      </Text>
      <Text style={styles.muted}>
        Prompt space used: {listed.length} of {maxLines} lines, {(bytes / 1024).toFixed(1)} of {(maxBytes / 1024).toFixed(0)} KB
      </Text>
      {listed.map((item) => (
        <Text key={item.id} style={styles.muted}>
          {item.subject} · {REASON_LABEL[item.reason]}
          {item.titleOnly ? " · Title only" : ""}
        </Text>
      ))}
      <View style={styles.row}>
        <Button label={showText ? "Hide prompt text" : "Show prompt text"} styles={styles} onPress={() => setShowText((value) => !value)} />
      </View>
      {showText && <Text style={[styles.muted, { fontFamily: "monospace" }]}>{text}</Text>}
    </View>
  );
}
