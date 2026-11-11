import { describe, expect, it } from "vitest";
import { memorySettings } from "./memory";

// The migration Paseo calls, so a test fails if it is ever left out of the definition.
const migrate = (values: unknown, fromVersion: number) => {
  if (!memorySettings.migrate) throw new Error("Expected memorySettings to define migrate");
  return memorySettings.migrate(values, fromVersion);
};

// Settings as 0.10.5 saved them (version 1).
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

// The same settings after 0.11.0 migrated them (version 2): one switch for all chat rows.
const { showMemoryUse: _replaced, ...savedByVersion2Base } = savedByVersion1;
const savedByVersion2 = { ...savedByVersion2Base, showInAgentChats: false };

describe("memory settings", () => {
  it("reads settings saved by 0.11.0 without resetting any value", () => {
    // Paseo parses a file of the plugin's own version with the schema alone.
    expect(memorySettings.version).toBe(2);
    expect(memorySettings.schema.parse(savedByVersion2)).toEqual({ ...savedByVersion2, showMemoryUse: false });
  });

  it("shows memory use as the 0.11.0 switch says, on as well as off", () => {
    expect(memorySettings.schema.parse({ ...savedByVersion2, showInAgentChats: true }).showMemoryUse).toBe(true);
  });

  it("keeps its own memory-use setting once it has saved one", () => {
    expect(memorySettings.schema.parse({ ...savedByVersion2, showMemoryUse: true }).showMemoryUse).toBe(true);
  });

  it("moves settings saved by 0.10.5 to version 2 unchanged", async () => {
    expect(memorySettings.schema.parse(await migrate(savedByVersion1, 1))).toEqual({ ...savedByVersion1, showInAgentChats: false });
  });

  it("refuses settings from a version it does not know", () => {
    expect(() => migrate({}, 7)).toThrow("Expected Memorise settings version 1 to migrate, got version 7");
  });
});
