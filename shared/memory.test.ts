import { describe, expect, it } from "vitest";
import { z } from "zod";
import { allowedTypes, BUILTIN_TYPES, MAX_CUSTOM_TYPES, memorySettings, memoryTypeSchema, PROVIDERS, subjectSchema, typeProblem, proposalsCardSchema, WORKER_PROVIDERS } from "./memory";

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
  it("keeps old cards compatible and validates saved snapshots rather than stripping them", () => {
    expect(proposalsCardSchema.parse({ count: 0, autoSaved: 5 }).saved).toBeUndefined();
    expect(proposalsCardSchema.parse({ count: 0, saved: [] }).saved).toEqual([]);
    expect(proposalsCardSchema.safeParse({ count: 0, saved: [{ id: "bad", type: "gotcha", subject: "Title", body: "Body", paths: [] }] }).success).toBe(false);
    expect(proposalsCardSchema.safeParse({ count: 0, saved: null }).success).toBe(false);
  });

  it("adds no rows to agent chats by default", () => {
    expect(memorySettings.schema.parse({}).showInAgentChats).toBe(false);
  });

  it("starts suggestion cards folded by default, with no settings version raise, and a card without the field starts folded", () => {
    expect(memorySettings.schema.parse({}).openSuggestionCards).toBe(false);
    expect(memorySettings.version).toBe(2);
    expect(proposalsCardSchema.parse({ count: 2, ids: ["a", "b"] }).open).toBe(false);
    expect(proposalsCardSchema.parse({ count: 2, ids: ["a", "b"], open: true }).open).toBe(true);
  });

  it("starts background runs without Paseo notifications by default, with no settings version raise", () => {
    expect(memorySettings.schema.parse({}).notifyBackgroundRuns).toBe(false);
    expect(memorySettings.version).toBe(2);
  });

  it("turns chat rows off for settings saved before, and keeps every other value", async () => {
    expect(memorySettings.version).toBe(2);
    // Paseo runs the migration, then the schema, and saves the result.
    const migrated = memorySettings.schema.parse(await migrate(savedByVersion1, 1));
    const { showMemoryUse: _dropped, ...kept } = savedByVersion1;
    expect(migrated).toEqual({ ...kept, showInAgentChats: false, openSuggestionCards: false, notifyBackgroundRuns: false, customTypes: [] });
  });

  it("refuses settings from a version it does not know", () => {
    expect(() => migrate({}, 7)).toThrow("Expected Memorise settings version 1 to migrate, got version 7");
  });

  it("includes Antigravity for agent memory while keeping background workers on locked-down providers", () => {
    expect(PROVIDERS).toContain("antigravity");
    expect(WORKER_PROVIDERS).not.toContain("antigravity");
    expect(memorySettings.schema.safeParse({ captureProvider: "antigravity" }).success).toBe(false);
    expect(memorySettings.schema.safeParse({ tidyProvider: "antigravity" }).success).toBe(false);
  });

  it("keeps subjectSchema's JSON Schema pattern RE2-compatible (no \\u escapes)", () => {
    const jsonSchema = z.toJSONSchema(subjectSchema) as { pattern?: string };
    expect(jsonSchema.pattern).toBeDefined();
    expect(jsonSchema.pattern).not.toContain("\\u");
    expect(subjectSchema.safeParse("valid subject").success).toBe(true);
    expect(subjectSchema.safeParse("line1\nline2").success).toBe(false);
    expect(subjectSchema.safeParse("null\x00byte").success).toBe(false);
    expect(subjectSchema.safeParse("del\x7fchar").success).toBe(false);
  });
});

describe("memory types", () => {
  it("stores a type as a lowercase label, whether or not it is in the list", () => {
    expect(memoryTypeSchema.parse("eval-trap")).toBe("eval-trap");
    expect(memoryTypeSchema.parse("gotcha")).toBe("gotcha");
  });

  it.each(["Eval", "a<b", "a b", "a\nb", "", "9lives", "-x", "a".repeat(25)])("refuses the label %j", (label) => {
    expect(memoryTypeSchema.safeParse(label).success).toBe(false);
  });

  it("has no custom types by default, with no settings version raise", () => {
    expect(memorySettings.schema.parse({}).customTypes).toEqual([]);
    expect(memorySettings.version).toBe(2);
  });

  it("keeps custom types in the order given", () => {
    expect(memorySettings.schema.parse({ customTypes: ["eval-trap", "runbook"] }).customTypes).toEqual(["eval-trap", "runbook"]);
  });

  it("refuses a custom type that is built in, repeated, or badly formed, and more than 20 of them", () => {
    const problem = (customTypes: string[]) => memorySettings.schema.safeParse({ customTypes }).error?.issues[0].message;
    expect(problem(["gotcha"])).toBe('"gotcha" is a built-in type; list only your own');
    expect(problem(["a", "a"])).toBe('"a" is listed twice');
    expect(problem(["Eval"])).toMatch(/lowercase label/);
    expect(memorySettings.schema.safeParse({ customTypes: Array.from({ length: MAX_CUSTOM_TYPES + 1 }, (_, i) => `t${i}`) }).success).toBe(false);
    expect(memorySettings.schema.safeParse({ customTypes: Array.from({ length: MAX_CUSTOM_TYPES }, (_, i) => `t${i}`) }).success).toBe(true);
  });

  it("allows the built-in types, then the custom ones", () => {
    expect(allowedTypes([])).toEqual(["preference", "decision", "gotcha", "howto", "reference"]);
    expect(allowedTypes(["eval-trap"])).toEqual([...BUILTIN_TYPES, "eval-trap"]);
  });

  it("names the allowed types when it refuses one", () => {
    const allowed = allowedTypes(["eval-trap"]);
    expect(typeProblem("eval-trap", allowed)).toBeNull();
    expect(typeProblem("runbook", allowed)).toBe('Type "runbook" is not one of: preference, decision, gotcha, howto, reference, eval-trap. Add it under Settings > Plugins > Memorise > Advanced > Custom kinds.');
  });
});
