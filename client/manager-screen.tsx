import { type PluginScreenProps, useRpc } from "@getpaseo/plugin/client";
import { keepPreviousData, useMutation, useQueries, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useMemo, useState } from "react";
import { Pressable, ScrollView, Text, TextInput, View } from "react-native";
import { type BulkAction, bulkMemoryRpc, isFolderKey, listMemoriesRpc, listProposalsRpc, listReposRpc, memoryTypeSchema, proposalsSummaryRpc, searchMemoriesRpc, tidyMemoryRpc } from "../shared/memory";
import { FactCard } from "./fact-card";
import { FactEditor } from "./fact-editor";
import { Inbox } from "./inbox";
import { activeFilters, applyFilters, ATTENTION, attentionGroups, type Control, CONTROL_LABEL, DEFAULT_FILTERS, type ListedFact, mergeScopes, shownSelection, type ViewFilters } from "./manager-view";
import { memoryChanged, onMemoryChanged } from "./memory-events";
import { Button, Chip, type Styles, useStyles } from "./panel-ui";
import { RepoPrefsCard, TransferCard } from "./repo-tools";
import { MemorySettingsScreen } from "./settings-screen";

const GLOBAL = "global";
const ATTENTION_VIEW = "attention";
const PROPOSALS_VIEW = "proposals";
const SETTINGS_VIEW = "settings";

const BULK: { action: BulkAction; label: string }[] = [
  { action: "pin", label: "Pin" },
  { action: "unpin", label: "Unpin" },
  { action: "enable", label: "Turn on" },
  { action: "disable", label: "Turn off" },
  { action: "retire", label: "Retire" },
  { action: "restore", label: "Restore" },
];

function NavItem({ label, detail, on, onPress, styles }: { label: string; detail?: string; on: boolean; onPress(): void; styles: Styles }) {
  return (
    <Pressable accessibilityRole="button" accessibilityLabel={label} accessibilityState={{ selected: on }} onPress={onPress} style={[styles.nav, on && styles.navOn]}>
      <Text style={styles.body} numberOfLines={1}>
        {label}
      </Text>
      {detail ? <Text style={styles.muted}>{detail}</Text> : null}
    </Pressable>
  );
}

function FilterPanel({ filters, setFilters, searching, styles }: { filters: ViewFilters; setFilters(next: ViewFilters): void; searching: boolean; styles: Styles }) {
  const group = (title: string, chips: React.ReactNode) => (
    <View style={{ gap: 6 }}>
      <Text style={styles.label}>{title}</Text>
      <View style={styles.row}>{chips}</View>
    </View>
  );
  return (
    <View style={[styles.card, { gap: 10 }]}>
      {group(
        "Status",
        (["current", "retired", "replaced", "all"] as const).map((value) => <Chip key={value} label={value} on={filters.status === value} onPress={() => setFilters({ ...filters, status: value })} styles={styles} />),
      )}
      {group("Type", [
        <Chip key="any" label="any type" on={filters.type === "any"} onPress={() => setFilters({ ...filters, type: "any" })} styles={styles} />,
        ...memoryTypeSchema.options.map((value) => <Chip key={value} label={value} on={filters.type === value} onPress={() => setFilters({ ...filters, type: value })} styles={styles} />),
      ])}
      {group(
        "Control",
        (Object.keys(CONTROL_LABEL) as Control[]).map((value) => <Chip key={value} label={CONTROL_LABEL[value]} on={filters.control === value} onPress={() => setFilters({ ...filters, control: value })} styles={styles} />),
      )}
      {searching ? (
        <Text style={styles.muted}>Search results are listed best match first.</Text>
      ) : (
        group(
          "Sort",
          (["changed", "created", "most used", "least used"] as const).map((value) => <Chip key={value} label={value} on={filters.sort === value} onPress={() => setFilters({ ...filters, sort: value })} styles={styles} />),
        )
      )}
    </View>
  );
}

// One scope's memories: global, or one repo with its proposals and tools.
function MemoriesView({ repoKey, styles }: { repoKey: string | null; styles: Styles }) {
  const list = useRpc(listMemoriesRpc);
  const search = useRpc(searchMemoriesRpc);
  const bulk = useRpc(bulkMemoryRpc);
  const listProposals = useRpc(listProposalsRpc);
  const where = useMemo(() => ({ repoKey }), [repoKey]);
  const scope = repoKey ? "repo" : "global";
  const [tab, setTab] = useState<"memories" | "proposed">("memories");
  const [query, setQuery] = useState("");
  const [filters, setFilters] = useState<ViewFilters>(DEFAULT_FILTERS);
  const [showFilters, setShowFilters] = useState(false);
  const [showTools, setShowTools] = useState(false);
  const [adding, setAdding] = useState(false);
  const [selecting, setSelecting] = useState(false);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [confirmDelete, setConfirmDelete] = useState(false);

  const facts = useQuery({ queryKey: ["memorise", "manager", repoKey], queryFn: () => list({ where }) });
  const proposals = useQuery({ queryKey: ["memorise-proposals", where], queryFn: () => listProposals({ where }), enabled: repoKey !== null });
  const trimmed = query.trim();
  // While the next search runs, the previous results stay; before the first one, nothing is shown.
  const found = useQuery({ queryKey: ["memorise", "search", repoKey, trimmed], queryFn: () => search({ where, query: trimmed }), enabled: trimmed !== "", placeholderData: keepPreviousData });
  const shown = useMemo(() => applyFilters(facts.data?.facts ?? [], filters, scope, trimmed ? (found.data?.ids ?? []) : null), [facts.data, filters, scope, trimmed, found.data]);
  const chosen = shownSelection(selected, shown);
  // A change to what is chosen disarms a pending "Confirm delete".
  useEffect(() => setConfirmDelete(false), [chosen.length]);
  const runBulk = useMutation({
    mutationFn: (action: BulkAction) => bulk({ where, ids: chosen, action }),
    onSuccess: () => {
      setSelected(new Set());
      setConfirmDelete(false);
      memoryChanged();
    },
  });
  const active = activeFilters(filters, trimmed !== "");
  const pending = proposals.data?.proposals.length ?? 0;

  const toggle = (id: string) =>
    setSelected((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  const stopSelecting = () => {
    setSelecting(false);
    setSelected(new Set());
    setConfirmDelete(false);
  };

  return (
    <View style={{ gap: 12 }}>
      <Text style={styles.title}>{repoKey ?? "Global memory"}</Text>
      <Text style={styles.muted}>{repoKey ? (isFolderKey(repoKey) ? "A folder outside git: its memories reach agents started in this folder." : "Shared by every clone and worktree of this repo.") : "Your own memories; they reach agents in every repo."}</Text>
      {repoKey && (
        <View style={styles.row}>
          <Chip label="Memories" on={tab === "memories"} onPress={() => setTab("memories")} styles={styles} />
          <Chip label={pending > 0 ? `Proposed · ${pending}` : "Proposed"} on={tab === "proposed"} onPress={() => setTab("proposed")} styles={styles} />
        </View>
      )}
      {tab === "proposed" && repoKey ? (
        <Inbox where={where} styles={styles} onChanged={() => memoryChanged()} />
      ) : (
        <>
          <View style={styles.row}>
            <Button label={adding ? "Close new memory" : "New memory"} styles={styles} onPress={() => setAdding((value) => !value)} />
            <Button label={selecting ? "Done selecting" : "Select"} styles={styles} onPress={() => (selecting ? stopSelecting() : setSelecting(true))} />
            <Button label={showTools ? (repoKey ? "Hide repo tools" : "Hide import and export") : repoKey ? "Repo tools" : "Import and export"} styles={styles} onPress={() => setShowTools((value) => !value)} />
          </View>
          {adding && <FactEditor where={where} defaultScope={scope} hasRepo={repoKey !== null} styles={styles} onDone={() => setAdding(false)} />}
          {showTools && (
            <>
              {repoKey && <RepoPrefsCard repoKey={repoKey} styles={styles} />}
              <TransferCard where={where} scope={scope} styles={styles} />
            </>
          )}
          <View style={[styles.row, { flexWrap: "nowrap" }]}>
            <TextInput accessibilityLabel="Search memories" value={query} onChangeText={setQuery} placeholder="Search subjects, text, and paths" style={[styles.input, { minHeight: 0, flex: 1 }]} />
            <Button label={`${showFilters ? "Hide filters" : "Filters"}${active.length > 0 ? ` · ${active.length}` : ""}`} styles={styles} onPress={() => setShowFilters((value) => !value)} />
          </View>
          {active.length > 0 && (
            <View style={styles.row}>
              {active.map((filter) => (
                <Chip key={filter.key} label={`${filter.label} ✕`} on onPress={() => setFilters({ ...filters, [filter.key]: DEFAULT_FILTERS[filter.key] })} styles={styles} />
              ))}
              <Button label="Clear" styles={styles} onPress={() => setFilters(DEFAULT_FILTERS)} />
            </View>
          )}
          {showFilters && <FilterPanel filters={filters} setFilters={setFilters} searching={trimmed !== ""} styles={styles} />}
          {found.error && <Text style={styles.danger}>{found.error.message}</Text>}
          {selecting && (
            <View style={[styles.card, styles.row]}>
              <Text style={styles.body}>{chosen.length} selected</Text>
              <Button label="Select all shown" styles={styles} onPress={() => setSelected(new Set(shown.map((fact) => fact.id)))} />
              {chosen.length > 0 &&
                BULK.map(({ action, label }) => <Button key={action} label={label} styles={styles} onPress={() => runBulk.mutate(action)} />)}
              {chosen.length > 0 && (
                <Button label={confirmDelete ? `Confirm delete ${chosen.length}` : "Delete"} tone="danger" styles={styles} onPress={() => (confirmDelete ? runBulk.mutate("delete") : setConfirmDelete(true))} />
              )}
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
          {facts.data && <Text style={styles.muted}>{shown.length === 0 ? "No memories match." : `${shown.length} shown`}</Text>}
          {shown.map((fact) => (
            <FactCard key={fact.id} fact={fact} where={where} hasRepo={repoKey !== null} styles={styles} selected={selected.has(fact.id)} onSelect={selecting ? () => toggle(fact.id) : undefined} />
          ))}
        </>
      )}
    </View>
  );
}

function useAllFacts(repoKeys: readonly (string | null)[]) {
  const list = useRpc(listMemoriesRpc);
  const results = useQueries({ queries: repoKeys.map((repoKey) => ({ queryKey: ["memorise", "manager", repoKey], queryFn: () => list({ where: { repoKey } }) })) });
  const facts: ListedFact[] = mergeScopes(results.map((result, index) => ({ repoKey: repoKeys[index], facts: result.data?.facts ?? [] })));
  return { facts, pending: results.some((result) => result.isPending), error: results.find((result) => result.error)?.error ?? null };
}

// Every repo's waiting proposals in one place, and a tidy of every repo with memories.
function ProposalsView({ pending, repoKeys, styles }: { pending: { repoKey: string; pending: number }[]; repoKeys: string[]; styles: Styles }) {
  const tidy = useRpc(tidyMemoryRpc);
  // Each repo is tidied on its own, so one refusal (daily limit, a tidy already running) does not stop the rest.
  const tidyAll = useMutation({
    mutationFn: async () => {
      const results: string[] = [];
      for (const repoKey of repoKeys) {
        try {
          await tidy({ where: { repoKey } });
          results.push(`${repoKey}: started`);
        } catch (error) {
          results.push(`${repoKey}: ${error instanceof Error ? error.message : String(error)}`);
        }
      }
      return results;
    },
  });
  const total = pending.reduce((sum, repo) => sum + repo.pending, 0);
  return (
    <View style={{ gap: 12 }}>
      <Text style={styles.title}>Proposals</Text>
      <Text style={styles.muted}>
        {total === 0
          ? "No proposals waiting. Capture, tidy, and project scans (in a repo's Proposed tab) add them here."
          : "Proposed memories and changes from capture, tidy, and project scans, across every repo. Nothing reaches agents until you approve it, unless the repo has auto-approve on."}
      </Text>
      <View style={styles.row}>
        <Button label={tidyAll.isPending ? "Starting tidy" : `Tidy all repos (${repoKeys.length})`} disabled={tidyAll.isPending} styles={styles} onPress={() => tidyAll.mutate()} />
      </View>
      {tidyAll.data?.map((line) => (
        <Text key={line} style={styles.muted}>
          {line}
        </Text>
      ))}
      {pending.map((repo) => (
        <View key={repo.repoKey} style={{ gap: 8 }}>
          <Text style={styles.label}>
            {repo.repoKey} · {repo.pending}
          </Text>
          <Inbox where={{ repoKey: repo.repoKey }} styles={styles} onChanged={() => memoryChanged()} controls={false} />
        </View>
      ))}
    </View>
  );
}

// Memories across global and every repo that need a look, grouped by why.
function AttentionView({ facts, styles }: { facts: ListedFact[]; styles: Styles }) {
  const groups = attentionGroups(facts);
  const total = ATTENTION.reduce((sum, { reason }) => sum + (groups[reason]?.length ?? 0), 0);
  return (
    <View style={{ gap: 12 }}>
      <Text style={styles.title}>Needs attention</Text>
      <Text style={styles.muted}>{total === 0 ? "Nothing needs a look right now." : "Memories agents cannot see, or have never used. Edit, pin, turn on, or retire each one."}</Text>
      {ATTENTION.map(({ reason, title, rule }) => {
        const items = groups[reason] ?? [];
        if (items.length === 0) return null;
        return (
          <View key={reason} style={{ gap: 8 }}>
            <Text style={styles.label}>
              {title} · {items.length}
            </Text>
            <Text style={styles.muted}>{rule}</Text>
            {items.map((fact) => (
              <FactCard key={fact.id} fact={fact} where={{ repoKey: fact.repoKey }} hasRepo={fact.repoKey !== null} styles={styles} showRepo />
            ))}
          </View>
        );
      })}
    </View>
  );
}

// Global memory, every repo, what needs a look, and the plugin's settings, without opening a
// workspace. `params.repo` is a repo key or "global".
export function ManagerScreen(props: PluginScreenProps) {
  const { theme, layout, params } = props;
  const styles = useStyles(theme, layout.compact);
  const listRepos = useRpc(listReposRpc);
  const queryClient = useQueryClient();
  const [view, setView] = useState(params.repo ?? GLOBAL);
  useEffect(() => setView(params.repo ?? GLOBAL), [params.repo]);
  useEffect(() => onMemoryChanged(() => void queryClient.invalidateQueries({ queryKey: ["memorise"] })), [queryClient]);

  const repos = useQuery({ queryKey: ["memorise", "repos"], queryFn: () => listRepos({}) });
  const summarize = useRpc(proposalsSummaryRpc);
  const proposals = useQuery({ queryKey: ["memorise-proposals", "summary"], queryFn: () => summarize({}) });
  useEffect(() => onMemoryChanged(() => void queryClient.invalidateQueries({ queryKey: ["memorise-proposals"] })), [queryClient]);
  const pendingTotal = (proposals.data?.repos ?? []).reduce((sum, repo) => sum + repo.pending, 0);
  const listed = repos.data?.repos ?? [];
  // The repo the screen was opened for, and the chosen one, are listed even before they have any
  // memory files, so either can be chosen again.
  const isRepo = (key: string | undefined): key is string => !!key && key !== GLOBAL && key !== ATTENTION_VIEW && key !== SETTINGS_VIEW && key !== PROPOSALS_VIEW;
  const missing = [...new Set([params.repo, view])].filter((key): key is string => isRepo(key) && !listed.some((repo) => repo.repoKey === key));
  const shownRepos = [...listed, ...missing.map((key) => ({ repoKey: key, active: 0, retired: 0, lastModified: null }))];
  // Repos listed only for an open workspace or proposals have no memories to load or tidy.
  const all = useAllFacts(listed.filter((repo) => repo.repoKey === null || repo.active + repo.retired > 0).map((repo) => repo.repoKey));
  const attentionCount = Object.values(attentionGroups(all.facts)).reduce((sum, items) => sum + (items?.length ?? 0), 0);

  const repoEntries = shownRepos.map((repo) => ({
    id: repo.repoKey ?? GLOBAL,
    label: repo.repoKey ?? "Global (every repo)",
    detail: `${repo.active} active${repo.retired > 0 ? ` · ${repo.retired} retired` : ""}${repo.lastModified ? ` · changed ${repo.lastModified.slice(0, 10)}` : ""}`,
  }));
  const manageEntries = [
    { id: PROPOSALS_VIEW, label: "Proposals", detail: pendingTotal > 0 ? `${pendingTotal} waiting` : "none waiting" },
    { id: ATTENTION_VIEW, label: "Needs attention", detail: attentionCount > 0 ? `${attentionCount} to review` : "nothing to review" },
    { id: SETTINGS_VIEW, label: "Settings", detail: "memory, capture, tidy" },
  ];
  // Narrow layouts show the same entries as one wrapping row of chips above the content.
  const nav = layout.compact ? (
    <View style={{ gap: 8 }}>
      <Text style={styles.title}>Memorise</Text>
      {repos.error && <Text style={styles.danger}>{repos.error.message}</Text>}
      <View style={styles.row}>
        {[...repoEntries, ...manageEntries].map((entry) => (
          <Chip key={entry.id} label={entry.id === ATTENTION_VIEW && attentionCount > 0 ? `${entry.label} · ${attentionCount}` : entry.id === PROPOSALS_VIEW && pendingTotal > 0 ? `${entry.label} · ${pendingTotal}` : entry.label} on={view === entry.id} onPress={() => setView(entry.id)} styles={styles} />
        ))}
      </View>
    </View>
  ) : (
    <View style={{ gap: 4, width: 260 }}>
      <Text style={styles.title}>Memorise</Text>
      {repos.error && <Text style={styles.danger}>{repos.error.message}</Text>}
      <Text style={styles.label}>Memories</Text>
      {repoEntries.map((entry) => (
        <NavItem key={entry.id} label={entry.label} detail={entry.detail} on={view === entry.id} onPress={() => setView(entry.id)} styles={styles} />
      ))}
      <Text style={[styles.label, { marginTop: 8 }]}>Manage</Text>
      {manageEntries.map((entry) => (
        <NavItem key={entry.id} label={entry.label} detail={entry.detail} on={view === entry.id} onPress={() => setView(entry.id)} styles={styles} />
      ))}
    </View>
  );

  return (
    <ScrollView style={styles.screen} contentContainerStyle={[styles.content, !layout.compact && { flexDirection: "row", alignItems: "flex-start", gap: 24 }]}>
      {nav}
      <View style={{ flex: 1, minWidth: 0, gap: 12 }}>
        {view === SETTINGS_VIEW ? (
          <>
            <Text style={styles.title}>Settings</Text>
            <MemorySettingsScreen {...props} />
          </>
        ) : view === PROPOSALS_VIEW ? (
          proposals.error ? (
            <Text style={styles.danger}>{proposals.error.message}</Text>
          ) : (
            <ProposalsView pending={proposals.data?.repos ?? []} repoKeys={listed.flatMap((repo) => (repo.repoKey && repo.active >= 2 ? [repo.repoKey] : []))} styles={styles} />
          )
        ) : view === ATTENTION_VIEW ? (
          all.error ? <Text style={styles.danger}>{all.error.message}</Text> : all.pending ? <Text style={styles.muted}>Loading memories</Text> : <AttentionView facts={all.facts} styles={styles} />
        ) : (
          <MemoriesView key={view} repoKey={view === GLOBAL ? null : view} styles={styles} />
        )}
      </View>
    </ScrollView>
  );
}
