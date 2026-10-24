import { useRpc, useSettings } from "@getpaseo/plugin/client";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";
import { Text, TextInput, View } from "react-native";
import type { z } from "zod";
import { approveProposalRpc, listProposalsRpc, memorySettings, rejectProposalRpc, scanProjectRpc, tidyMemoryRpc, type Where } from "../shared/memory";
import { onMemoryChanged } from "./memory-events";
import { Button, type Styles } from "./panel-ui";

type ListedProposal = z.infer<typeof listProposalsRpc.output>["proposals"][number];

const KIND_LABEL: Record<ListedProposal["kind"], string> = {
  new: "New memory",
  replace: "Replace",
  merge: "Merge",
  retire: "Retire",
};

function ProposalCard({ proposal, where, styles, onDone }: { proposal: ListedProposal; where: Where; styles: Styles; onDone(): void }) {
  const approve = useRpc(approveProposalRpc);
  const reject = useRpc(rejectProposalRpc);
  const [subject, setSubject] = useState(proposal.subject);
  const [body, setBody] = useState(proposal.body);
  // Paths decide which agents see the fact first, so they are shown and editable like the text.
  const [paths, setPaths] = useState(proposal.paths.join(", "));
  const editedPaths = paths.split(",").map((glob) => glob.trim()).filter((glob) => glob !== "");
  const action = useMutation({ mutationFn: (run: () => Promise<unknown>) => run(), onSuccess: onDone });
  const editable = proposal.kind !== "retire";
  const from = `${proposal.source.from === "capture" ? "captured" : proposal.source.from === "project" ? "project scan" : "tidy"} by ${proposal.source.provider}`;
  return (
    <View style={styles.card}>
      <Text style={styles.body}>{KIND_LABEL[proposal.kind]}</Text>
      <Text style={styles.muted}>
        {proposal.type} · {from} · {proposal.created.slice(0, 10)}
        {proposal.reason ? ` · ${proposal.reason}` : ""}
      </Text>
      {proposal.targetFacts.map((target) => (
        <Text key={target.id} style={styles.muted}>
          {proposal.kind === "retire" ? "retires" : "replaces"}: {target.subject}: {target.body}
        </Text>
      ))}
      {editable ? (
        <>
          <TextInput accessibilityLabel="Proposed subject" value={subject} onChangeText={setSubject} style={[styles.input, { minHeight: 0 }]} />
          <TextInput accessibilityLabel="Proposed memory text" multiline value={body} onChangeText={setBody} style={styles.input} />
          <Text style={styles.muted}>About files (globs, comma-separated; empty for none). Memories about files a workspace changes are listed first.</Text>
          <TextInput accessibilityLabel="Proposed file paths" value={paths} onChangeText={setPaths} placeholder="src/api/**" style={[styles.input, { minHeight: 0 }]} />
        </>
      ) : null}
      {action.error && <Text style={styles.danger}>{action.error instanceof Error ? action.error.message : String(action.error)}</Text>}
      <View style={styles.row}>
        <Button
          label="Approve"
          styles={styles}
          onPress={() =>
            action.mutate(() =>
              approve({
                where,
                id: proposal.id,
                ...(editable && subject !== proposal.subject ? { subject } : {}),
                ...(editable && body !== proposal.body ? { body } : {}),
                ...(editable && editedPaths.join(",") !== proposal.paths.join(",") ? { paths: editedPaths } : {}),
              }),
            )
          }
        />
        <Button label="Reject" tone="danger" styles={styles} onPress={() => action.mutate(() => reject({ where, id: proposal.id }))} />
      </View>
    </View>
  );
}

// Proposed changes wait here; nothing reaches an agent until it is approved. `controls` false leaves
// out capture status, project scans, and tidy, for lists of several repos' proposals.
export function Inbox({ where, styles, onChanged, controls = true }: { where: Where; styles: Styles; onChanged(): void; controls?: boolean }) {
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
  // "Approve all" and "Reject all" each ask once, and then decide exactly the proposals that were shown
  // when asked; the question is dropped when the list changes.
  const [confirmAll, setConfirmAll] = useState<{ approved: boolean; ids: string[] } | null>(null);
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
          failed.push(error instanceof Error ? error.message : String(error));
        }
      }
      return failed;
    },
    onSettled: () => {
      setConfirmAll(null);
      refresh();
    },
  });

  if (query.isPending) return <Text style={styles.muted}>Loading proposals</Text>;
  if (query.error) return <Text style={styles.danger}>{query.error.message}</Text>;
  const captureOn = settings.status === "ready" && settings.values.captureEnabled;
  const lastRun = query.data.lastRun;
  const running = lastRun?.state === "running";
  const proposals = query.data.proposals;
  return (
    <View style={{ gap: 12 }}>
      {controls && (
      <>
      <Text style={styles.muted}>
        {captureOn
          ? `Capture is on: finished sessions propose memories here. Runs today: ${query.data.captureRunsToday}.`
          : "Capture is off. Turn it on in Settings (in the manager, or Settings > Plugins > Memorise) to have finished sessions propose memories."}
      </Text>
      <View style={styles.row}>
        <Button label="Create from project" disabled={running || scanRun.isPending} styles={styles} onPress={() => scanRun.mutate("create")} />
        <Button label="Re-check against project" disabled={running || scanRun.isPending} styles={styles} onPress={() => scanRun.mutate("refresh")} />
        <Button label={tidyRun.isPending ? "Starting tidy" : "Tidy this repo's memory"} disabled={running || tidyRun.isPending} styles={styles} onPress={() => tidyRun.mutate()} />
        <Button label="Refresh" styles={styles} onPress={refresh} />
      </View>
      <Text style={styles.muted}>A project scan sends the README, docs, and build files to the tidy provider and proposes memories; re-check also proposes fixing saved ones the files contradict. AGENTS.md and CLAUDE.md are sent too, only so it leaves out what agents already read.</Text>
      {scanRun.isSuccess && <Text style={styles.muted}>Scan started on {scanRun.data.folder}.</Text>}
      {scanRun.error && <Text style={styles.danger}>{scanRun.error.message}</Text>}
      {lastRun && (
        <Text style={lastRun.state === "failed" ? styles.danger : styles.muted}>
          {lastRun.kind === "scan" ? "Project scan" : "Tidy"}{" "}
          {lastRun.state === "running" ? "running; its proposals appear here when it finishes." : lastRun.state === "failed" ? `failed: ${lastRun.message}` : `finished: ${lastRun.message}.`}
        </Text>
      )}
      {"repoKey" in where && <Text style={styles.muted}>From the manager, tidy cannot check citations against a checkout; run it from a workspace's panel to include that check.</Text>}
      {tidyRun.error && <Text style={styles.danger}>{tidyRun.error.message}</Text>}
      </>
      )}
      {proposals.length === 0 && <Text style={styles.muted}>No proposals waiting.</Text>}
      {proposals.length > 1 && (
        <View style={styles.row}>
          {confirmAll ? (
            <>
              <Button
                label={`Confirm ${confirmAll.approved ? "approve" : "reject"} ${confirmAll.ids.length}`}
                tone={confirmAll.approved ? undefined : "danger"}
                disabled={decideAll.isPending}
                styles={styles}
                onPress={() => decideAll.mutate(confirmAll)}
              />
              <Button label="Cancel" disabled={decideAll.isPending} styles={styles} onPress={() => setConfirmAll(null)} />
            </>
          ) : (
            <>
              <Button label={`Approve all ${proposals.length}`} styles={styles} onPress={() => setConfirmAll({ approved: true, ids: proposals.map((proposal) => proposal.id) })} />
              <Button label="Reject all" tone="danger" styles={styles} onPress={() => setConfirmAll({ approved: false, ids: proposals.map((proposal) => proposal.id) })} />
            </>
          )}
        </View>
      )}
      {decideAll.data?.map((message, index) => (
        <Text key={`${index}-${message}`} style={styles.danger}>
          {message}
        </Text>
      ))}
      {proposals.map((proposal) => (
        <ProposalCard key={proposal.id} proposal={proposal} where={where} styles={styles} onDone={refresh} />
      ))}
    </View>
  );
}
