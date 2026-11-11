import { describe, expect, it } from "vitest";
import { memorySettings } from "./memory";

// The migration Paseo calls, so a test fails if it is ever left out of the definition.
const migrate = (values: unknown, fromVersion: number) => {
  if (!memorySettings.migrate) throw new Error("Expected memorySettings to define migrate");
  return memorySettings.migrate(values, fromVersion);
};

// Settings as 0.10.5 saved them (a real stored file, with every key).
const savedByVersion1 = {
  enabled: true,
  autoApproveReads: true,
  indexMaxLines: 150,
  memoryMaxChars: 5000,
  expiryDays: 60,
  mcpPort: 6790,
  captureEnabled: true,
  captureProvider: "session",
  captureModel: "",
  captureIdleMinutes: 20,
  captureMinUserMessages: 5,
  captureMaxPerDay: 100,
  captureInstructions: "",
  captureExclusions: "",
  tidyProvider: "claude",
  tidyModel: "",
  tidyWeekly: true,
  showMemoryUse: true,
  projectAutoScan: "once",
};

describe("memory settings", () => {
  it("adds no rows to agent chats by default", () => {
    expect(memorySettings.schema.parse({}).showInAgentChats).toBe(false);
  });

  it("turns chat rows off for settings saved before, and keeps every other value", async () => {
    expect(memorySettings.version).toBe(2);
    // Paseo runs the migration, then the schema, and saves the result.
    const migrated = memorySettings.schema.parse(await migrate(savedByVersion1, 1));
    const { showMemoryUse: _dropped, ...kept } = savedByVersion1;
    expect(migrated).toEqual({ ...kept, showInAgentChats: false });
  });

  it("refuses settings from a version it does not know", () => {
    expect(() => migrate({}, 7)).toThrow("Expected Memorise settings version 1 to migrate, got version 7");
  });
});
