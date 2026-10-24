import { type PluginWorkspacePanelProps, useRpc, useWorkspace } from "@getpaseo/plugin/client";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { Pressable, ScrollView, Text, TextInput, View } from "react-native";
import type { z } from "zod";
import { deleteMemoryRpc, listMemoriesRpc, type MemoryType, memoryTypeSchema, pinMemoryRpc, restoreMemoryRpc, retireMemoryRpc, saveMemoryRpc, type Scope, updateMemoryRpc } from "../shared/memory";
import { Inbox } from "./inbox";
import { onMemoryChanged } from "./memory-events";
import { Button, Chip, type Styles, useStyles } from "./panel-ui";

type ListedFact = z.infer<typeof listMemoriesRpc.output>["facts"][number];
type Filter = "all" | Scope;

function FactCard({ fact, directory, styles, onChanged }: { fact: ListedFact; directory: string; styles: Styles; onChanged(): void }) {
  const update = useRpc(updateMemoryRpc);
  const retire = useRpc(retireMemoryRpc);
  const restore = useRpc(restoreMemoryRpc);
  const pin = useRpc(pinMemoryRpc);
  const remove = useRpc(deleteMemoryRpc);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(fact.body);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const action = useMutation({ mutationFn: (run: () => Promise<unknown>) => run(), onSuccess: onChanged });
  const current = fact.status === "active" && !fact.superseded;
  const state = fact.superseded ? "replaced" : fact.status === "retired" ? "retired" : fact.visibleToAgents ? null : "hidden from agents (unused)";
  const by = fact.source.by === "user" ? "you" : fact.source.by === "captured" ? `captured (${fact.source.provider ?? "agent"}), approved by you` : (fact.source.provider ?? "agent");
  const { shown, read, found } = fact.usage;
  return (
    <View style={styles.card}>
      <Text style={styles.body}>{fact.subject}</Text>
      <Text style={styles.muted}>
        {fact.type} · {fact.scope === "global" ? "global" : "this repo"} · {by} · {fact.created.slice(0, 10)}
        {fact.pinned ? " · pinned" : ""}
        {state ? ` · ${state}` : ""}
      </Text>
      <Text style={styles.muted}>
        shown to agents {shown}× · read {read}× · found by search {found}×
        {fact.paths.length > 0 ? ` · about ${fact.paths.join(", ")}` : ""}
      </Text>
      {editing ? (
        <TextInput accessibilityLabel="Memory text" multiline value={draft} onChangeText={setDraft} style={styles.input} />
      ) : (
        <Text style={styles.body}>{fact.body}</Text>
      )}
      {fact.citations.length > 0 && <Text style={styles.muted}>cites {fact.citations.map((c) => `${c.path}${c.lines ? `:${c.lines}` : ""}@${c.commit}`).join(", ")}</Text>}
      {action.error && <Text style={styles.danger}>{String(action.error instanceof Error ? action.error.message : action.error)}</Text>}
      <View style={styles.row}>
        {current && editing && (
          <Button
            label="Save"
            styles={styles}
            onPress={() => action.mutate(async () => {
              await update({ directory, id: fact.id, body: draft });
              setEditing(false);
            })}
          />
        )}
        {current && <Button label={editing ? "Cancel" : "Edit"} styles={styles} onPress={() => setEditing((value) => !value)} />}
        {current && <Button label={fact.pinned ? "Unpin" : "Pin"} styles={styles} onPress={() => action.mutate(() => pin({ directory, id: fact.id, pinned: !fact.pinned }))} />}
        {current && <Button label="Retire" styles={styles} onPress={() => action.mutate(() => retire({ directory, id: fact.id }))} />}
        {fact.status === "retired" && !fact.superseded && <Button label="Restore" styles={styles} onPress={() => action.mutate(() => restore({ directory, id: fact.id }))} />}
        <Button
          label={confirmDelete ? "Confirm delete" : "Delete"}
          tone="danger"
          styles={styles}
          onPress={() => (confirmDelete ? action.mutate(() => remove({ directory, id: fact.id })) : setConfirmDelete(true))}
        />
      </View>
    </View>
  );
}

function AddFact({ directory, hasRepo, styles, onChanged }: { directory: string; hasRepo: boolean; styles: Styles; onChanged(): void }) {
  const save = useRpc(saveMemoryRpc);
  const [body, setBody] = useState("");
  const [scope, setScope] = useState<Scope>(hasRepo ? "repo" : "global");
  const [type, setType] = useState<MemoryType>("reference");
  const mutation = useMutation({
    mutationFn: () => {
      const text = body.trim();
      return save({ directory, scope, type, subject: text.split("\n")[0].slice(0, 80), body: text });
    },
    onSuccess: () => {
      setBody("");
      onChanged();
    },
  });
  return (
    <View style={styles.card}>
      <Text style={styles.body}>Add a memory</Text>
      <TextInput accessibilityLabel="New memory text" multiline value={body} onChangeText={setBody} placeholder="One durable fact, no secrets" style={styles.input} />
      <View style={styles.row}>
        {hasRepo && <Chip label="This repo" on={scope === "repo"} onPress={() => setScope("repo")} styles={styles} />}
        <Chip label="Global" on={scope === "global"} onPress={() => setScope("global")} styles={styles} />
      </View>
      <View style={styles.row}>
        {memoryTypeSchema.options.map((option) => (
          <Chip key={option} label={option} on={type === option} onPress={() => setType(option)} styles={styles} />
        ))}
      </View>
      {mutation.error && <Text style={styles.danger}>{mutation.error.message}</Text>}
      <Pressable accessibilityRole="button" accessibilityLabel="Save memory" disabled={body.trim() === "" || mutation.isPending} onPress={() => mutation.mutate()} style={styles.primary}>
        <Text style={styles.primaryText}>{mutation.isPending ? "Saving" : "Save"}</Text>
      </Pressable>
    </View>
  );
}

export function MemoryPanel({ theme, layout, workspaceId }: PluginWorkspacePanelProps) {
  const styles = useStyles(theme, layout.compact);
  const directory = useWorkspace(workspaceId, (workspace) => workspace.directory);
  const list = useRpc(listMemoriesRpc);
  const queryClient = useQueryClient();
  const [tab, setTab] = useState<"memories" | "proposed">("memories");
  const [filter, setFilter] = useState<Filter>("all");
  const [showHistory, setShowHistory] = useState(false);
  const query = useQuery({ queryKey: ["agent-memory", directory], queryFn: () => list({ directory: directory ?? "" }), enabled: directory !== null });
  const refresh = () => void queryClient.invalidateQueries({ queryKey: ["agent-memory", directory] });
  useEffect(() => onMemoryChanged(() => void queryClient.invalidateQueries({ queryKey: ["agent-memory"] })), [queryClient]);

  if (directory === null || query.isPending) return <View style={[styles.screen, styles.content]}><Text style={styles.muted}>Loading memories</Text></View>;
  if (query.error) return <View style={[styles.screen, styles.content]}><Text style={styles.danger}>{query.error.message}</Text></View>;

  const { repoKey, facts } = query.data;
  const shown = facts.filter((fact) => (filter === "all" || fact.scope === filter) && (showHistory || (fact.status === "active" && !fact.superseded)));
  return (
    <ScrollView style={styles.screen} contentContainerStyle={styles.content}>
      <Text style={styles.title}>Agent memory</Text>
      <Text style={styles.muted}>{repoKey ? `Repo ${repoKey}, plus global memories. Shared by every workspace of this repo.` : "This folder is not in a git repo; only global memories apply."}</Text>
      <View style={styles.row}>
        <Chip label="Memories" on={tab === "memories"} onPress={() => setTab("memories")} styles={styles} />
        {repoKey && <Chip label="Proposed" on={tab === "proposed"} onPress={() => setTab("proposed")} styles={styles} />}
      </View>
      {tab === "proposed" && repoKey ? (
        <Inbox directory={directory} styles={styles} onChanged={refresh} />
      ) : (
      <>
      <AddFact directory={directory} hasRepo={repoKey !== null} styles={styles} onChanged={refresh} />
      <View style={styles.row}>
        <Chip label="All" on={filter === "all"} onPress={() => setFilter("all")} styles={styles} />
        {repoKey && <Chip label="This repo" on={filter === "repo"} onPress={() => setFilter("repo")} styles={styles} />}
        <Chip label="Global" on={filter === "global"} onPress={() => setFilter("global")} styles={styles} />
        <Chip label="Show retired and replaced" on={showHistory} onPress={() => setShowHistory((value) => !value)} styles={styles} />
      </View>
      {shown.length === 0 && <Text style={styles.muted}>No memories here yet.</Text>}
      {shown.map((fact) => (
        <FactCard key={fact.id} fact={fact} directory={directory} styles={styles} onChanged={refresh} />
      ))}
      </>
      )}
    </ScrollView>
  );
}
