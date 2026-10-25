import { type PluginWorkspacePanelProps, useRpc, useWorkspace } from "@getpaseo/plugin/client";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { ScrollView, Text, View } from "react-native";
import { isFolderKey, listMemoriesRpc, type Scope } from "../shared/memory";
import { FactCard } from "./fact-card";
import { FactEditor } from "./fact-editor";
import { Inbox } from "./inbox";
import { onMemoryChanged } from "./memory-events";
import { Button, Chip, NoticeBar, useStyles } from "./panel-ui";
import { PreviewCard, RepoPrefsCard } from "./repo-tools";
import { errorText, projectDetail, projectName } from "./copy";

type Filter = "all" | Scope;

export function MemoryPanel({ theme, layout, workspaceId, openManager }: PluginWorkspacePanelProps & { openManager(repoKey: string | null): void }) {
  const styles = useStyles(theme, layout.compact);
  const directory = useWorkspace(workspaceId, (workspace) => workspace.directory);
  const list = useRpc(listMemoriesRpc);
  const queryClient = useQueryClient();
  const [tab, setTab] = useState<"memories" | "proposed" | "agents">("memories");
  const [filter, setFilter] = useState<Filter>("all");
  const [showHistory, setShowHistory] = useState(false);
  const [adding, setAdding] = useState(false);
  const query = useQuery({ queryKey: ["memorise", directory], queryFn: () => list({ where: { directory: directory ?? "" } }), enabled: directory !== null });
  const refresh = () => void queryClient.invalidateQueries({ queryKey: ["memorise"] });
  useEffect(() => onMemoryChanged(() => void queryClient.invalidateQueries({ queryKey: ["memorise"] })), [queryClient]);

  if (directory === null || query.isPending) return <View style={[styles.screen, styles.content]}><Text style={styles.muted}>Loading memories</Text></View>;
  if (query.error) return <View style={[styles.screen, styles.content]}><Text style={styles.danger}>{errorText(query.error)}</Text></View>;

  const { repoKey, facts } = query.data;
  const where = { directory };
  const shown = facts.filter((fact) => (filter === "all" || fact.scope === filter) && (showHistory || (fact.status === "active" && !fact.superseded)));
  return (
    <ScrollView style={styles.screen} contentContainerStyle={styles.content}>
      <Text style={styles.title}>{repoKey ? projectName(repoKey) : "Memorise"}</Text>
      <Text style={styles.muted}>
        {repoKey
          ? `${isFolderKey(repoKey) ? "A folder outside git" : "This project"}'s memories, plus global memories. ${projectDetail(repoKey)}`
          : "This folder has no project memory; only global memories apply."}
      </Text>
      <View style={styles.row}>
        <Chip label="Memories" on={tab === "memories"} onPress={() => setTab("memories")} styles={styles} />
        {repoKey && <Chip label="Suggestions" on={tab === "proposed"} onPress={() => setTab("proposed")} styles={styles} />}
        <Chip label="What agents see" on={tab === "agents"} onPress={() => setTab("agents")} styles={styles} />
        <Button label="Open in manager" styles={styles} onPress={() => openManager(repoKey)} />
      </View>
      <NoticeBar styles={styles} />
      {tab === "proposed" && repoKey ? (
        <Inbox where={where} styles={styles} onChanged={refresh} />
      ) : tab === "agents" ? (
        <>
          {repoKey && <RepoPrefsCard repoKey={repoKey} styles={styles} />}
          <PreviewCard directory={directory} styles={styles} />
        </>
      ) : (
        <>
          <View style={styles.row}>
            <Button label={adding ? "Cancel new memory" : "New memory"} styles={styles} onPress={() => setAdding((value) => !value)} />
          </View>
          {adding && <FactEditor where={where} defaultScope={repoKey ? "repo" : "global"} hasRepo={repoKey !== null} styles={styles} onDone={() => setAdding(false)} />}
          <View style={styles.row}>
            <Chip label="All" on={filter === "all"} onPress={() => setFilter("all")} styles={styles} />
            {repoKey && <Chip label="This project" on={filter === "repo"} onPress={() => setFilter("repo")} styles={styles} />}
            <Chip label="Global" on={filter === "global"} onPress={() => setFilter("global")} styles={styles} />
            <Chip label="Include archived and older versions" on={showHistory} onPress={() => setShowHistory((value) => !value)} styles={styles} />
          </View>
          {shown.length === 0 && <Text style={styles.muted}>No memories yet. Agents save what they learn here; you can also add one with New memory or /remember.</Text>}
          {shown.map((fact) => (
            <FactCard key={fact.id} fact={fact} where={where} hasRepo={repoKey !== null} styles={styles} />
          ))}
        </>
      )}
    </ScrollView>
  );
}
