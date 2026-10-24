import { type PluginSurfaceProps, useSettings } from "@getpaseo/plugin/client";
import { SettingsAction, SettingsCard, SettingsInput, SettingsSection, SettingsSelect, SettingsSwitch } from "@getpaseo/plugin/client/ui";
import { useState } from "react";
import { Text } from "react-native";
import { type MemorySettings, memorySettings, PROVIDERS } from "../shared/memory";

type NumberKey = "indexMaxLines" | "expiryDays" | "mcpPort" | "captureIdleMinutes" | "captureMinUserMessages" | "captureMaxPerDay";
type TextKey = "captureModel" | "captureInstructions" | "captureExclusions" | "tidyModel";
type DraftKey = NumberKey | TextKey;

const MEMORY_NUMBERS: ReadonlyArray<{ key: NumberKey; label: string; hint: string }> = [
  { key: "indexMaxLines", label: "Memories listed in each new agent's prompt", hint: "0 lists none; agents still get the memory tools. Up to 400." },
  { key: "expiryDays", label: "Hide agent-written memories unused for (days)", hint: "0 never hides them. Memories you saved never expire." },
  { key: "mcpPort", label: "Local port for the memory tools", hint: "Takes effect after reloading the plugin. Agents created before a change keep the old port." },
];
const CAPTURE_NUMBERS: ReadonlyArray<{ key: NumberKey; label: string; hint: string }> = [
  { key: "captureIdleMinutes", label: "Capture after the agent is idle for (minutes)", hint: "5 to 240. Each new turn restarts the wait." },
  { key: "captureMinUserMessages", label: "Capture once you have sent at least this many new messages", hint: "Counted since the last capture of that session. 1 to 50." },
  { key: "captureMaxPerDay", label: "Background runs per day, at most (capture and tidy)", hint: "1 to 100. Each run is one model call." },
];
const CAPTURE_TEXTS: ReadonlyArray<{ key: TextKey; label: string; hint: string }> = [
  { key: "captureModel", label: "Capture model", hint: "Used only when one provider reads every session. Empty, or with \"Same as the session\", each provider's default model is used." },
  { key: "captureInstructions", label: "What to capture", hint: "Optional guidance, up to 2,000 characters." },
  { key: "captureExclusions", label: "What never to capture", hint: "Optional, up to 2,000 characters." },
];
const TIDY_TEXTS: ReadonlyArray<{ key: TextKey; label: string; hint: string }> = [{ key: "tidyModel", label: "Tidy model", hint: "Empty uses the provider's default model." }];

const CAPTURE_PROVIDER_OPTIONS = [
  { label: "Same as the session (no transcript leaves its provider)", value: "session" },
  ...PROVIDERS.map((provider) => ({ label: provider, value: provider })),
] as const;
const TIDY_PROVIDER_OPTIONS = PROVIDERS.map((provider) => ({ label: provider, value: provider }));

export function MemorySettingsScreen({ theme }: PluginSurfaceProps) {
  const settings = useSettings(memorySettings);
  const [drafts, setDrafts] = useState<Partial<Record<DraftKey, string>>>({});
  const [inputError, setInputError] = useState<string | null>(null);
  if (settings.status !== "ready") {
    return <Text style={{ color: theme.colors.foregroundMuted, padding: 16 }}>{settings.status === "loading" ? "Loading settings" : settings.error}</Text>;
  }
  const save = (values: MemorySettings) => void settings.save(values, settings.revision);
  const saveDrafts = () => {
    const next = { ...settings.values };
    for (const { key, label } of [...MEMORY_NUMBERS, ...CAPTURE_NUMBERS]) {
      const draft = drafts[key]?.trim();
      if (draft === undefined) continue;
      // An emptied field must not quietly become 0, which has a meaning of its own.
      if (!/^\d+$/.test(draft)) {
        setInputError(`${label}: expected a whole number, got "${draft}"`);
        return;
      }
      next[key] = Number(draft);
    }
    for (const { key } of [...CAPTURE_TEXTS, ...TIDY_TEXTS]) {
      const draft = drafts[key];
      if (draft !== undefined) next[key] = draft;
    }
    setInputError(null);
    void settings.save(next, settings.revision).then((saved) => saved && setDrafts({}));
  };
  const input = ({ key, label, hint }: { key: DraftKey; label: string; hint: string }) => (
    <SettingsInput
      key={key}
      label={label}
      hint={hint}
      initialValue={String(settings.values[key])}
      disabled={settings.saving}
      onChangeText={(text) => setDrafts((current) => ({ ...current, [key]: text }))}
    />
  );
  const saveAction = (
    <SettingsAction label="Changes above" actionLabel="Save" disabled={settings.saving || Object.keys(drafts).length === 0} error={inputError ?? settings.saveError} onPress={saveDrafts} />
  );
  return (
    <>
      <SettingsSection title="Memorise">
        <SettingsCard>
          <SettingsSwitch
            label="Give new agents memory"
            hint="Adds the memory index and tools to new Claude, Codex, and OpenCode agents. Off leaves saved memories untouched."
            value={settings.values.enabled}
            disabled={settings.saving}
            onValueChange={(enabled) => save({ ...settings.values, enabled })}
          />
          <SettingsSwitch
            label="Approve memory reads automatically"
            hint="Search and read run without asking. Saving, changing, or retiring a memory still asks you."
            value={settings.values.autoApproveReads}
            disabled={settings.saving}
            onValueChange={(autoApproveReads) => save({ ...settings.values, autoApproveReads })}
          />
        </SettingsCard>
        <SettingsCard>
          {MEMORY_NUMBERS.map(input)}
          {saveAction}
        </SettingsCard>
      </SettingsSection>
      <SettingsSection title="Capture from finished sessions">
        <SettingsCard>
          <SettingsSwitch
            label="Propose memories from finished sessions"
            hint="After a session goes idle, a restricted background agent reads it and proposes memories. They wait in the Memory panel until you approve them. Each run is a model call."
            value={settings.values.captureEnabled}
            disabled={settings.saving}
            onValueChange={(captureEnabled) => save({ ...settings.values, captureEnabled })}
          />
          <SettingsSelect
            label="Provider that reads the session"
            hint="The transcript (with secret-shaped text removed) is sent to this provider."
            value={settings.values.captureProvider}
            options={CAPTURE_PROVIDER_OPTIONS}
            disabled={settings.saving}
            onValueChange={(captureProvider) => save({ ...settings.values, captureProvider })}
          />
        </SettingsCard>
        <SettingsCard>
          {CAPTURE_NUMBERS.map(input)}
          {CAPTURE_TEXTS.map(input)}
          {saveAction}
        </SettingsCard>
      </SettingsSection>
      <SettingsSection title="Tidy">
        <SettingsCard>
          <SettingsSelect
            label="Provider that tidies"
            hint="Reads this repo's saved memories (which agents already see) and proposes merges, rewrites, and retirements."
            value={settings.values.tidyProvider}
            options={TIDY_PROVIDER_OPTIONS}
            disabled={settings.saving}
            onValueChange={(tidyProvider) => save({ ...settings.values, tidyProvider })}
          />
          <SettingsSwitch
            label="Tidy each repo weekly"
            hint="Otherwise tidy runs only when you press Tidy in the Memory panel."
            value={settings.values.tidyWeekly}
            disabled={settings.saving}
            onValueChange={(tidyWeekly) => save({ ...settings.values, tidyWeekly })}
          />
          {TIDY_TEXTS.map(input)}
          {saveAction}
        </SettingsCard>
      </SettingsSection>
    </>
  );
}
