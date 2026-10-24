import { z } from "zod";
import {
  activationSchema,
  type Activation,
  bodySchema,
  type FactListItem,
  MAX_PATH_GLOBS,
  MAX_SUBJECT_CHARS,
  type MemoryType,
  memoryTypeSchema,
  pathGlobSchema,
  subjectSchema,
  untilSchema,
} from "../shared/memory";
import { assertNoSecret } from "./secrets";

export const MAX_IMPORT_ENTRIES = 500;

export type ExportFormat = "markdown" | "json";

export interface ImportEntry {
  type: MemoryType;
  subject: string;
  body: string;
  paths: string[];
  pinned?: boolean;
  activation?: Activation;
  enabled?: boolean;
  until?: string | null;
}

export interface ImportResult {
  entries: ImportEntry[];
  skipped: { line: string; reason: string }[];
}

// Markdown is for reading: one line per memory, line breaks folded. JSON keeps paths and controls.
export function formatExport(facts: readonly FactListItem[], format: ExportFormat, repoKey: string | null): string {
  if (format === "json") {
    const exported = facts.map(({ type, subject, body, paths, pinned, activation, enabled, until }) => ({ type, subject, body, paths, pinned, activation, enabled, until }));
    return JSON.stringify({ memorise: 1, repoKey, facts: exported }, null, 2);
  }
  const lines = facts.map((fact) => `- [${fact.type}] ${fact.subject}: ${fact.body.replace(/\s*\n\s*/g, " ")}`);
  return [`# Memorise export: ${repoKey ?? "global"}`, "", ...lines, ""].join("\n");
}

// Same subject and text, ignoring case and spacing: the same memory.
export function importKey(subject: string, body: string): string {
  const normal = (text: string) => text.toLowerCase().replace(/\s+/g, " ").trim();
  return `${normal(subject)}\n${normal(body)}`;
}

// A subject for text that has none: the text itself, cut at a word boundary under the limit.
function subjectFrom(text: string): string {
  if (text.length <= MAX_SUBJECT_CHARS) return text;
  const cut = text.slice(0, MAX_SUBJECT_CHARS + 1).lastIndexOf(" ");
  return text.slice(0, cut > 0 ? cut : MAX_SUBJECT_CHARS).trim();
}

const jsonEntrySchema = z.object({
  type: memoryTypeSchema.default("reference"),
  subject: z.string().optional(),
  body: z.string(),
  paths: z.array(pathGlobSchema).max(MAX_PATH_GLOBS).default([]),
  pinned: z.boolean().optional(),
  activation: activationSchema.optional(),
  enabled: z.boolean().optional(),
  until: untilSchema.optional(),
});

// "- [type] subject: body" (a Memorise export), "[2026-03-02] - text" (assistant memory exports),
// or plain text, each optionally starting with "- " or "* ".
const LINE = /^(?:[-*]\s+)?(?:\[\d{4}-\d{2}-\d{2}\]\s*-\s*)?(?:\[(preference|decision|gotcha|howto|reference)\]\s+)?(.+)$/;

function fromLine(line: string): ImportEntry {
  const [, type, text] = LINE.exec(line) ?? [];
  const split = text.indexOf(": ");
  const hasSubject = split > 0 && split <= MAX_SUBJECT_CHARS;
  return { type: (type as MemoryType | undefined) ?? "reference", subject: hasSubject ? text.slice(0, split) : subjectFrom(text), body: hasSubject ? text.slice(split + 2) : text, paths: [] };
}

// Every entry passes the same checks as a memory saved in the app; one that does not is skipped
// with its reason, never dropped silently.
function check(entry: ImportEntry): string | null {
  for (const [schema, value] of [[subjectSchema, entry.subject], [bodySchema, entry.body]] as const) {
    const parsed = schema.safeParse(value);
    if (!parsed.success) return parsed.error.issues[0].message;
  }
  if (entry.activation === "files" && entry.paths.length === 0) return "set to show only for matching files but has no paths";
  try {
    assertNoSecret(entry.subject, entry.body);
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
  return null;
}

function candidates(text: string): { line: string; entry: ImportEntry | null; reason?: string }[] {
  const trimmed = text.trim();
  if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
    let data: unknown;
    try {
      data = JSON.parse(trimmed);
    } catch (error) {
      throw new Error(`The text looks like JSON but does not parse (${String(error)}); paste a Memorise JSON export or one memory per line`);
    }
    const items: unknown[] = Array.isArray(data) ? data : z.object({ facts: z.array(z.unknown()) }).parse(data).facts;
    return items.map((item) => {
      const line = JSON.stringify(item);
      const parsed = jsonEntrySchema.safeParse(item);
      if (!parsed.success) return { line, entry: null, reason: `${parsed.error.issues[0].path.join(".") || "entry"}: ${parsed.error.issues[0].message}` };
      const { subject, body, ...rest } = parsed.data;
      const controls = Object.fromEntries(Object.entries(rest).filter(([, value]) => value !== undefined));
      return { line, entry: { ...controls, subject: subject?.trim() || subjectFrom(body.trim()), body: body.trim() } as ImportEntry };
    });
  }
  return trimmed
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line !== "" && !line.startsWith("#") && !line.startsWith("```"))
    .map((line) => ({ line, entry: fromLine(line) }));
}

export function parseImport(text: string): ImportResult {
  const result: ImportResult = { entries: [], skipped: [] };
  for (const { line, entry, reason } of candidates(text)) {
    const problem = entry ? check(entry) : (reason ?? "not a memory");
    if (problem || !entry) result.skipped.push({ line, reason: problem ?? "not a memory" });
    else if (result.entries.length >= MAX_IMPORT_ENTRIES) result.skipped.push({ line, reason: `more than ${MAX_IMPORT_ENTRIES} memories in one import` });
    else result.entries.push(entry);
  }
  return result;
}
