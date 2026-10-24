import { useRpc } from "@getpaseo/plugin/client";
import { useMutation } from "@tanstack/react-query";
import { useState } from "react";
import { Pressable, Text, TextInput, View } from "react-native";
import { type Activation, activationSchema, type Fact, type MemoryType, memoryTypeSchema, saveMemoryRpc, type Scope, updateMemoryRpc, type Where } from "../shared/memory";
import { memoryChanged } from "./memory-events";
import { Chip, type Styles } from "./panel-ui";

export const ACTIVATION_LABEL: Record<Activation, string> = {
  listed: "Listed",
  files: "Only for matching files",
  title: "Title only",
  manual: "Search only",
};

const ACTIVATION_HINT: Record<Activation, string> = {
  listed: "Ranked into every new agent's list as usual.",
  files: "Listed only when the worktree changed a file matching its paths.",
  title: "Listed by subject only; the agent reads the text when it needs it.",
  manual: "Never listed; agents find it only by searching.",
};

const splitPaths = (text: string) => text.split(",").map((glob) => glob.trim()).filter((glob) => glob !== "");

// Creates a memory, or edits one. Content changes make a new version; control changes do not.
export function FactEditor({ where, fact, defaultScope, hasRepo, styles, onDone }: { where: Where; fact?: Fact; defaultScope: Scope; hasRepo: boolean; styles: Styles; onDone(): void }) {
  const save = useRpc(saveMemoryRpc);
  const update = useRpc(updateMemoryRpc);
  const [subject, setSubject] = useState(fact?.subject ?? "");
  const [body, setBody] = useState(fact?.body ?? "");
  const [type, setType] = useState<MemoryType>(fact?.type ?? "reference");
  const [scope, setScope] = useState<Scope>(fact?.scope ?? defaultScope);
  const [paths, setPaths] = useState((fact?.paths ?? []).join(", "));
  const [pinned, setPinned] = useState(fact?.pinned ?? false);
  const [activation, setActivation] = useState<Activation>(fact?.activation ?? "listed");
  const [enabled, setEnabled] = useState(fact?.enabled ?? true);
  const [until, setUntil] = useState(fact?.until ?? "");
  // The options start open when a memory already uses one, so nothing set is ever hidden.
  const [options, setOptions] = useState(Boolean(fact && (fact.paths.length > 0 || fact.activation !== "listed" || !fact.enabled || fact.until)));
  const mutation = useMutation({
    mutationFn: async () => {
      const values = { subject: subject.trim(), body: body.trim(), type, paths: splitPaths(paths), activation, enabled, until: until.trim() === "" ? null : until.trim() };
      if (!fact) return save({ where, scope, pinned, ...values });
      const changed = Object.fromEntries(Object.entries(values).filter(([key, value]) => JSON.stringify(value) !== JSON.stringify(fact[key as keyof typeof values])));
      if (Object.keys(changed).length === 0) return null;
      return update({ where, id: fact.id, ...changed });
    },
    onSuccess: () => {
      memoryChanged();
      onDone();
    },
  });
  return (
    <View style={styles.card}>
      <Text style={styles.body}>{fact ? "Edit memory" : "New memory"}</Text>
      <TextInput accessibilityLabel="Memory subject" value={subject} onChangeText={setSubject} placeholder="Subject, a few words" style={[styles.input, { minHeight: 0 }]} />
      <TextInput accessibilityLabel="Memory text" multiline value={body} onChangeText={setBody} placeholder="One durable fact, no secrets" style={styles.input} />
      <View style={styles.row}>
        {memoryTypeSchema.options.map((option) => (
          <Chip key={option} label={option} on={type === option} onPress={() => setType(option)} styles={styles} />
        ))}
      </View>
      {!fact && (
        <View style={styles.row}>
          {hasRepo && <Chip label="This repo" on={scope === "repo"} onPress={() => setScope("repo")} styles={styles} />}
          <Chip label="Global" on={scope === "global"} onPress={() => setScope("global")} styles={styles} />
          <Chip label="Pinned" on={pinned} onPress={() => setPinned((value) => !value)} styles={styles} />
        </View>
      )}
      <View style={styles.row}>
        <Pressable accessibilityRole="button" accessibilityLabel={options ? "Hide memory options" : "Show memory options"} onPress={() => setOptions((value) => !value)} style={styles.button}>
          <Text style={styles.chipText}>{options ? "Hide options" : "Options: files, when agents see it, on/off, end date"}</Text>
        </Pressable>
      </View>
      {options && (
        <>
          <Text style={styles.muted}>About files (globs, comma-separated; empty for none)</Text>
          <TextInput accessibilityLabel="Memory file paths" value={paths} onChangeText={setPaths} placeholder="src/api/**" style={[styles.input, { minHeight: 0 }]} />
          <Text style={styles.muted}>When agents see it</Text>
          <View style={styles.row}>
            {activationSchema.options.map((option) => (
              <Chip key={option} label={ACTIVATION_LABEL[option]} on={activation === option} onPress={() => setActivation(option)} styles={styles} />
            ))}
          </View>
          <Text style={styles.muted}>{ACTIVATION_HINT[activation]}</Text>
          <View style={styles.row}>
            <Chip label={enabled ? "On for agents" : "Off for agents"} on={enabled} onPress={() => setEnabled((value) => !value)} styles={styles} />
            <Text style={styles.muted}>Until (YYYY-MM-DD, empty for no end)</Text>
            <TextInput accessibilityLabel="Memory end date" value={until} onChangeText={setUntil} placeholder="2027-01-31" style={[styles.input, { minHeight: 0, minWidth: 120 }]} />
          </View>
        </>
      )}
      {mutation.error && <Text style={styles.danger}>{mutation.error.message}</Text>}
      <View style={styles.row}>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={fact ? "Save changes" : "Save memory"}
          disabled={subject.trim() === "" || body.trim() === "" || mutation.isPending}
          onPress={() => mutation.mutate()}
          style={styles.primary}
        >
          <Text style={styles.primaryText}>{mutation.isPending ? "Saving" : "Save"}</Text>
        </Pressable>
        {fact && (
          <Pressable accessibilityRole="button" accessibilityLabel="Cancel editing" onPress={onDone} style={styles.button}>
            <Text style={styles.chipText}>Cancel</Text>
          </Pressable>
        )}
      </View>
    </View>
  );
}
