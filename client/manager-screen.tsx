import { type PluginScreenProps, useRpc } from "@getpaseo/plugin/client";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useMemo, useState } from "react";
import { Pressable, ScrollView, Text, TextInput, View } from "react-native";
import { type Activation, type BulkAction, bulkMemoryRpc, listMemoriesRpc, listReposRpc, type MemoryType, memoryTypeSchema, searchMemoriesRpc } from "../shared/memory";
import { FactCard, isEnded, type ListedFact } from "./fact-card";
import { ACTIVATION_LABEL, FactEditor } from "./fact-editor";
import { memoryChanged, onMemoryChanged } from "./memory-events";
import { Button, Chip, useStyles } from "./panel-ui";
import { RepoPrefsCard, TransferCard } from "./repo-tools";

type Status = "current" | "retired" | "replaced" | "all";
type Control = "any" | "pinned" | "off" | "ended" | Exclude<Activation, "listed">;
type Sort = "changed" | "created" | "most used" | "least used";

const GLOBAL = "global";

function matchesStatus(fact: ListedFact, status: Status): boolean {
  if (status === "all") return true;
  if (status === "replaced") return fact.superseded;
  if (status === "retired") return !fact.superseded && fact.status === "retired";
  return !fact.superseded && fact.status === "active";
}

function matchesControl(fact: ListedFact, control: Control): boolean {
  if (control === "any") return true;
  if (control === "pinned") return fact.pinned;
  if (control === "off") return !fact.enabled;
  if (control === "ended") return isEnded(fact);
  return fact.activation === control;
}

const uses = (fact: ListedFact) => fact.usage.shown + fact.usage.read + fact.usage.found;
const SORTS: Record<Sort, (a: ListedFact, b: ListedFact) => number> = {
  changed: (a, b) => b.modified.localeCompare(a.modified),
  created: (a, b) => b.created.localeCompare(a.created),
  "most used": (a, b) => uses(b) - uses(a),
  "least used": (a, b) => uses(a) - uses(b),
};

const BULK: { action: BulkAction; label: string }[] = [
  { action: "pin", label: "Pin" },
  { action: "unpin", label: "Unpin" },
  { action: "enable", label: "Turn on" },
  { action: "disable", label: "Turn off" },
  { action: "retire", label: "Retire" },
  { action: "restore", label: "Restore" },
];

// Every repo's memories plus global memory, without opening a workspace. `params.repo` is a repo
// key or "global".
export function ManagerScreen({ theme, layout, params }: PluginScreenProps) {
  const styles = useStyles(theme, layout.compact);
  const listRepos = useRpc(listReposRpc);
  const list = useRpc(listMemoriesRpc);
  const search = useRpc(searchMemoriesRpc);
  const bulk = useRpc(bulkMemoryRpc);
  const queryClient = useQueryClient();
  const [chosen, setChosen] = useState(params.repo ?? GLOBAL);
  const repoKey = chosen === GLOBAL ? null : chosen;
  const where = useMemo(() => ({ repoKey }), [repoKey]);
  const [query, setQuery] = useState("");
  const [status, setStatus] = useState<Status>("current");
  const [type, setType] = useState<MemoryType | "any">("any");
  const [control, setControl] = useState<Control>("any");
  const [sort, setSort] = useState<Sort>("changed");
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [adding, setAdding] = useState(false);
  const [showTools, setShowTools] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);

  useEffect(() => setChosen(params.repo ?? GLOBAL), [params.repo]);
  useEffect(() => onMemoryChanged(() => void queryClient.invalidateQueries({ queryKey: ["memorise"] })), [queryClient]);
  useEffect(() => {
    setSelected(new Set());
    setConfirmDelete(false);
  }, [chosen]);

  const repos = useQuery({ queryKey: ["memorise", "repos"], queryFn: () => listRepos({}) });
  const facts = useQuery({ queryKey: ["memorise", "manager", chosen], queryFn: () => list({ where }) });
  const trimmed = query.trim();
  const found = useQuery({ queryKey: ["memorise", "search", chosen, trimmed], queryFn: () => search({ where, query: trimmed }), enabled: trimmed !== "" });
  const runBulk = useMutation({
    mutationFn: (action: BulkAction) => bulk({ where, ids: [...selected], action }),
    onSuccess: () => {
      setSelected(new Set());
      setConfirmDelete(false);
      memoryChanged();
    },
  });

  const scope = repoKey ? "repo" : "global";
  const shown = useMemo(() => {
    const own = (facts.data?.facts ?? []).filter((fact) => fact.scope === scope);
    const rank = found.data ? new Map(found.data.ids.map((id, index) => [id, index])) : null;
    const kept = own.filter((fact) => (!rank || rank.has(fact.id)) && matchesStatus(fact, status) && (type === "any" || fact.type === type) && matchesControl(fact, control));
    return rank ? kept.sort((a, b) => (rank.get(a.id) ?? 0) - (rank.get(b.id) ?? 0)) : kept.sort(SORTS[sort]);
  }, [facts.data, found.data, scope, status, type, control, sort]);

  const toggle = (id: string) =>
    setSelected((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  // The repo the screen was opened for, and the chosen one, are listed even before they have any
  // memory files, so either can be chosen again.
  const listedRepos = repos.data?.repos ?? [];
  const missing = [...new Set([params.repo, repoKey])].filter((key): key is string => !!key && key !== GLOBAL && !listedRepos.some((repo) => repo.repoKey === key));
  const shownRepos = [...listedRepos, ...missing.map((key) => ({ repoKey: key, active: 0, retired: 0, lastModified: null }))];
  const repoList = (
    <View style={{ gap: 6, width: layout.compact ? undefined : 260 }}>
      <Text style={styles.title}>Memorise</Text>
      {repos.error && <Text style={styles.danger}>{repos.error.message}</Text>}
      {shownRepos.map((repo) => {
        const id = repo.repoKey ?? GLOBAL;
        return (
          <Pressable key={id} accessibilityRole="button" accessibilityLabel={`Show ${repo.repoKey ?? "global"} memories`} onPress={() => setChosen(id)} style={[styles.card, chosen === id && { borderColor: theme.colors.accent }]}>
            <Text style={styles.body}>{repo.repoKey ?? "Global (every repo)"}</Text>
            <Text style={styles.muted}>
              {repo.active} active{repo.retired > 0 ? ` · ${repo.retired} retired` : ""}
              {repo.lastModified ? ` · changed ${repo.lastModified.slice(0, 10)}` : ""}
            </Text>
          </Pressable>
        );
      })}
    </View>
  );

  return (
    <ScrollView style={styles.screen} contentContainerStyle={[styles.content, !layout.compact && { flexDirection: "row", alignItems: "flex-start", gap: 20 }]}>
      {repoList}
      <View style={{ flex: 1, gap: 12, minWidth: 0 }}>
        <Text style={styles.title}>{repoKey ?? "Global memory"}</Text>
        <Text style={styles.muted}>{repoKey ? "Shared by every clone and worktree of this repo." : "Your own memories; they reach agents in every repo."}</Text>
        <View style={styles.row}>
          <Button label={adding ? "Close new memory" : "New memory"} styles={styles} onPress={() => setAdding((value) => !value)} />
          <Button label={showTools ? "Hide import and export" : "Import and export"} styles={styles} onPress={() => setShowTools((value) => !value)} />
        </View>
        {adding && <FactEditor key={chosen} where={where} defaultScope={scope} hasRepo={repoKey !== null} styles={styles} onDone={() => setAdding(false)} />}
        {repoKey && <RepoPrefsCard repoKey={repoKey} styles={styles} />}
        {showTools && <TransferCard where={where} scope={scope} styles={styles} />}
        <TextInput accessibilityLabel="Search memories" value={query} onChangeText={setQuery} placeholder="Search words in subjects, text, and paths" style={[styles.input, { minHeight: 0 }]} />
        {found.error && <Text style={styles.danger}>{found.error.message}</Text>}
        <View style={styles.row}>
          {(["current", "retired", "replaced", "all"] as const).map((value) => (
            <Chip key={value} label={value} on={status === value} onPress={() => setStatus(value)} styles={styles} />
          ))}
        </View>
        <View style={styles.row}>
          <Chip label="any type" on={type === "any"} onPress={() => setType("any")} styles={styles} />
          {memoryTypeSchema.options.map((value) => (
            <Chip key={value} label={value} on={type === value} onPress={() => setType(value)} styles={styles} />
          ))}
        </View>
        <View style={styles.row}>
          {(["any", "pinned", "off", "ended", "files", "title", "manual"] as const).map((value) => (
            <Chip key={value} label={value === "any" ? "any control" : value === "off" ? "off for agents" : value === "files" || value === "title" || value === "manual" ? ACTIVATION_LABEL[value].toLowerCase() : value} on={control === value} onPress={() => setControl(value)} styles={styles} />
          ))}
        </View>
        {!found.data && (
          <View style={styles.row}>
            <Text style={styles.muted}>Sort:</Text>
            {(["changed", "created", "most used", "least used"] as const).map((value) => (
              <Chip key={value} label={value} on={sort === value} onPress={() => setSort(value)} styles={styles} />
            ))}
          </View>
        )}
        {selected.size > 0 && (
          <View style={[styles.card, styles.row]}>
            <Text style={styles.body}>{selected.size} selected</Text>
            {BULK.map(({ action, label }) => (
              <Button key={action} label={label} styles={styles} onPress={() => runBulk.mutate(action)} />
            ))}
            <Button label={confirmDelete ? `Confirm delete ${selected.size}` : "Delete"} tone="danger" styles={styles} onPress={() => (confirmDelete ? runBulk.mutate("delete") : setConfirmDelete(true))} />
            <Button label="Clear" styles={styles} onPress={() => setSelected(new Set())} />
          </View>
        )}
        {runBulk.data?.results.filter((result) => !result.ok).map((result) => (
          <Text key={result.id} style={styles.danger}>
            {result.id}: {result.error}
          </Text>
        ))}
        {runBulk.error && <Text style={styles.danger}>{runBulk.error.message}</Text>}
        {facts.isPending && <Text style={styles.muted}>Loading memories</Text>}
        {facts.error && <Text style={styles.danger}>{facts.error.message}</Text>}
        {facts.data && shown.length === 0 && <Text style={styles.muted}>No memories match.</Text>}
        {shown.length > 0 && (
          <View style={styles.row}>
            <Button label="Select all shown" styles={styles} onPress={() => setSelected(new Set(shown.map((fact) => fact.id)))} />
          </View>
        )}
        {shown.map((fact) => (
          <FactCard key={fact.id} fact={fact} where={where} hasRepo={repoKey !== null} styles={styles} selected={selected.has(fact.id)} onSelect={() => toggle(fact.id)} />
        ))}
      </View>
    </ScrollView>
  );
}
