import { type Activation, DEFAULT_BODY_CHARS, type MemoryType, type Receipt } from "../shared/memory";

// The words Memorise shows people, in one place. They name what the user gets, not how it works
// (see docs/2026-10-25-0930_memorise-ux-copy_plan.md for the glossary). Stored values, RPCs, and
// the agents' MCP tools keep their own names.

export const KIND: Record<MemoryType, string> = {
  preference: "Preference",
  decision: "Decision",
  gotcha: "Gotcha",
  howto: "How-to",
  reference: "Reference",
};

export const ACTIVATION: Record<Activation, { label: string; hint: string }> = {
  listed: { label: "Always", hint: "Listed for every new agent in this project." },
  files: { label: "When matching files change", hint: "Listed only when the workspace has changed a file this memory is about." },
  title: { label: "Title only", hint: "Agents see the title and open the memory when they need it." },
  manual: { label: "Only when searched", hint: "Never listed; agents find it by searching." },
};

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const DAY_MS = 24 * 60 * 60 * 1000;

function dayNumber(date: Date): number {
  return Math.floor(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()) / DAY_MS);
}

function dayAndMonth(date: Date, now: Date): string {
  return `${date.getDate()} ${MONTHS[date.getMonth()]}${date.getFullYear() === now.getFullYear() ? "" : ` ${date.getFullYear()}`}`;
}

// When something happened, by the local calendar: "today", "yesterday", "3 days ago" within 30
// days, then "on 12 Oct" (with the year when it is not this year).
export function relativeDate(iso: string, now = new Date()): string {
  const date = new Date(iso);
  const days = dayNumber(now) - dayNumber(date);
  if (days <= 0) return "today";
  if (days === 1) return "yesterday";
  if (days < 30) return `${days} days ago`;
  return `on ${dayAndMonth(date, now)}`;
}

// A calendar date (YYYY-MM-DD), such as an expiry: "30 Nov", or "31 Jan 2027" in another year.
export function shortDate(day: string, now = new Date()): string {
  const [year, month, date] = day.split("-").map(Number);
  return dayAndMonth(new Date(year, month - 1, date), now);
}

const PROVIDER_NAME: Record<string, string> = { claude: "Claude", codex: "Codex", opencode: "OpenCode" };

// A provider id as people write it: "Claude", "Codex", "OpenCode"; an unknown one as given.
export function providerName(provider: string | null): string {
  return provider ? (PROVIDER_NAME[provider] ?? provider) : "an agent";
}

export function count(n: number, one: string, many: string): string {
  return `${n} ${n === 1 ? one : many}`;
}

const times = (n: number) => (n === 1 ? "once" : `${n} times`);

// How agents have used a memory, as a sentence.
export function usageText({ shown, read, found }: { shown: number; read: number; found: number }): string {
  const parts = [shown > 0 ? `shown to agents ${times(shown)}` : null, read > 0 ? `opened ${times(read)}` : null, found > 0 ? `found by search ${times(found)}` : null].filter(
    (part): part is string => part !== null,
  );
  if (parts.length === 0) return "Not used yet";
  const text = parts.join(", ");
  return `${text[0].toUpperCase()}${text.slice(1)}`;
}

// A receipt row in an agent's chat: what its prompt listed, and how it used the memory tools.
export function receiptText({ listed, opened, searched, saved, archived, other }: Receipt): string {
  const used = [
    opened > 0 ? `opened ${opened}` : null,
    searched > 0 ? `searched ${searched}` : null,
    saved > 0 ? `saved ${saved}` : null,
    archived > 0 ? `archived ${archived}` : null,
    other > 0 ? `used the memory tools ${times(other)}` : null,
  ].filter((part): part is string => part !== null);
  return `${count(listed, "memory", "memories")} in this agent's prompt · ${used.length > 0 ? used.join(", ") : "not used yet"}`;
}

// A project's short name: a repo's last path segment, a folder's current name (its label) or the
// name in its key, or "Global". The full key stays available as the detail line.
export function projectName(repoKey: string | null, label?: string | null): string {
  if (repoKey === null) return "Global";
  if (label) return label;
  const [first, ...rest] = repoKey.split("/");
  if (first === "folder") return rest.join("/").replace(/-[0-9a-f]{12}(-\d+)?$/, "");
  if (first === "local") return `Repo without a remote (${rest.join("/").slice(0, 6)})`;
  return rest.at(-1) ?? repoKey;
}

export function projectDetail(repoKey: string | null): string {
  return repoKey ?? "For every project";
}

const number = (n: number) => n.toLocaleString("en-US");

// The count under a text field: characters left, or how many too many. A title's count shows only
// past three quarters of its limit; a memory's always shows, with a note on cost once it is longer
// than the default limit, since agents receive the whole text each time they open it.
export function lengthNote(length: number, limit: number, field: "title" | "body"): { text: string; tone: "muted" | "danger" } | null {
  const chars = (n: number) => `${number(n)} ${n === 1 ? "character" : "characters"}`;
  if (length > limit) return { text: `${chars(length - limit)} too many`, tone: "danger" };
  if (field === "title" && length < limit * 0.75) return null;
  const left = `${chars(limit - length)} left`;
  return { text: field === "body" && length > DEFAULT_BODY_CHARS ? `${left}. Long memories use more context each time an agent opens them.` : left, tone: "muted" };
}

// The names the app shows for fields that validation can refuse.
const FIELD_LABEL: Record<string, string> = { subject: "Title", body: "Memory", type: "Kind", paths: "About files", until: "Expires on", query: "Search" };

type Issue = { code?: unknown; path?: unknown; message?: unknown; maximum?: unknown; minimum?: unknown; origin?: unknown; format?: unknown };

// One validation issue as a sentence that names the field, in the form "Memory must be 1,000
// characters or less", never as the validator's own codes.
function issueText(issue: Issue, labels: Record<string, string>): string {
  const key = Array.isArray(issue.path) ? issue.path.filter((part) => typeof part === "string").join(".") : "";
  const label = labels[key] ?? (key || "This value");
  if (issue.code === "too_big" && issue.origin === "string" && typeof issue.maximum === "number") return `${label} must be ${number(issue.maximum)} characters or less`;
  if (issue.code === "too_big" && typeof issue.maximum === "number") return `${label} must be ${number(issue.maximum)} or less`;
  if (issue.code === "too_small" && issue.origin === "string" && issue.minimum === 1) return `Enter ${label === "Memory" ? "the memory" : `a ${label.toLowerCase()}`}`;
  if (issue.code === "too_small" && typeof issue.minimum === "number") return `${label} must be at least ${number(issue.minimum)}`;
  if (issue.code === "invalid_format" && issue.format === "date") return `${label} must be a date like 2026-12-31`;
  return `${label}: ${typeof issue.message === "string" ? issue.message : "not accepted"}`;
}

// Validation issues from a Zod error, or from a message that is the JSON list of them (as a refused
// RPC input arrives); null for any other error.
function validationIssues(error: Error, message: string): Issue[] | null {
  const own = (error as Error & { issues?: unknown }).issues;
  if (Array.isArray(own)) return own as Issue[];
  if (!message.trimStart().startsWith("[")) return null;
  try {
    const parsed: unknown = JSON.parse(message);
    return Array.isArray(parsed) && parsed.every((item) => typeof item === "object" && item !== null && "code" in item) ? (parsed as Issue[]) : null;
  } catch {
    return null;
  }
}

// An error's own message. Paseo's client appends " requestType=<type> code=<code>" to every RPC
// error, and a handler's error also gets "Request failed: " in front; only that exact wrapping,
// named by the error's own fields, is removed. Validation issues become sentences naming the field
// (`labels` adds names for other screens' fields). Any other error is shown as it is.
export function errorText(error: unknown, labels: Record<string, string> = {}): string {
  if (!(error instanceof Error)) return String(error);
  const { requestType, code } = error as Error & { requestType?: unknown; code?: unknown };
  let message = error.message;
  if (typeof code === "string" && message.endsWith(` code=${code}`)) message = message.slice(0, -` code=${code}`.length);
  if (typeof requestType === "string" && message.endsWith(` requestType=${requestType}`)) message = message.slice(0, -` requestType=${requestType}`.length);
  if (code === "handler_error" && message.startsWith("Request failed: ")) message = message.slice("Request failed: ".length);
  const issues = validationIssues(error, message);
  if (issues) return issues.map((issue) => `${issueText(issue, { ...FIELD_LABEL, ...labels })}.`).join(" ");
  return message;
}
