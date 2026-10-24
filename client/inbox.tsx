import { useRpc, useSettings } from "@getpaseo/plugin/client";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { Text, TextInput, View } from "react-native";
import type { z } from "zod";
import { approveProposalRpc, listProposalsRpc, memorySettings, rejectProposalRpc, tidyMemoryRpc } from "../shared/memory";
import { onMemoryChanged } from "./memory-events";
import { Button, type Styles } from "./panel-ui";

type ListedProposal = z.infer<typeof listProposalsRpc.output>["proposals"][number];

const KIND_LABEL: Record<ListedProposal["kind"], string> = {
  new: "New memory",
  replace: "Replace",
  merge: "Merge",
  retire: "Retire",
};

function ProposalCard({ proposal, directory, styles, onDone }: { proposal: ListedProposal; directory: string; styles: Styles; onDone(): void }) {
  const approve = useRpc(approveProposalRpc);
  const reject = useRpc(rejectProposalRpc);
  const [subject, setSubject] = useState(proposal.subject);
  const [body, setBody] = useState(proposal.body);
  // Paths decide which agents see the fact first, so they are shown and editable like the text.
  const [paths, setPaths] = useState(proposal.paths.join(", "));
  const editedPaths = paths.split(",").map((glob) => glob.trim()).filter((glob) => glob !== "");
  const action = useMutation({ mutationFn: (run: () => Promise<unknown>) => run(), onSuccess: onDone });
  const editable = proposal.kind !== "retire";
  const from = proposal.source.from === "capture" ? `captured by ${proposal.source.provider}` : `tidy by ${proposal.source.provider}`;
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
                directory,
                id: proposal.id,
                ...(editable && subject !== proposal.subject ? { subject } : {}),
                ...(editable && body !== proposal.body ? { body } : {}),
                ...(editable && editedPaths.join(",") !== proposal.paths.join(",") ? { paths: editedPaths } : {}),
              }),
            )
          }
        />
        <Button label="Reject" tone="danger" styles={styles} onPress={() => action.mutate(() => reject({ directory, id: proposal.id }))} />
      </View>
    </View>
  );
}

// Proposed changes wait here; nothing reaches an agent until it is approved.
export function Inbox({ directory, styles, onChanged }: { directory: string; styles: Styles; onChanged(): void }) {
  const list = useRpc(listProposalsRpc);
  const tidy = useRpc(tidyMemoryRpc);
  const settings = useSettings(memorySettings);
  const queryClient = useQueryClient();
  const query = useQuery({ queryKey: ["memorise-proposals", directory], queryFn: () => list({ directory }) });
  const refresh = () => {
    void queryClient.invalidateQueries({ queryKey: ["memorise-proposals", directory] });
    onChanged();
  };
  useEffect(() => onMemoryChanged(() => void queryClient.invalidateQueries({ queryKey: ["memorise-proposals"] })), [queryClient]);
  const tidyRun = useMutation({ mutationFn: () => tidy({ directory }) });

  if (query.isPending) return <Text style={styles.muted}>Loading proposals</Text>;
  if (query.error) return <Text style={styles.danger}>{query.error.message}</Text>;
  const captureOn = settings.status === "ready" && settings.values.captureEnabled;
  return (
    <View style={{ gap: 12 }}>
      <Text style={styles.muted}>
        {captureOn
          ? `Capture is on: finished sessions propose memories here. Runs today: ${query.data.captureRunsToday}.`
          : "Capture is off. Turn it on in Settings > Plugins > Memorise to have finished sessions propose memories."}
      </Text>
      <View style={styles.row}>
        <Button label={tidyRun.isPending ? "Starting tidy" : "Tidy this repo's memory"} styles={styles} onPress={() => tidyRun.mutate()} />
        <Button label="Refresh" styles={styles} onPress={refresh} />
      </View>
      {tidyRun.isSuccess && <Text style={styles.muted}>Tidy started. Its proposals appear here in a few minutes; press Refresh.</Text>}
      {tidyRun.error && <Text style={styles.danger}>{tidyRun.error.message}</Text>}
      {query.data.proposals.length === 0 && <Text style={styles.muted}>No proposals waiting.</Text>}
      {query.data.proposals.map((proposal) => (
        <ProposalCard key={proposal.id} proposal={proposal} directory={directory} styles={styles} onDone={refresh} />
      ))}
    </View>
  );
}
