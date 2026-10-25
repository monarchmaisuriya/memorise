import { useRpc } from "@getpaseo/plugin/client";
import { useMutation, useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { Text, View } from "react-native";
import { deleteMemoryRpc, memoryHistoryRpc, moveMemoryRpc, pinMemoryRpc, restoreMemoryRpc, retireMemoryRpc, revertMemoryRpc, updateMemoryRpc, type Where } from "../shared/memory";
import { ACTIVATION, errorText, KIND, projectName, providerName, relativeDate, shortDate, usageText } from "./copy";
import { FactEditor } from "./fact-editor";
import { isEnded, type ListedFact } from "./manager-view";
import { memoryChanged } from "./memory-events";
import { announce } from "./notices";
import { Badge, Button, Chip, type Styles } from "./panel-ui";

export type { ListedFact } from "./manager-view";

function History({ fact, where, styles }: { fact: ListedFact; where: Where; styles: Styles }) {
  const history = useRpc(memoryHistoryRpc);
  const revert = useRpc(revertMemoryRpc);
  const query = useQuery({ queryKey: ["memorise", "history", fact.id], queryFn: () => history({ where, id: fact.id }) });
  const action = useMutation({ mutationFn: (versionId: string) => revert({ where, id: fact.id, versionId }), onSuccess: () => memoryChanged() });
  if (query.isPending) return <Text style={styles.muted}>Loading history</Text>;
  if (query.error) return <Text style={styles.danger}>{errorText(query.error)}</Text>;
  const current = fact.status === "active" && !fact.superseded;
  return (
    <View style={{ gap: 6 }}>
      {query.data.versions.map((version, index) => (
        <View key={version.id} style={[styles.card, { backgroundColor: "transparent" }]}>
          <Text style={styles.muted}>
            {index === 0 ? "Current version" : `Version ${query.data.versions.length - index}`} · {KIND[version.type]} · {relativeDate(version.modified)}
          </Text>
          <Text style={styles.body}>
            {version.subject}: {version.body}
          </Text>
          {current && index > 0 && (
            <View style={styles.row}>
              <Button label="Use this version" styles={styles} onPress={() => action.mutate(version.id)} />
            </View>
          )}
        </View>
      ))}
      {action.error && <Text style={styles.danger}>{errorText(action.error)}</Text>}
    </View>
  );
}

// The small tags after a memory's title: its kind, then any state or setting that changes what
// agents see.
function badges(fact: ListedFact): string[] {
  const state = fact.superseded ? "Older version" : fact.status === "retired" ? "Archived" : null;
  return [
    KIND[fact.type],
    fact.scope === "global" ? "Global" : null,
    fact.source.by === "auto" ? "Saved without review" : null,
    state,
    fact.pinned ? "Pinned" : null,
    !fact.enabled ? "Off" : null,
    fact.activation !== "listed" ? ACTIVATION[fact.activation].label : null,
    fact.until ? (isEnded(fact) ? `Expired ${shortDate(fact.until)}` : `Expires ${shortDate(fact.until)}`) : null,
    !state && fact.enabled && !isEnded(fact) && !fact.visibleToAgents ? "Unused, hidden" : null,
  ].filter((label): label is string => label !== null);
}

// Who saved a memory, in a few words.
function savedBy(fact: ListedFact): string {
  const provider = providerName(fact.source.provider);
  if (fact.source.by === "user") return "Saved by you";
  if (fact.source.by === "captured") return `Suggested by ${provider}, approved by you`;
  if (fact.source.by === "auto") return `Suggested by ${provider}, saved without review`;
  return `Saved by ${provider}`;
}

// One memory: three everyday actions, the rest under More. `showRepo` names the project where cards
// from several projects share a list. `onSelect` adds a select chip.
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
  const [showCitations, setShowCitations] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const action = useMutation({ mutationFn: (run: () => Promise<unknown>) => run(), onSuccess: () => memoryChanged() });
  const current = fact.status === "active" && !fact.superseded;
  const title = `“${fact.subject}”`;
  // Archive and move take the memory out of this list, so their notice (with Undo) sits above it.
  const archive = () =>
    action.mutate(async () => {
      await retire({ where, id: fact.id });
      announce({ text: `Archived ${title}`, undo: () => restore({ where, id: fact.id }) });
    });
  const moveTo = (to: "global" | "repo") =>
    action.mutate(async () => {
      const { fact: moved } = await move({ where, id: fact.id, to });
      announce({ text: to === "global" ? `Made ${title} global` : `Moved ${title} to this project`, undo: () => move({ where, id: moved.id, to: to === "global" ? "repo" : "global" }) });
    });
  if (editing) return <FactEditor where={where} fact={fact} defaultScope={fact.scope} hasRepo={hasRepo} styles={styles} onDone={() => setEditing(false)} />;
  const deleteButton = <Button label="Delete" tone="danger" styles={styles} onPress={() => setConfirmDelete(true)} />;
  const historyButton = <Button label={showHistory ? "Hide history" : "History"} styles={styles} onPress={() => setShowHistory((value) => !value)} />;
  const details = [
    showRepo && fact.repoKey ? projectName(fact.repoKey) : null,
    savedBy(fact),
    relativeDate(fact.created),
    usageText(fact.usage),
    fact.paths.length > 0 ? `About ${fact.paths.join(", ")}` : null,
  ].filter((part): part is string => part !== null);
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
      <Text style={styles.muted}>{details.join(" · ")}</Text>
      {fact.citations.length > 0 && (
        <View style={styles.row}>
          <Button label={showCitations ? "Hide cited files" : `Cites ${fact.citations.length === 1 ? "1 file" : `${fact.citations.length} files`}`} styles={styles} onPress={() => setShowCitations((value) => !value)} />
        </View>
      )}
      {showCitations &&
        fact.citations.map((citation) => (
          <Text key={`${citation.path}:${citation.lines ?? ""}`} style={styles.muted}>
            {citation.path}
            {citation.lines ? `, lines ${citation.lines}` : ""}
            {citation.commit ? ` (as of commit ${citation.commit})` : " (as saved)"}
          </Text>
        ))}
      {action.error && <Text style={styles.danger}>{errorText(action.error)}</Text>}
      {confirmDelete ? (
        <View style={[styles.row, styles.card, { backgroundColor: "transparent" }]}>
          <Text style={[styles.body, { flexShrink: 1 }]}>Delete {title}? This can't be undone.</Text>
          <Button label="Delete memory" tone="danger" styles={styles} onPress={() => action.mutate(() => remove({ where, id: fact.id }))} />
          <Button label="Cancel" styles={styles} onPress={() => setConfirmDelete(false)} />
        </View>
      ) : current ? (
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
      {current && more && !confirmDelete && (
        <View style={styles.row}>
          <Button label="Archive" styles={styles} onPress={archive} />
          {fact.scope === "repo" && <Button label="Make global" styles={styles} onPress={() => moveTo("global")} />}
          {fact.scope === "global" && hasRepo && <Button label="Move to this project" styles={styles} onPress={() => moveTo("repo")} />}
          {historyButton}
          {deleteButton}
        </View>
      )}
      {showHistory && <History fact={fact} where={where} styles={styles} />}
    </View>
  );
}
