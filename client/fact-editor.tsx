import { useRpc } from "@getpaseo/plugin/client";
import { useMutation } from "@tanstack/react-query";
import { useState } from "react";
import { Pressable, Switch, Text, TextInput, View } from "react-native";
import { type Activation, activationSchema, type Fact, type MemoryType, memoryTypeSchema, saveMemoryRpc, type Scope, updateMemoryRpc, type Where } from "../shared/memory";
import { ACTIVATION, KIND } from "./copy";
import { memoryChanged } from "./memory-events";
import { Chip, type Styles } from "./panel-ui";
import { errorText } from "./copy";

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
      <Text style={styles.muted}>Title</Text>
      <TextInput accessibilityLabel="Title" value={subject} onChangeText={setSubject} placeholderTextColor={styles.muted.color} placeholder="A few words, such as “Run tests with Docker”" style={[styles.input, { minHeight: 0 }]} />
      <Text style={styles.muted}>Memory</Text>
      <TextInput accessibilityLabel="Memory" multiline value={body} onChangeText={setBody} placeholderTextColor={styles.muted.color} placeholder="One fact agents should know. No secrets." style={styles.input} />
      <Text style={styles.muted}>Kind</Text>
      <View style={styles.row}>
        {memoryTypeSchema.options.map((option) => (
          <Chip key={option} label={KIND[option]} on={type === option} onPress={() => setType(option)} styles={styles} />
        ))}
      </View>
      {!fact && (
        <>
          <Text style={styles.muted}>For</Text>
          <View style={styles.row}>
            {hasRepo && <Chip label="This project" on={scope === "repo"} onPress={() => setScope("repo")} styles={styles} />}
            <Chip label="Global (every project)" on={scope === "global"} onPress={() => setScope("global")} styles={styles} />
            <Chip label="Pinned" on={pinned} onPress={() => setPinned((value) => !value)} styles={styles} />
          </View>
        </>
      )}
      <View style={styles.row}>
        <Pressable accessibilityRole="button" accessibilityState={{ expanded: options }} accessibilityLabel={options ? "Hide when agents see this" : "Show when agents see this"} onPress={() => setOptions((value) => !value)} style={styles.button}>
          <Text style={styles.chipText}>{options ? "▾ When agents see this" : "▸ When agents see this"}</Text>
        </Pressable>
      </View>
      {options && (
        <>
          <Text style={styles.muted}>About files</Text>
          <TextInput accessibilityLabel="About files" value={paths} onChangeText={setPaths} placeholderTextColor={styles.muted.color} placeholder="src/api/**, Makefile" style={[styles.input, { minHeight: 0 }]} />
          <Text style={styles.muted}>File patterns, separated by commas. Leave empty if it's not about specific files.</Text>
          <Text style={styles.muted}>Show it to agents</Text>
          <View style={styles.row}>
            {activationSchema.options.map((option) => (
              <Chip key={option} label={ACTIVATION[option].label} on={activation === option} onPress={() => setActivation(option)} styles={styles} />
            ))}
          </View>
          <Text style={styles.muted}>{ACTIVATION[activation].hint}</Text>
          <View style={styles.row}>
            <Switch accessibilityLabel="On for agents" value={enabled} onValueChange={setEnabled} />
            <Text style={styles.body}>On for agents</Text>
          </View>
          <Text style={styles.muted}>{enabled ? "Agents can see this memory." : "Kept here, but agents don't see it."}</Text>
          <Text style={styles.muted}>Expires on</Text>
          <TextInput accessibilityLabel="Expires on" value={until} onChangeText={setUntil} placeholderTextColor={styles.muted.color} placeholder="YYYY-MM-DD" style={[styles.input, { minHeight: 0, maxWidth: 200 }]} />
          <Text style={styles.muted}>Leave empty to keep it. After this day agents no longer see it.</Text>
        </>
      )}
      {mutation.error && <Text style={styles.danger}>{errorText(mutation.error)}</Text>}
      <View style={styles.row}>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={fact ? "Save changes" : "Save memory"}
          disabled={subject.trim() === "" || body.trim() === "" || mutation.isPending}
          onPress={() => mutation.mutate()}
          style={styles.primary}
        >
          <Text style={styles.primaryText}>{mutation.isPending ? "Saving" : fact ? "Save changes" : "Save memory"}</Text>
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
