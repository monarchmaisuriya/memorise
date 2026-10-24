import { defineRpc, defineSettings } from "@getpaseo/plugin";
import { z } from "zod";

export const MAX_SUBJECT_CHARS = 80;
export const MAX_BODY_CHARS = 1_000;
export const MAX_CITATIONS = 10;

// Saved text is later placed inside the <memorise> section of other agents' system prompts. It
// must not be able to start a new index line or close that section.
const MEMORY_TAG = /<\s*\/?\s*memorise/i;
const noMemoryTag = (text: string) => !MEMORY_TAG.test(text);
const TAG_MESSAGE = "A memory cannot contain a <memorise> tag";

export const subjectSchema = z
  .string()
  .trim()
  .min(1)
  .max(MAX_SUBJECT_CHARS)
  .regex(/^[^\u0000-\u001f\u007f]+$/, "A memory subject is one line of text, without line breaks or control characters")
  .refine(noMemoryTag, TAG_MESSAGE);

export const bodySchema = z.string().trim().min(1).max(MAX_BODY_CHARS).refine(noMemoryTag, TAG_MESSAGE);

export const memoryTypeSchema = z.enum(["preference", "decision", "gotcha", "howto", "reference"]);
export type MemoryType = z.infer<typeof memoryTypeSchema>;

export const scopeSchema = z.enum(["global", "repo"]);
export type Scope = z.infer<typeof scopeSchema>;

// Crockford base32 ULID: sortable by creation time and safe to use as a file name.
export const factIdSchema = z.string().regex(/^[0-9A-HJKMNP-TV-Z]{26}$/, "Expected a 26-character fact id such as 01JB8Z6X3T5Q9V2M4N7P8R1S0W");

// host/owner/repo from the origin remote, or local/<hash> for a repo with no origin.
export const repoKeySchema = z
  .string()
  .max(200)
  .regex(/^[a-z0-9][a-z0-9._-]*(\/[a-z0-9._~-]+)+$/, "Expected a repo key such as github.com/owner/repo")
  .refine((key) => !key.split("/").includes(".."), "A repo key cannot contain '..'");

export const citationSchema = z.object({
  path: z
    .string()
    .min(1)
    .max(300)
    .refine((path) => !path.startsWith("/") && !path.split("/").includes(".."), "Cite a path relative to the repo root, without '..'"),
  lines: z.string().regex(/^\d+(-\d+)?$/, "Expected lines like 12 or 12-18").optional(),
  commit: z.string().regex(/^[0-9a-f]{7,40}$/, "Expected a git commit sha"),
});
export type Citation = z.infer<typeof citationSchema>;

export const MAX_PATH_GLOBS = 10;
// A file glob relative to the repo root, such as src/api/**/*.ts. One level of {a,b} at most, so a
// glob cannot expand into thousands of patterns.
export const pathGlobSchema = z
  .string()
  .min(1)
  .max(200)
  .regex(/^[A-Za-z0-9_.\-/*?{},[\]]+$/, "A path glob uses letters, digits, / . _ - * ? [ ] { } and ,")
  .refine((glob) => !glob.startsWith("/") && !glob.split("/").includes(".."), "A path glob is relative to the repo root, without '..'")
  .refine((glob) => !/\{[^}]*\{/.test(glob) && (glob.match(/\{/g) ?? []).length <= 1, "A path glob may use one {a,b} group at most");

// Who a fact came from. "captured" means proposed from a session transcript and approved by the user.
export const sourceKindSchema = z.enum(["agent", "user", "captured"]);

// When a fact reaches a new agent's index. listed: ranked as usual. files: only when the worktree
// changed a file matching its paths. title: the subject only; the agent reads the body with
// memory_read. manual: never listed; found only by memory_search or memory_read. A pinned fact is
// always listed in full.
export const activationSchema = z.enum(["listed", "files", "title", "manual"]);
export type Activation = z.infer<typeof activationSchema>;

// A date (YYYY-MM-DD, UTC) after which agents no longer see a fact; null means no end date.
export const untilSchema = z.iso.date().nullable();

export const factSchema = z.object({
  id: factIdSchema,
  scope: scopeSchema,
  repoKey: repoKeySchema.nullable(),
  type: memoryTypeSchema,
  subject: subjectSchema,
  body: bodySchema,
  status: z.enum(["active", "retired"]),
  // Pinned facts are always listed first in the prompt index; only the user pins.
  pinned: z.boolean().default(false),
  // Files the fact is about. Facts whose paths match files a worktree changed rank first.
  paths: z.array(pathGlobSchema).max(MAX_PATH_GLOBS).default([]),
  // Controls only the user sets, from the app; agent tools never change them.
  activation: activationSchema.default("listed"),
  enabled: z.boolean().default(true),
  until: untilSchema.default(null),
  supersedes: factIdSchema.nullable(),
  created: z.iso.datetime(),
  modified: z.iso.datetime(),
  lastUsed: z.iso.datetime(),
  source: z.object({
    by: sourceKindSchema,
    provider: z.string().nullable(),
    branch: z.string().nullable(),
    commit: z.string().nullable(),
  }),
  citations: z.array(citationSchema).max(MAX_CITATIONS),
});
export type Fact = z.infer<typeof factSchema>;

export const factListItemSchema = factSchema.extend({ superseded: z.boolean() });
export type FactListItem = z.infer<typeof factListItemSchema>;

const directoryInput = z.object({ directory: z.string().min(1) });

// Where a memory call acts: a workspace folder, whose repo comes from its git origin (the panel),
// or a repo key directly (the manager). A null repo key means global memory only.
export const whereSchema = z.union([z.object({ directory: z.string().min(1) }), z.object({ repoKey: repoKeySchema.nullable() })]);
export type Where = z.infer<typeof whereSchema>;
const whereInput = z.object({ where: whereSchema });

export const listMemoriesRpc = defineRpc({
  name: "memory.list",
  input: whereInput,
  output: z.object({
    repoKey: repoKeySchema.nullable(),
    facts: z.array(
      factListItemSchema.extend({
        visibleToAgents: z.boolean(),
        usage: z.object({ shown: z.number(), read: z.number(), found: z.number(), lastShown: z.string().nullable() }),
      }),
    ),
  }),
});

export const pinMemoryRpc = defineRpc({
  name: "memory.pin",
  input: whereInput.extend({ id: factIdSchema, pinned: z.boolean() }),
  output: z.object({ fact: factSchema }),
});

const pathsInput = z.array(pathGlobSchema).max(MAX_PATH_GLOBS);

export const saveMemoryRpc = defineRpc({
  name: "memory.save",
  input: whereInput.extend({
    scope: scopeSchema,
    type: memoryTypeSchema,
    subject: subjectSchema,
    body: bodySchema,
    paths: pathsInput.default([]),
    pinned: z.boolean().default(false),
    activation: activationSchema.default("listed"),
    enabled: z.boolean().default(true),
    until: untilSchema.default(null),
  }),
  output: z.object({ fact: factSchema }),
});

// Content fields make a new version; controls (activation, enabled, until) change in place.
export const updateMemoryRpc = defineRpc({
  name: "memory.update",
  input: whereInput
    .extend({
      id: factIdSchema,
      subject: subjectSchema.optional(),
      body: bodySchema.optional(),
      type: memoryTypeSchema.optional(),
      paths: pathsInput.optional(),
      activation: activationSchema.optional(),
      enabled: z.boolean().optional(),
      until: untilSchema.optional(),
    })
    .refine(
      (input) => [input.subject, input.body, input.type, input.paths, input.activation, input.enabled, input.until].some((value) => value !== undefined),
      "Give at least one of subject, body, type, paths, activation, enabled, or until to change",
    ),
  output: z.object({ fact: factSchema }),
});

export const retireMemoryRpc = defineRpc({
  name: "memory.retire",
  input: whereInput.extend({ id: factIdSchema }),
  output: z.object({ fact: factSchema }),
});

export const restoreMemoryRpc = defineRpc({
  name: "memory.restore",
  input: whereInput.extend({ id: factIdSchema }),
  output: z.object({ fact: factSchema }),
});

export const deleteMemoryRpc = defineRpc({
  name: "memory.delete",
  input: whereInput.extend({ id: factIdSchema }),
  output: z.object({ deleted: z.literal(true) }),
});

// Global plus every repo with memory files, for the manager's repo list.
export const listReposRpc = defineRpc({
  name: "memory.repos",
  input: z.object({}),
  output: z.object({
    repos: z.array(z.object({ repoKey: repoKeySchema.nullable(), active: z.number(), retired: z.number(), lastModified: z.string().nullable() })),
  }),
});

// Full-text search over every current version, retired ones included; the manager filters further.
export const searchMemoriesRpc = defineRpc({
  name: "memory.search",
  input: whereInput.extend({ query: z.string().trim().min(1).max(200) }),
  output: z.object({ ids: z.array(factIdSchema) }),
});

export const memoryHistoryRpc = defineRpc({
  name: "memory.history",
  input: whereInput.extend({ id: factIdSchema }),
  output: z.object({ versions: z.array(factListItemSchema) }),
});

export const revertMemoryRpc = defineRpc({
  name: "memory.revert",
  input: whereInput.extend({ id: factIdSchema, versionId: factIdSchema }),
  output: z.object({ fact: factSchema }),
});

export const moveMemoryRpc = defineRpc({
  name: "memory.move",
  input: whereInput.extend({ id: factIdSchema, to: scopeSchema }),
  output: z.object({ fact: factSchema }),
});

export const MAX_BULK_IDS = 200;
export const bulkActionSchema = z.enum(["retire", "restore", "pin", "unpin", "enable", "disable", "delete"]);
export type BulkAction = z.infer<typeof bulkActionSchema>;

export const bulkMemoryRpc = defineRpc({
  name: "memory.bulk",
  input: whereInput.extend({ ids: z.array(factIdSchema).min(1).max(MAX_BULK_IDS), action: bulkActionSchema }),
  output: z.object({ results: z.array(z.object({ id: factIdSchema, ok: z.boolean(), error: z.string().optional() })) }),
});

// The current, active memories of one repo (or global, for a null repo key).
export const exportMemoryRpc = defineRpc({
  name: "memory.export",
  input: whereInput.extend({ format: z.enum(["markdown", "json"]) }),
  output: z.object({ text: z.string(), count: z.number() }),
});

// Markdown lines or a JSON export. A dry run reports what would be added and writes nothing.
export const importMemoryRpc = defineRpc({
  name: "memory.import",
  input: whereInput.extend({ scope: scopeSchema, text: z.string().min(1).max(200_000), dryRun: z.boolean() }),
  output: z.object({
    added: z.array(z.object({ type: memoryTypeSchema, subject: z.string() })),
    skipped: z.array(z.object({ line: z.string(), reason: z.string() })),
  }),
});

// Per-repo preferences, shared by every worktree of the repo. enabled false: new agents in the repo
// get no memory and no memory tools. includeGlobal false: the repo's agents see no global memories.
// capture: "default" follows the host setting; "on" or "off" overrides it for this repo.
export const repoPrefsSchema = z.object({
  enabled: z.boolean().default(true),
  includeGlobal: z.boolean().default(true),
  capture: z.enum(["default", "on", "off"]).default("default"),
});
export type RepoPrefsValue = z.infer<typeof repoPrefsSchema>;

export const getRepoPrefsRpc = defineRpc({
  name: "memory.repo-prefs.get",
  input: z.object({ repoKey: repoKeySchema }),
  output: z.object({ prefs: repoPrefsSchema }),
});

export const setRepoPrefsRpc = defineRpc({
  name: "memory.repo-prefs.set",
  input: z.object({ repoKey: repoKeySchema, prefs: repoPrefsSchema }),
  output: z.object({ prefs: repoPrefsSchema }),
});

// What a new agent in this workspace would get now, built by the same code as the create hook.
export const listReasonSchema = z.enum(["pinned", "files", "global", "repo"]);
export const previewMemoryRpc = defineRpc({
  name: "memory.preview",
  input: directoryInput,
  output: z.object({
    repoKey: repoKeySchema.nullable(),
    off: z.boolean(),
    text: z.string(),
    bytes: z.number(),
    listed: z.array(z.object({ id: factIdSchema, subject: z.string(), reason: listReasonSchema, titleOnly: z.boolean() })),
  }),
});

// A proposal is a change to memory that waits for the user: a new fact from a captured session, or a
// merge, replacement, or retirement suggested by a tidy pass. Agents never see proposals.
export const proposalKindSchema = z.enum(["new", "replace", "merge", "retire"]);
export const PROVIDERS = ["claude", "codex", "opencode"] as const;
export const providerSchema = z.enum(PROVIDERS);

export const proposalSchema = z.object({
  id: factIdSchema,
  repoKey: repoKeySchema,
  kind: proposalKindSchema,
  // Facts the proposal changes: one for replace and retire, two or more for merge, none for new.
  targets: z.array(factIdSchema).max(20),
  type: memoryTypeSchema,
  subject: subjectSchema,
  body: bodySchema,
  paths: z.array(pathGlobSchema).max(MAX_PATH_GLOBS).default([]),
  reason: z.string().trim().max(300).default(""),
  source: z.object({ from: z.enum(["capture", "tidy"]), agentId: z.string().nullable(), provider: z.string(), model: z.string().nullable() }),
  created: z.iso.datetime(),
  hash: z.string().regex(/^[0-9a-f]{64}$/),
});
export type Proposal = z.infer<typeof proposalSchema>;

export const listProposalsRpc = defineRpc({
  name: "memory.proposals.list",
  input: directoryInput,
  output: z.object({
    repoKey: repoKeySchema.nullable(),
    proposals: z.array(proposalSchema.extend({ targetFacts: z.array(z.object({ id: factIdSchema, subject: z.string(), body: z.string() })) })),
    captureRunsToday: z.number(),
  }),
});

export const approveProposalRpc = defineRpc({
  name: "memory.proposals.approve",
  // The user may edit the wording before approving.
  input: directoryInput.extend({ id: factIdSchema, subject: subjectSchema.optional(), body: bodySchema.optional(), paths: z.array(pathGlobSchema).max(MAX_PATH_GLOBS).optional() }),
  output: z.object({ approved: z.literal(true) }),
});

export const rejectProposalRpc = defineRpc({
  name: "memory.proposals.reject",
  input: directoryInput.extend({ id: factIdSchema }),
  output: z.object({ rejected: z.literal(true) }),
});

// The chat card a capture pass adds to the source agent's timeline (UI only; never sent to the model).
export const PROPOSALS_CARD_KIND = "memorise-proposals";
export const proposalsCardSchema = z.object({ count: z.number().int().min(1) });

export const tidyMemoryRpc = defineRpc({
  name: "memory.tidy",
  input: directoryInput,
  output: z.object({ started: z.literal(true) }),
});

export const memorySettings = defineSettings({
  id: "memory",
  scope: "host",
  version: 1,
  schema: z.object({
    enabled: z.boolean().default(true),
    autoApproveReads: z.boolean().default(true),
    indexMaxLines: z.number().int().min(0).max(400).default(150),
    expiryDays: z.number().int().min(0).max(3650).default(60),
    mcpPort: z.number().int().min(1024).max(65535).default(6790),
    // Capture: propose memories from finished sessions. Off until the user turns it on.
    captureEnabled: z.boolean().default(false),
    // "session" reads each session with the provider that ran it, so no transcript crosses providers.
    captureProvider: z.enum(["session", ...PROVIDERS]).default("session"),
    captureModel: z.string().trim().max(100).default(""),
    captureIdleMinutes: z.number().int().min(5).max(240).default(20),
    captureMinUserMessages: z.number().int().min(1).max(50).default(3),
    captureMaxPerDay: z.number().int().min(1).max(100).default(10),
    captureInstructions: z.string().max(2_000).default(""),
    captureExclusions: z.string().max(2_000).default(""),
    // Tidy: propose merges, replacements, and retirements. Facts it reads already go to every
    // provider in prompts, so it adds no new data flow.
    tidyProvider: providerSchema.default("claude"),
    tidyModel: z.string().trim().max(100).default(""),
    tidyWeekly: z.boolean().default(false),
  }),
});
export type MemorySettings = z.infer<typeof memorySettings.schema>;
