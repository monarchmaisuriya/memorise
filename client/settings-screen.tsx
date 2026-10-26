import { type PluginSurfaceProps, useSettings } from "@getpaseo/plugin/client";
import { SettingsAction, SettingsCard, SettingsInput, SettingsSection, SettingsSelect, SettingsSwitch } from "@getpaseo/plugin/client/ui";
import { useState } from "react";
import { Text } from "react-native";
import { type MemorySettings, memorySettings, PROVIDERS } from "../shared/memory";
import { errorText } from "./copy";

type NumberKey = "memoryMaxChars" | "indexMaxLines" | "expiryDays" | "mcpPort" | "captureIdleMinutes" | "captureMinUserMessages" | "captureMaxPerDay";
type TextKey = "captureModel" | "captureInstructions" | "captureExclusions" | "tidyModel";
type DraftKey = NumberKey | TextKey;

// Main level: what most people change. Advanced: limits, timing, models, and the tools port.
const ADVANCED_NUMBERS: ReadonlyArray<{ key: NumberKey; label: string; hint: string }> = [
  {
    key: "memoryMaxChars",
    label: "Longest memory (characters)",
    hint: "Default 1,000, from 200 to 10,000. Prompts list only each memory's first 160 characters, but agents receive the whole text each time they open or search one, and clean-ups read every memory in full, so longer memories use more context and tokens.",
  },
  { key: "indexMaxLines", label: "Memories in each new agent's prompt", hint: "Default 150, up to 400. 0 lists none; agents can still search." },
  { key: "expiryDays", label: "Hide unused agent memories after (days)", hint: "Default 60. 0 never hides them. Memories you saved are never hidden." },
  { key: "captureIdleMinutes", label: "Wait after a session goes quiet (minutes)", hint: "Default 20, from 5 to 240. A new message restarts the wait." },
  { key: "captureMinUserMessages", label: "Messages needed before suggesting", hint: "Default 3, from 1 to 50. Counts your new messages since that session's last suggestions." },
  { key: "captureMaxPerDay", label: "Background runs per day", hint: "Default 10, from 1 to 100. Shared by session suggestions, clean-ups, and project files; each run is one model call." },
  { key: "mcpPort", label: "Memory tools port", hint: "Default 6790. Applies after the plugin reloads; agents started before keep the old port." },
];
const ADVANCED_TEXTS: ReadonlyArray<{ key: TextKey; label: string; hint: string }> = [
  { key: "captureModel", label: "Session model", hint: "Used only when one provider reads every session. Empty uses the provider's default model." },
  { key: "captureInstructions", label: "What to suggest", hint: "Optional guidance for session suggestions, up to 2,000 characters." },
  { key: "captureExclusions", label: "What never to suggest", hint: "Optional, up to 2,000 characters." },
  { key: "tidyModel", label: "Clean-up and project files model", hint: "Empty uses the provider's default model." },
];

const PROVIDER_LABEL: Record<(typeof PROVIDERS)[number], string> = { claude: "Claude", codex: "Codex", opencode: "OpenCode" };
const CAPTURE_PROVIDER_OPTIONS = [
  { label: "Same as the session (transcripts stay with their provider)", value: "session" },
  ...PROVIDERS.map((provider) => ({ label: PROVIDER_LABEL[provider], value: provider })),
] as const;
const TIDY_PROVIDER_OPTIONS = PROVIDERS.map((provider) => ({ label: PROVIDER_LABEL[provider], value: provider }));
const PROJECT_AUTO_SCAN_OPTIONS = [
  { label: "Off", value: "off" as const },
  { label: "Once per project", value: "once" as const },
  { label: "Once, then check weekly", value: "weekly" as const },
];

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
    for (const { key, label } of ADVANCED_NUMBERS) {
      const draft = drafts[key]?.trim();
      if (draft === undefined) continue;
      // An emptied field must not quietly become 0, which has a meaning of its own.
      if (!/^\d+$/.test(draft)) {
        setInputError(`Enter a whole number for “${label}” (got “${draft}”).`);
        return;
      }
      next[key] = Number(draft);
    }
    for (const { key } of ADVANCED_TEXTS) {
      const draft = drafts[key];
      if (draft !== undefined) next[key] = draft;
    }
    // A number out of range is named with its label here, rather than refused later as raw validation output.
    const checked = memorySettings.schema.safeParse(next);
    if (!checked.success) {
      setInputError(errorText(checked.error, Object.fromEntries([...ADVANCED_NUMBERS, ...ADVANCED_TEXTS].map(({ key, label }) => [key, `“${label}”`]))));
      return;
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
    <SettingsAction label="" actionLabel="Save advanced settings" disabled={settings.saving || Object.keys(drafts).length === 0} error={inputError ?? settings.saveError} onPress={saveDrafts} />
  );
  return (
    <>
      <SettingsSection title="Memory">
        <SettingsCard>
          <SettingsSwitch
            label="Give agents memory"
            hint="New Claude, Codex, and OpenCode agents get your memories and the memory tools. Off keeps saved memories."
            value={settings.values.enabled}
            disabled={settings.saving}
            onValueChange={(enabled) => save({ ...settings.values, enabled })}
          />
          <SettingsSwitch
            label="Read memories without asking"
            hint="Agents search and open memories without asking you. Saving or changing one still asks."
            value={settings.values.autoApproveReads}
            disabled={settings.saving}
            onValueChange={(autoApproveReads) => save({ ...settings.values, autoApproveReads })}
          />
          <SettingsSwitch
            label="Show memory use in agent chats"
            hint="Adds one line to each agent's chat: how many memories it was given and how it used them. The model never sees it."
            value={settings.values.showMemoryUse}
            disabled={settings.saving}
            onValueChange={(showMemoryUse) => save({ ...settings.values, showMemoryUse })}
          />
        </SettingsCard>
      </SettingsSection>
      <SettingsSection title="Suggestions from sessions">
        <SettingsCard>
          <SettingsSwitch
            label="Suggest memories from sessions"
            hint="When a session goes quiet, a restricted background agent reads it and suggests memories for you to review. Each run is one model call."
            value={settings.values.captureEnabled}
            disabled={settings.saving}
            onValueChange={(captureEnabled) => save({ ...settings.values, captureEnabled })}
          />
          <SettingsSelect
            label="Provider that reads sessions"
            hint="Secret-shaped text is removed before the session is sent."
            value={settings.values.captureProvider}
            options={CAPTURE_PROVIDER_OPTIONS}
            disabled={settings.saving}
            onValueChange={(captureProvider) => save({ ...settings.values, captureProvider })}
          />
        </SettingsCard>
      </SettingsSection>
      <SettingsSection title="Clean up">
        <SettingsCard>
          <SettingsSwitch
            label="Clean up each project weekly"
            hint="Suggests merging duplicates, rewording unclear memories, and archiving outdated ones. Otherwise only when you press Suggest clean-ups."
            value={settings.values.tidyWeekly}
            disabled={settings.saving}
            onValueChange={(tidyWeekly) => save({ ...settings.values, tidyWeekly })}
          />
        </SettingsCard>
      </SettingsSection>
      <SettingsSection title="Project files">
        <SettingsCard>
          <SettingsSelect
            label="Suggest from project files automatically"
            hint="For every project with an open workspace. Uses at most half the background runs per day, and skips projects with memory or session suggestions off."
            value={settings.values.projectAutoScan}
            options={PROJECT_AUTO_SCAN_OPTIONS}
            disabled={settings.saving}
            onValueChange={(projectAutoScan) => save({ ...settings.values, projectAutoScan })}
          />
        </SettingsCard>
      </SettingsSection>
      <SettingsSection title="Advanced" info="Memory length, prompt size, hiding unused memories, timing and limits for background runs, models, guidance, and the tools port.">
        <SettingsCard>
          <SettingsSelect
            label="Clean-up and project files provider"
            hint="Reads saved memories or project files and suggests changes."
            value={settings.values.tidyProvider}
            options={TIDY_PROVIDER_OPTIONS}
            disabled={settings.saving}
            onValueChange={(tidyProvider) => save({ ...settings.values, tidyProvider })}
          />
        </SettingsCard>
        <SettingsCard>
          {ADVANCED_NUMBERS.map(input)}
          {ADVANCED_TEXTS.map(input)}
          {saveAction}
        </SettingsCard>
      </SettingsSection>
    </>
  );
}
