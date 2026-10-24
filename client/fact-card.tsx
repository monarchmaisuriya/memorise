import { useRpc } from "@getpaseo/plugin/client";
import { useMutation, useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { Text, View } from "react-native";
import { deleteMemoryRpc, memoryHistoryRpc, moveMemoryRpc, pinMemoryRpc, restoreMemoryRpc, retireMemoryRpc, revertMemoryRpc, updateMemoryRpc, type Where } from "../shared/memory";
import { ACTIVATION_LABEL, FactEditor } from "./fact-editor";
import { isEnded, type ListedFact } from "./manager-view";
import { memoryChanged } from "./memory-events";
import { Badge, Button, Chip, type Styles } from "./panel-ui";

export type { ListedFact } from "./manager-view";

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
          {current && index > 0 && (
            <View style={styles.row}>
              <Button label="Revert to this" styles={styles} onPress={() => action.mutate(version.id)} />
            </View>
          )}
        </View>
      ))}
      {action.error && <Text style={styles.danger}>{action.error.message}</Text>}
    </View>
  );
}

// The small tags after a memory's subject: what it is and which controls are set.
function badges(fact: ListedFact): string[] {
  const state = fact.superseded ? "replaced" : fact.status === "retired" ? "retired" : null;
  return [
    fact.type,
    fact.scope === "global" ? "global" : null,
    fact.source.by === "auto" ? "auto" : null,
    state,
    fact.pinned ? "pinned" : null,
    !fact.enabled ? "off" : null,
    fact.activation !== "listed" ? ACTIVATION_LABEL[fact.activation].toLowerCase() : null,
    fact.until ? (isEnded(fact) ? `ended ${fact.until}` : `until ${fact.until}`) : null,
    !state && fact.enabled && !isEnded(fact) && !fact.visibleToAgents ? "hidden (unused)" : null,
  ].filter((label): label is string => label !== null);
}

// One memory: three everyday actions, the rest under More. `showRepo` names the repo instead of
// "this repo" where cards from several repos share a list. `onSelect` adds a select chip.
export function FactCard({ fact, where, hasRepo, styles, selected, onSelect, showRepo }: { fact: ListedFact; where: Where; hasRepo: boolean; styles: Styles; selected?: boolean; onSelect?(): void; showRepo?: boolean }) {
  const update = useRpc(updateMemoryRpc);
  const retire = useRpc(retireMemoryRpc);
  const restore = useRpc(restoreMemoryRpc);
  const pin = useRpc(pinMemoryRpc);
  const move = useRpc(moveMemoryRpc);
  const remove = useRpc(deleteMemoryRpc);
  const [editing, setEditing] = useState(false);
  const [more, setMore] = useState(false);
  const [showHistory, setShowHistory] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const action = useMutation({ mutationFn: (run: () => Promise<unknown>) => run(), onSuccess: () => memoryChanged() });
  const current = fact.status === "active" && !fact.superseded;
  const by =
    fact.source.by === "user"
      ? "you"
      : fact.source.by === "captured"
        ? `proposed by ${fact.source.provider ?? "agent"}, approved by you`
        : fact.source.by === "auto"
          ? `proposed by ${fact.source.provider ?? "agent"}, auto-approved`
          : (fact.source.provider ?? "agent");
  const { shown, read, found } = fact.usage;
  const repoLabel = showRepo && fact.repoKey ? `${fact.repoKey} · ` : "";
  if (editing) return <FactEditor where={where} fact={fact} defaultScope={fact.scope} hasRepo={hasRepo} styles={styles} onDone={() => setEditing(false)} />;
  const deleteButton = (
    <Button label={confirmDelete ? "Confirm delete" : "Delete"} tone="danger" styles={styles} onPress={() => (confirmDelete ? action.mutate(() => remove({ where, id: fact.id })) : setConfirmDelete(true))} />
  );
  const historyButton = <Button label={showHistory ? "Hide history" : "History"} styles={styles} onPress={() => setShowHistory((value) => !value)} />;
  return (
    <View style={styles.card}>
      <View style={styles.row}>
        {onSelect && <Chip label={selected ? "Selected" : "Select"} on={selected === true} onPress={onSelect} styles={styles} />}
        <Text style={styles.body}>{fact.subject}</Text>
        {badges(fact).map((label) => (
          <Badge key={label} label={label} styles={styles} />
        ))}
      </View>
      <Text style={styles.body}>{fact.body}</Text>
      <Text style={styles.muted}>
        {repoLabel}
        {by} · {fact.created.slice(0, 10)} · shown {shown} · read {read} · found {found}
        {fact.paths.length > 0 ? ` · about ${fact.paths.join(", ")}` : ""}
        {fact.citations.length > 0 ? ` · cites ${fact.citations.map((c) => `${c.path}${c.lines ? `:${c.lines}` : ""}@${c.commit ?? `#${c.hash}`}`).join(", ")}` : ""}
      </Text>
      {action.error && <Text style={styles.danger}>{action.error instanceof Error ? action.error.message : String(action.error)}</Text>}
      {current ? (
        <View style={styles.row}>
          <Button label="Edit" styles={styles} onPress={() => setEditing(true)} />
          <Button label={fact.pinned ? "Unpin" : "Pin"} styles={styles} onPress={() => action.mutate(() => pin({ where, id: fact.id, pinned: !fact.pinned }))} />
          <Button label={fact.enabled ? "Turn off" : "Turn on"} styles={styles} onPress={() => action.mutate(() => update({ where, id: fact.id, enabled: !fact.enabled }))} />
          <Button label={more ? "Less" : "More"} styles={styles} onPress={() => setMore((value) => !value)} />
        </View>
      ) : (
        <View style={styles.row}>
          {fact.status === "retired" && !fact.superseded && <Button label="Restore" styles={styles} onPress={() => action.mutate(() => restore({ where, id: fact.id }))} />}
          {historyButton}
          {deleteButton}
        </View>
      )}
      {current && more && (
        <View style={styles.row}>
          <Button label="Retire" styles={styles} onPress={() => action.mutate(() => retire({ where, id: fact.id }))} />
          {fact.scope === "repo" && <Button label="Make global" styles={styles} onPress={() => action.mutate(() => move({ where, id: fact.id, to: "global" }))} />}
          {fact.scope === "global" && hasRepo && <Button label="Move to this repo" styles={styles} onPress={() => action.mutate(() => move({ where, id: fact.id, to: "repo" }))} />}
          {historyButton}
          {deleteButton}
        </View>
      )}
      {showHistory && <History fact={fact} where={where} styles={styles} />}
    </View>
  );
}
