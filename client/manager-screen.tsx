import { type PluginScreenProps, useRpc } from "@getpaseo/plugin/client";
import { keepPreviousData, useMutation, useQueries, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useMemo, useState } from "react";
import { Pressable, ScrollView, Text, TextInput, View } from "react-native";
import { type BulkAction, bulkMemoryRpc, isFolderKey, listMemoriesRpc, listProposalsRpc, listReposRpc, memoryTypeSchema, proposalsSummaryRpc, scanProjectRpc, searchMemoriesRpc, tidyMemoryRpc } from "../shared/memory";
import { FactCard } from "./fact-card";
import { FactEditor } from "./fact-editor";
import { Inbox } from "./inbox";
import { activeFilters, applyFilters, ATTENTION, attentionGroups, type Control, CONTROL_LABEL, DEFAULT_FILTERS, type ListedFact, mergeScopes, shownSelection, SORT_LABEL, STATUS_LABEL, type ViewFilters } from "./manager-view";
import { memoryChanged, onMemoryChanged } from "./memory-events";
import { announce } from "./notices";
import { Button, Chip, NoticeBar, type Styles, useStyles } from "./panel-ui";
import { RepoPrefsCard, TransferCard } from "./repo-tools";
import { MemorySettingsScreen } from "./settings-screen";
import { count, errorText, KIND, projectDetail, projectName, relativeDate } from "./copy";

const GLOBAL = "global";
const ATTENTION_VIEW = "attention";
const PROPOSALS_VIEW = "proposals";
const SETTINGS_VIEW = "settings";

const BULK: { action: BulkAction; label: string }[] = [
  { action: "pin", label: "Pin" },
  { action: "unpin", label: "Unpin" },
  { action: "enable", label: "Turn on" },
  { action: "disable", label: "Turn off" },
  { action: "retire", label: "Archive" },
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
        "Show",
        (["current", "retired", "replaced", "all"] as const).map((value) => <Chip key={value} label={STATUS_LABEL[value]} on={filters.status === value} onPress={() => setFilters({ ...filters, status: value })} styles={styles} />),
      )}
      {group("Kind", [
        <Chip key="any" label="Any" on={filters.type === "any"} onPress={() => setFilters({ ...filters, type: "any" })} styles={styles} />,
        ...memoryTypeSchema.options.map((value) => <Chip key={value} label={KIND[value]} on={filters.type === value} onPress={() => setFilters({ ...filters, type: value })} styles={styles} />),
      ])}
      {group(
        "Visibility",
        (Object.keys(CONTROL_LABEL) as Control[]).map((value) => <Chip key={value} label={CONTROL_LABEL[value]} on={filters.control === value} onPress={() => setFilters({ ...filters, control: value })} styles={styles} />),
      )}
      {searching ? (
        <Text style={styles.muted}>Search results are listed best match first.</Text>
      ) : (
        group(
          "Sort",
          (["changed", "created", "most used", "least used"] as const).map((value) => <Chip key={value} label={SORT_LABEL[value]} on={filters.sort === value} onPress={() => setFilters({ ...filters, sort: value })} styles={styles} />),
        )
      )}
    </View>
  );
}

// One scope's memories: global, or one project with its suggestions and settings. `label` is a
// folder project's current name.
function MemoriesView({ repoKey, label, styles }: { repoKey: string | null; label: string | null; styles: Styles }) {
  const list = useRpc(listMemoriesRpc);
  const search = useRpc(searchMemoriesRpc);
  const bulk = useRpc(bulkMemoryRpc);
  const listProposals = useRpc(listProposalsRpc);
  const scan = useRpc(scanProjectRpc);
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
    mutationFn: async (action: BulkAction) => {
      const result = await bulk({ where, ids: chosen, action });
      // Archiving takes the memories out of this list, so the notice above it offers Undo.
      const archived = result.results.filter((item) => item.ok).map((item) => item.id);
      if (action === "retire" && archived.length > 0) announce({ text: `Archived ${count(archived.length, "memory", "memories")}`, undo: () => bulk({ where, ids: archived, action: "restore" }) });
      return result;
    },
    onSuccess: () => {
      setSelected(new Set());
      setConfirmDelete(false);
      memoryChanged();
    },
  });
  const active = activeFilters(filters, trimmed !== "");
  const pending = proposals.data?.proposals.length ?? 0;
  const anyInScope = (facts.data?.facts ?? []).some((fact) => fact.scope === scope);
  const subjectOf = (id: string) => facts.data?.facts.find((fact) => fact.id === id)?.subject ?? id;
  // The empty project's one next step: suggest memories from its files, shown in Suggestions.
  const suggest = useMutation({
    mutationFn: () => scan({ where, mode: "create" }),
    onSuccess: () => setTab("proposed"),
  });

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
      <Text style={styles.title}>{projectName(repoKey, label)}</Text>
      {repoKey && <Text style={styles.muted}>{projectDetail(repoKey)}</Text>}
      <Text style={styles.muted}>
        {repoKey
          ? isFolderKey(repoKey)
            ? "A folder outside git. Its memories reach agents started in it or in its subfolders."
            : "Shared by every clone and worktree of this project."
          : "Global memories reach agents in every project."}
      </Text>
      {repoKey && (
        <View style={styles.row}>
          <Chip label="Memories" on={tab === "memories"} onPress={() => setTab("memories")} styles={styles} />
          <Chip label={pending > 0 ? `Suggestions · ${pending}` : "Suggestions"} on={tab === "proposed"} onPress={() => setTab("proposed")} styles={styles} />
        </View>
      )}
      <NoticeBar styles={styles} />
      {tab === "proposed" && repoKey ? (
        <Inbox where={where} styles={styles} onChanged={() => memoryChanged()} />
      ) : (
        <>
          <View style={styles.row}>
            <Button label={adding ? "Cancel new memory" : "New memory"} styles={styles} onPress={() => setAdding((value) => !value)} />
            <Button label={selecting ? "Done selecting" : "Select"} styles={styles} onPress={() => (selecting ? stopSelecting() : setSelecting(true))} />
            <Button label={showTools ? (repoKey ? "Hide project settings" : "Hide import and export") : repoKey ? "Project settings" : "Import and export"} styles={styles} onPress={() => setShowTools((value) => !value)} />
          </View>
          {adding && <FactEditor where={where} defaultScope={scope} hasRepo={repoKey !== null} styles={styles} onDone={() => setAdding(false)} />}
          {showTools && (
            <>
              {repoKey && <RepoPrefsCard repoKey={repoKey} styles={styles} />}
              <TransferCard where={where} scope={scope} styles={styles} />
            </>
          )}
          <View style={[styles.row, { flexWrap: "nowrap" }]}>
            <TextInput accessibilityLabel="Search memories" value={query} onChangeText={setQuery} placeholderTextColor={styles.muted.color} placeholder="Search titles, text, and files" style={[styles.input, { minHeight: 0, flex: 1 }]} />
            <Button label={`${showFilters ? "Hide filters" : "Filters"}${active.length > 0 ? ` · ${active.length}` : ""}`} styles={styles} onPress={() => setShowFilters((value) => !value)} />
          </View>
          {active.length > 0 && (
            <View style={styles.row}>
              {active.map((filter) => (
                <Chip key={filter.key} label={`${filter.label} ✕`} on onPress={() => setFilters({ ...filters, [filter.key]: DEFAULT_FILTERS[filter.key] })} styles={styles} />
              ))}
              <Button label="Clear filters" styles={styles} onPress={() => setFilters(DEFAULT_FILTERS)} />
            </View>
          )}
          {showFilters && <FilterPanel filters={filters} setFilters={setFilters} searching={trimmed !== ""} styles={styles} />}
          {found.error && <Text style={styles.danger}>{errorText(found.error)}</Text>}
          {selecting && (
            <View style={[styles.card, styles.row]}>
              <Text style={styles.body}>{chosen.length} selected</Text>
              <Button label="Select all shown" styles={styles} onPress={() => setSelected(new Set(shown.map((fact) => fact.id)))} />
              {chosen.length > 0 &&
                BULK.map(({ action, label }) => <Button key={action} label={label} styles={styles} onPress={() => runBulk.mutate(action)} />)}
              {chosen.length > 0 && !confirmDelete && <Button label="Delete" tone="danger" styles={styles} onPress={() => setConfirmDelete(true)} />}
            </View>
          )}
          {selecting && confirmDelete && chosen.length > 0 && (
            <View style={[styles.card, styles.row]}>
              <Text style={[styles.body, { flexShrink: 1 }]}>Delete {count(chosen.length, "memory", "memories")}? This can't be undone.</Text>
              <Button label={`Delete ${chosen.length}`} tone="danger" styles={styles} onPress={() => runBulk.mutate("delete")} />
              <Button label="Cancel" styles={styles} onPress={() => setConfirmDelete(false)} />
            </View>
          )}
          {runBulk.data?.results.filter((result) => !result.ok).map((result) => (
            <Text key={result.id} style={styles.danger}>
              “{subjectOf(result.id)}”: {result.error}
            </Text>
          ))}
          {runBulk.error && <Text style={styles.danger}>{errorText(runBulk.error)}</Text>}
          {facts.isPending && <Text style={styles.muted}>Loading memories</Text>}
          {facts.error && <Text style={styles.danger}>{errorText(facts.error)}</Text>}
          {facts.data && !anyInScope && trimmed === "" && (
            <View style={styles.card}>
              <Text style={styles.body}>No memories yet</Text>
              <Text style={styles.muted}>
                {repoKey ? "Agents save what they learn about this project here. You can also suggest memories from its files." : "Add a preference or fact that applies to every project."}
              </Text>
              <View style={styles.row}>
                {repoKey ? (
                  <Button label={suggest.isPending ? "Starting" : "Suggest from project files"} disabled={suggest.isPending} styles={styles} onPress={() => suggest.mutate()} />
                ) : (
                  <Button label="New memory" styles={styles} onPress={() => setAdding(true)} />
                )}
              </View>
              {suggest.error && <Text style={styles.danger}>{errorText(suggest.error)}</Text>}
            </View>
          )}
          {facts.data && (anyInScope || trimmed !== "") && shown.length === 0 && (
            <View style={styles.card}>
              <Text style={styles.body}>No memories match</Text>
              <View style={styles.row}>
                <Button
                  label="Clear search and filters"
                  styles={styles}
                  onPress={() => {
                    setQuery("");
                    setFilters(DEFAULT_FILTERS);
                  }}
                />
              </View>
            </View>
          )}
          {shown.length > 0 && <Text style={styles.muted}>{count(shown.length, "memory", "memories")}</Text>}
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
// One repo's proposals as a card: the header (repo and count) opens and closes it; open, it shows
// the repo's inbox.
function RepoProposalsCard({ repoKey, pending, open, keyboard, onToggle, styles }: { repoKey: string; pending: number; open: boolean; keyboard: boolean; onToggle(): void; styles: Styles }) {
  return (
    <View style={styles.card}>
      <Pressable
        accessibilityRole="button"
        accessibilityState={{ expanded: open }}
        accessibilityLabel={`${open ? "Collapse" : "Expand"} ${projectName(repoKey)}, ${pending} to review`}
        onPress={onToggle}
        style={[styles.row, { justifyContent: "space-between", flexWrap: "nowrap" }]}
      >
        <View style={{ flexShrink: 1 }}>
          <Text style={styles.body} numberOfLines={1}>
            {open ? "▾" : "▸"} {projectName(repoKey)}
          </Text>
          <Text style={styles.muted} numberOfLines={1}>
            {projectDetail(repoKey)}
          </Text>
        </View>
        <Text style={styles.muted}>{pending} to review</Text>
      </Pressable>
      {open && <Inbox where={{ repoKey }} styles={styles} onChanged={() => memoryChanged()} controls={false} keyboard={keyboard} />}
    </View>
  );
}

function ProposalsView({ pending, repoKeys, styles }: { pending: { repoKey: string; pending: number }[]; repoKeys: string[]; styles: Styles }) {
  const tidy = useRpc(tidyMemoryRpc);
  // Every repo starts collapsed, so the list of repos fits on one screen.
  const [open, setOpen] = useState<ReadonlySet<string>>(new Set());
  const allOpen = pending.length > 0 && pending.every((repo) => open.has(repo.repoKey));
  const toggle = (repoKey: string) =>
    setOpen((current) => {
      const next = new Set(current);
      if (!next.delete(repoKey)) next.add(repoKey);
      return next;
    });
  // Each project is cleaned up on its own, so one refusal (daily limit, one already running) does not stop the rest.
  const tidyAll = useMutation({
    mutationFn: async () => {
      const results: string[] = [];
      for (const repoKey of repoKeys) {
        try {
          await tidy({ where: { repoKey } });
          results.push(`${projectName(repoKey)}: clean-up started`);
        } catch (error) {
          results.push(`${projectName(repoKey)}: ${errorText(error)}`);
        }
      }
      return results;
    },
  });
  const total = pending.reduce((sum, repo) => sum + repo.pending, 0);
  return (
    <View style={{ gap: 12 }}>
      <Text style={styles.title}>Suggestions</Text>
      <Text style={styles.muted}>
        {total === 0
          ? "Nothing to review. Suggestions from sessions, project files, and clean-ups appear here."
          : "Memories and changes suggested by sessions, project files, and clean-ups, across every project. Nothing reaches agents until you approve it, unless a project saves suggestions without review."}
      </Text>
      <View style={styles.row}>
        <Button label={tidyAll.isPending ? "Starting clean-up" : `Clean up all projects (${repoKeys.length})`} disabled={tidyAll.isPending || repoKeys.length === 0} styles={styles} onPress={() => tidyAll.mutate()} />
        {pending.length > 1 && <Button label={allOpen ? "Collapse all" : "Expand all"} styles={styles} onPress={() => setOpen(allOpen ? new Set() : new Set(pending.map((repo) => repo.repoKey)))} />}
      </View>
      {tidyAll.data?.map((line) => (
        <Text key={line} style={styles.muted}>
          {line}
        </Text>
      ))}
      {pending.map((repo) => (
        // Review keys go to the open card only while just one is open, so a key never acts on two.
        <RepoProposalsCard key={repo.repoKey} repoKey={repo.repoKey} pending={repo.pending} open={open.has(repo.repoKey)} keyboard={open.size === 1} onToggle={() => toggle(repo.repoKey)} styles={styles} />
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
      <Text style={styles.muted}>{total === 0 ? "Nothing to look at. Memories agents can't see, or never use, appear here." : "Memories agents can't see, or have never used. Edit, pin, turn on, or archive each one."}</Text>
      <NoticeBar styles={styles} />
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
  const shownRepos = [...listed, ...missing.map((key) => ({ repoKey: key, active: 0, retired: 0, lastModified: null, label: null }))];
  // Repos listed only for an open workspace or proposals have no memories to load or tidy.
  const all = useAllFacts(listed.filter((repo) => repo.repoKey === null || repo.active + repo.retired > 0).map((repo) => repo.repoKey));
  const attentionCount = Object.values(attentionGroups(all.facts)).reduce((sum, items) => sum + (items?.length ?? 0), 0);

  const repoEntries = shownRepos.map((repo) => ({
    id: repo.repoKey ?? GLOBAL,
    label: projectName(repo.repoKey, repo.label),
    detail: [
      repo.repoKey === null ? "Every project" : isFolderKey(repo.repoKey) ? "Folder" : null,
      repo.active > 0 ? count(repo.active, "memory", "memories") : "No memories yet",
      repo.retired > 0 ? `${repo.retired} archived` : null,
      repo.lastModified ? `changed ${relativeDate(repo.lastModified)}` : null,
    ]
      .filter((part): part is string => part !== null)
      .join(" · "),
  }));
  const manageEntries = [
    { id: PROPOSALS_VIEW, label: "Suggestions", detail: pendingTotal > 0 ? `${pendingTotal} to review` : "Nothing to review" },
    { id: ATTENTION_VIEW, label: "Needs attention", detail: attentionCount > 0 ? `${attentionCount} to look at` : "Nothing to look at" },
    { id: SETTINGS_VIEW, label: "Settings", detail: "Memory, suggestions, clean-up" },
  ];
  // Narrow layouts show the same entries as one wrapping row of chips above the content.
  const nav = layout.compact ? (
    <View style={{ gap: 8 }}>
      <Text style={styles.title}>Memorise</Text>
      {repos.error && <Text style={styles.danger}>{errorText(repos.error)}</Text>}
      <View style={styles.row}>
        {[...repoEntries, ...manageEntries].map((entry) => (
          <Chip key={entry.id} label={entry.id === ATTENTION_VIEW && attentionCount > 0 ? `${entry.label} · ${attentionCount}` : entry.id === PROPOSALS_VIEW && pendingTotal > 0 ? `${entry.label} · ${pendingTotal}` : entry.label} on={view === entry.id} onPress={() => setView(entry.id)} styles={styles} />
        ))}
      </View>
    </View>
  ) : (
    <View style={{ gap: 4, width: 260 }}>
      <Text style={styles.title}>Memorise</Text>
      {repos.error && <Text style={styles.danger}>{errorText(repos.error)}</Text>}
      <Text style={styles.label}>Memories</Text>
      {repos.isPending && <Text style={styles.muted}>Loading projects</Text>}
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
            <Text style={styles.danger}>{errorText(proposals.error)}</Text>
          ) : (
            <ProposalsView pending={proposals.data?.repos ?? []} repoKeys={listed.flatMap((repo) => (repo.repoKey && repo.active >= 2 ? [repo.repoKey] : []))} styles={styles} />
          )
        ) : view === ATTENTION_VIEW ? (
          all.error ? <Text style={styles.danger}>{errorText(all.error)}</Text> : all.pending ? <Text style={styles.muted}>Loading memories</Text> : <AttentionView facts={all.facts} styles={styles} />
        ) : (
          <MemoriesView key={view} repoKey={view === GLOBAL ? null : view} label={shownRepos.find((repo) => repo.repoKey === view)?.label ?? null} styles={styles} />
        )}
      </View>
    </ScrollView>
  );
}
