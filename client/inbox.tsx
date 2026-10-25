import { useRpc, useSettings } from "@getpaseo/plugin/client";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useCallback, useEffect, useRef, useState } from "react";
import { Text, TextInput, View } from "react-native";
import type { z } from "zod";
import { approveProposalRpc, listProposalsRpc, memorySettings, rejectProposalRpc, scanProjectRpc, tidyMemoryRpc, type Where } from "../shared/memory";
import { onMemoryChanged } from "./memory-events";
import { Badge, Button, type Styles } from "./panel-ui";
import { moveFocus, reviewAction } from "./review-keys";
import { keyboardAvailable, onKey, scrollIntoView } from "./web";
import { count, errorText, KIND, projectName, providerName, relativeDate } from "./copy";

type ListedProposal = z.infer<typeof listProposalsRpc.output>["proposals"][number];

const KIND_LABEL: Record<ListedProposal["kind"], string> = {
  new: "New memory",
  replace: "Rewrite",
  merge: "Merge",
  retire: "Archive",
};

const TARGET_VERB: Record<ListedProposal["kind"], string> = { new: "", replace: "Rewrites", merge: "Merges", retire: "Archives" };

// Where a suggestion came from, so it can be judged: its source, who wrote it, and when.
function sourceText(proposal: ListedProposal): string {
  const from = proposal.source.from === "capture" ? "Suggested from a session" : proposal.source.from === "project" ? "Suggested from project files" : "Suggested by a clean-up";
  return `${from} · ${providerName(proposal.source.provider)} · ${relativeDate(proposal.created)}`;
}

type CardActions = { approve(): void; reject(): void; node(): unknown };
// One empty list, so the review keys are not re-subscribed on every render while loading.
const NO_PROPOSALS: ListedProposal[] = [];

// One suggestion. `focused` marks it for review keys; `register` hands the inbox its approve and
// reject (with the card's current edits), so a key acts exactly as the buttons do.
function ProposalCard({ proposal, where, styles, onDone, focused, register }: { proposal: ListedProposal; where: Where; styles: Styles; onDone(): void; focused: boolean; register(id: string, actions: CardActions | null): void }) {
  const approve = useRpc(approveProposalRpc);
  const reject = useRpc(rejectProposalRpc);
  const [subject, setSubject] = useState(proposal.subject);
  const [body, setBody] = useState(proposal.body);
  // Paths decide which agents see the fact first, so they are shown and editable like the text.
  const [paths, setPaths] = useState(proposal.paths.join(", "));
  const editedPaths = paths.split(",").map((glob) => glob.trim()).filter((glob) => glob !== "");
  const action = useMutation({ mutationFn: (run: () => Promise<unknown>) => run(), onSuccess: onDone });
  const editable = proposal.kind !== "retire";
  const view = useRef<View>(null);
  const actions: CardActions = {
    node: () => view.current,
    approve: () =>
      action.mutate(() =>
        approve({
          where,
          id: proposal.id,
          ...(editable && subject !== proposal.subject ? { subject } : {}),
          ...(editable && body !== proposal.body ? { body } : {}),
          ...(editable && editedPaths.join(",") !== proposal.paths.join(",") ? { paths: editedPaths } : {}),
        }),
      ),
    reject: () => action.mutate(() => reject({ where, id: proposal.id })),
  };
  // Re-registered after every render, so a key always uses the latest edits.
  useEffect(() => register(proposal.id, actions));
  useEffect(() => () => register(proposal.id, null), [proposal.id, register]);
  return (
    <View ref={view} style={[styles.card, focused && { borderColor: styles.chipOn.borderColor, borderWidth: 2 }]} accessibilityState={{ selected: focused }}>
      <View style={styles.row}>
        <Text style={styles.body}>{KIND_LABEL[proposal.kind]}</Text>
        <Badge label={KIND[proposal.type]} styles={styles} />
      </View>
      <Text style={styles.muted}>{sourceText(proposal)}</Text>
      {proposal.reason ? <Text style={styles.muted}>Why: {proposal.reason}</Text> : null}
      {proposal.targetFacts.map((target) => (
        <Text key={target.id} style={styles.muted}>
          {TARGET_VERB[proposal.kind]} “{target.subject}”: {target.body}
        </Text>
      ))}
      {editable ? (
        <>
          <Text style={styles.muted}>Title</Text>
          <TextInput accessibilityLabel="Title" value={subject} onChangeText={setSubject} style={[styles.input, { minHeight: 0 }]} />
          <Text style={styles.muted}>Memory</Text>
          <TextInput accessibilityLabel="Memory" multiline value={body} onChangeText={setBody} style={styles.input} />
          <Text style={styles.muted}>About files</Text>
          <TextInput accessibilityLabel="About files" value={paths} onChangeText={setPaths} placeholderTextColor={styles.muted.color} placeholder="src/api/**" style={[styles.input, { minHeight: 0 }]} />
          <Text style={styles.muted}>File patterns, separated by commas. Memories about files a workspace changes are listed first.</Text>
        </>
      ) : null}
      {action.error && <Text style={styles.danger}>{errorText(action.error)}</Text>}
      <View style={styles.row}>
        <Button label="Approve" styles={styles} onPress={actions.approve} />
        <Button label="Reject" tone="danger" styles={styles} onPress={actions.reject} />
      </View>
    </View>
  );
}

// Suggestions wait here; nothing reaches an agent until it is approved. `controls` false leaves out
// the session status, project files, and clean-up buttons, for lists of several projects'
// suggestions. `keyboard` turns on review keys (web only); only one inbox on screen should have it.
export function Inbox({ where, styles, onChanged, controls = true, keyboard = controls }: { where: Where; styles: Styles; onChanged(): void; controls?: boolean; keyboard?: boolean }) {
  const list = useRpc(listProposalsRpc);
  const tidy = useRpc(tidyMemoryRpc);
  const settings = useSettings(memorySettings);
  const queryClient = useQueryClient();
  // While a tidy or project scan runs, the list is fetched again every few seconds, so its outcome and
  // its proposals appear without pressing Refresh.
  const query = useQuery({
    queryKey: ["memorise-proposals", where],
    queryFn: () => list({ where }),
    refetchInterval: (current) => (current.state.data?.lastRun?.state === "running" ? 5_000 : false),
  });
  const refresh = () => {
    void queryClient.invalidateQueries({ queryKey: ["memorise-proposals"] });
    onChanged();
  };
  useEffect(() => onMemoryChanged(() => void queryClient.invalidateQueries({ queryKey: ["memorise-proposals"] })), [queryClient]);
  const tidyRun = useMutation({ mutationFn: () => tidy({ where }) });
  const scan = useRpc(scanProjectRpc);
  const approve = useRpc(approveProposalRpc);
  const reject = useRpc(rejectProposalRpc);
  const scanRun = useMutation({ mutationFn: (mode: "create" | "refresh") => scan({ where, mode }) });
  // "Reject all" asks once, and then rejects exactly the suggestions shown when asked; the question
  // is dropped when the list changes.
  const [confirmAll, setConfirmAll] = useState<{ approved: boolean; ids: string[] } | null>(null);
  const [focus, setFocus] = useState(0);
  const cards = useRef(new Map<string, CardActions>());
  const register = useCallback((id: string, actions: CardActions | null) => {
    if (actions) cards.current.set(id, actions);
    else cards.current.delete(id);
  }, []);
  const listed = query.data?.proposals ?? NO_PROPOSALS;
  const focused = Math.min(focus, Math.max(listed.length - 1, 0));
  useEffect(() => {
    if (!keyboard) return;
    return onKey((key) => {
      const action = reviewAction(key);
      if (!action || listed.length === 0) return false;
      if (action === "next" || action === "previous") {
        const next = moveFocus(focused, action, listed.length);
        setFocus(next);
        // Only a key move scrolls, so opening the list never jumps the page.
        scrollIntoView(cards.current.get(listed[next].id)?.node());
      } else cards.current.get(listed[focused].id)?.[action]();
      return true;
    });
  }, [keyboard, listed, focused]);
  const shownIds = query.data?.proposals.map((proposal) => proposal.id).join(",") ?? "";
  useEffect(() => setConfirmAll(null), [shownIds]);
  // When a run finishes, its proposals and any memories it saved automatically are shown everywhere.
  const runState = query.data?.lastRun?.state;
  const previousRunState = useRef(runState);
  useEffect(() => {
    if (previousRunState.current === "running" && runState !== "running") refresh();
    previousRunState.current = runState;
  });
  // Each proposal is applied on its own, so one that fails does not stop the rest; failures are listed.
  const decideAll = useMutation({
    mutationFn: async ({ ids, approved }: { ids: string[]; approved: boolean }) => {
      const failed: string[] = [];
      for (const id of ids) {
        try {
          if (approved) await approve({ where, id });
          else await reject({ where, id });
        } catch (error) {
          failed.push(errorText(error));
        }
      }
      return failed;
    },
    onSettled: () => {
      setConfirmAll(null);
      refresh();
    },
  });

  if (query.isPending) return <Text style={styles.muted}>Loading suggestions</Text>;
  if (query.error) return <Text style={styles.danger}>{errorText(query.error)}</Text>;
  const captureOn = settings.status === "ready" && settings.values.captureEnabled;
  const runLimit = settings.status === "ready" ? settings.values.captureMaxPerDay : null;
  const lastRun = query.data.lastRun;
  const running = lastRun?.state === "running";
  const proposals = query.data.proposals;
  return (
    <View style={{ gap: 12 }}>
      {controls && (
      <>
      <Text style={styles.muted}>
        {captureOn
          ? `Suggestions from sessions are on. Background runs today: ${query.data.captureRunsToday}${runLimit ? ` of ${runLimit}` : ""}.`
          : "Suggestions from sessions are off. Turn them on in Settings to have finished sessions suggest memories."}
      </Text>
      <View style={styles.row}>
        <Button label="Suggest from project files" disabled={running || scanRun.isPending} styles={styles} onPress={() => scanRun.mutate("create")} />
        <Button label="Check memories against project files" disabled={running || scanRun.isPending} styles={styles} onPress={() => scanRun.mutate("refresh")} />
        <Button label={tidyRun.isPending ? "Starting clean-up" : "Suggest clean-ups"} disabled={running || tidyRun.isPending} styles={styles} onPress={() => tidyRun.mutate()} />
        <Button label="Refresh" styles={styles} onPress={refresh} />
      </View>
      <Text style={styles.muted}>
        Suggesting from project files reads the README, docs, and build files and suggests memories. Checking also suggests fixes to saved memories those files contradict. Clean-ups suggest merging duplicates, rewording unclear memories, and archiving outdated ones.
      </Text>
      {scanRun.isSuccess && <Text style={styles.muted}>Started on {scanRun.data.folder}.</Text>}
      {scanRun.error && <Text style={styles.danger}>{errorText(scanRun.error)}</Text>}
      {lastRun && (
        <Text style={lastRun.state === "failed" ? styles.danger : styles.muted}>
          {lastRun.kind === "scan" ? "Suggesting from project files" : "Clean-up"}
          {lastRun.state === "running" ? ": running. Its suggestions appear here when it finishes." : lastRun.state === "failed" ? ` failed: ${lastRun.message}` : `: done, ${lastRun.message}.`}
        </Text>
      )}
      {"repoKey" in where && <Text style={styles.muted}>From here, a clean-up can't check cited files. Run it from a workspace's Memorise panel to include that check.</Text>}
      {tidyRun.error && <Text style={styles.danger}>{errorText(tidyRun.error)}</Text>}
      </>
      )}
      {proposals.length === 0 && <Text style={styles.muted}>Nothing to review.</Text>}
      {proposals.length > 1 && (
        <View style={styles.row}>
          {confirmAll ? (
            <>
              <Text style={[styles.body, { flexShrink: 1 }]}>
                Reject {count(confirmAll.ids.length, "suggestion", "suggestions")}{"repoKey" in where && where.repoKey ? ` in ${projectName(where.repoKey)}` : ""}? They won't be suggested again.
              </Text>
              <Button label={`Reject ${confirmAll.ids.length}`} tone="danger" disabled={decideAll.isPending} styles={styles} onPress={() => decideAll.mutate(confirmAll)} />
              <Button label="Cancel" disabled={decideAll.isPending} styles={styles} onPress={() => setConfirmAll(null)} />
            </>
          ) : (
            <>
              {/* Approving needs no question: an approved memory can be archived afterwards. */}
              <Button label={decideAll.isPending ? "Approving" : `Approve all ${proposals.length}`} disabled={decideAll.isPending} styles={styles} onPress={() => decideAll.mutate({ approved: true, ids: proposals.map((proposal) => proposal.id) })} />
              <Button label="Reject all" tone="danger" disabled={decideAll.isPending} styles={styles} onPress={() => setConfirmAll({ approved: false, ids: proposals.map((proposal) => proposal.id) })} />
            </>
          )}
        </View>
      )}
      {decideAll.data?.map((message, index) => (
        <Text key={`${index}-${message}`} style={styles.danger}>
          {message}
        </Text>
      ))}
      {keyboard && keyboardAvailable && proposals.length > 0 && <Text style={styles.muted}>Keys: j and k to move, a to approve, r to reject.</Text>}
      {proposals.map((proposal, index) => (
        <ProposalCard key={proposal.id} proposal={proposal} where={where} styles={styles} onDone={refresh} focused={keyboard && keyboardAvailable && index === focused} register={register} />
      ))}
    </View>
  );
}
