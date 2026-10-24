import { useRpc } from "@getpaseo/plugin/client";
import { useMutation, useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { Text, View } from "react-native";
import type { z } from "zod";
import {
  deleteMemoryRpc,
  type listMemoriesRpc,
  memoryHistoryRpc,
  moveMemoryRpc,
  pinMemoryRpc,
  restoreMemoryRpc,
  retireMemoryRpc,
  revertMemoryRpc,
  updateMemoryRpc,
  type Where,
} from "../shared/memory";
import { ACTIVATION_LABEL, FactEditor } from "./fact-editor";
import { memoryChanged } from "./memory-events";
import { Button, Chip, type Styles } from "./panel-ui";

export type ListedFact = z.infer<typeof listMemoriesRpc.output>["facts"][number];

export function isEnded(fact: ListedFact, now = Date.now()): boolean {
  return fact.until !== null && now >= Date.parse(fact.until) + 24 * 60 * 60 * 1000;
}

function History({ fact, where, styles }: { fact: ListedFact; where: Where; styles: Styles }) {
  const history = useRpc(memoryHistoryRpc);
  const revert = useRpc(revertMemoryRpc);
  const query = useQuery({ queryKey: ["memorise", "history", fact.id], queryFn: () => history({ where, id: fact.id }) });
  const action = useMutation({ mutationFn: (versionId: string) => revert({ where, id: fact.id, versionId }), onSuccess: () => memoryChanged() });
  if (query.isPending) return <Text style={styles.muted}>Loading history</Text>;
  if (query.error) return <Text style={styles.danger}>{query.error.message}</Text>;
  const current = fact.status === "active" && !fact.superseded;
  return (
    <View style={{ gap: 6 }}>
      {query.data.versions.map((version, index) => (
        <View key={version.id} style={[styles.card, { backgroundColor: "transparent" }]}>
          <Text style={styles.muted}>
            {index === 0 ? "current" : `version ${query.data.versions.length - index}`} · {version.modified.slice(0, 16).replace("T", " ")} · {version.type}
          </Text>
          <Text style={styles.body}>
            {version.subject}: {version.body}
          </Text>
          {current && index > 0 && <Button label="Revert to this" styles={styles} onPress={() => action.mutate(version.id)} />}
        </View>
      ))}
      {action.error && <Text style={styles.danger}>{action.error.message}</Text>}
    </View>
  );
}

// One memory with its actions. `selected`/`onSelect` add a check box for the manager's bulk actions.
export function FactCard({ fact, where, hasRepo, styles, selected, onSelect }: { fact: ListedFact; where: Where; hasRepo: boolean; styles: Styles; selected?: boolean; onSelect?(): void }) {
  const update = useRpc(updateMemoryRpc);
  const retire = useRpc(retireMemoryRpc);
  const restore = useRpc(restoreMemoryRpc);
  const pin = useRpc(pinMemoryRpc);
  const move = useRpc(moveMemoryRpc);
  const remove = useRpc(deleteMemoryRpc);
  const [editing, setEditing] = useState(false);
  const [showHistory, setShowHistory] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const action = useMutation({ mutationFn: (run: () => Promise<unknown>) => run(), onSuccess: () => memoryChanged() });
  const current = fact.status === "active" && !fact.superseded;
  const state = fact.superseded ? "replaced" : fact.status === "retired" ? "retired" : !fact.enabled ? "off for agents" : isEnded(fact) ? `ended ${fact.until}` : fact.visibleToAgents ? null : "hidden from agents (unused)";
  const by = fact.source.by === "user" ? "you" : fact.source.by === "captured" ? `captured (${fact.source.provider ?? "agent"}), approved by you` : (fact.source.provider ?? "agent");
  const { shown, read, found } = fact.usage;
  const controls = [fact.pinned && "pinned", fact.activation !== "listed" && ACTIVATION_LABEL[fact.activation].toLowerCase(), fact.until && !isEnded(fact) && `until ${fact.until}`].filter(Boolean).join(" · ");
  if (editing) return <FactEditor where={where} fact={fact} defaultScope={fact.scope} hasRepo={hasRepo} styles={styles} onDone={() => setEditing(false)} />;
  return (
    <View style={styles.card}>
      <View style={styles.row}>
        {onSelect && <Chip label={selected ? "Selected" : "Select"} on={selected === true} onPress={onSelect} styles={styles} />}
        <Text style={styles.body}>{fact.subject}</Text>
      </View>
      <Text style={styles.muted}>
        {fact.type} · {fact.scope === "global" ? "global" : "this repo"} · {by} · {fact.created.slice(0, 10)}
        {controls ? ` · ${controls}` : ""}
        {state ? ` · ${state}` : ""}
      </Text>
      <Text style={styles.muted}>
        shown to agents {shown}× · read {read}× · found by search {found}×{fact.paths.length > 0 ? ` · about ${fact.paths.join(", ")}` : ""}
      </Text>
      <Text style={styles.body}>{fact.body}</Text>
      {fact.citations.length > 0 && <Text style={styles.muted}>cites {fact.citations.map((c) => `${c.path}${c.lines ? `:${c.lines}` : ""}@${c.commit}`).join(", ")}</Text>}
      {action.error && <Text style={styles.danger}>{action.error instanceof Error ? action.error.message : String(action.error)}</Text>}
      <View style={styles.row}>
        {current && <Button label="Edit" styles={styles} onPress={() => setEditing(true)} />}
        {current && <Button label={fact.pinned ? "Unpin" : "Pin"} styles={styles} onPress={() => action.mutate(() => pin({ where, id: fact.id, pinned: !fact.pinned }))} />}
        {current && <Button label={fact.enabled ? "Turn off" : "Turn on"} styles={styles} onPress={() => action.mutate(() => update({ where, id: fact.id, enabled: !fact.enabled }))} />}
        {current && <Button label="Retire" styles={styles} onPress={() => action.mutate(() => retire({ where, id: fact.id }))} />}
        {fact.status === "retired" && !fact.superseded && <Button label="Restore" styles={styles} onPress={() => action.mutate(() => restore({ where, id: fact.id }))} />}
        {current && fact.scope === "repo" && <Button label="Make global" styles={styles} onPress={() => action.mutate(() => move({ where, id: fact.id, to: "global" }))} />}
        {current && fact.scope === "global" && hasRepo && <Button label="Move to this repo" styles={styles} onPress={() => action.mutate(() => move({ where, id: fact.id, to: "repo" }))} />}
        <Button label={showHistory ? "Hide history" : "History"} styles={styles} onPress={() => setShowHistory((value) => !value)} />
        <Button label={confirmDelete ? "Confirm delete" : "Delete"} tone="danger" styles={styles} onPress={() => (confirmDelete ? action.mutate(() => remove({ where, id: fact.id })) : setConfirmDelete(true))} />
      </View>
      {showHistory && <History fact={fact} where={where} styles={styles} />}
    </View>
  );
}
