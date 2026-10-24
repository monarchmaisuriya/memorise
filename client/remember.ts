import { MAX_BODY_CHARS, MAX_SUBJECT_CHARS, type MemoryType, memoryTypeSchema, type Scope } from "../shared/memory";

export interface RememberRequest {
  scope: Scope;
  type: MemoryType;
  subject: string;
  body: string;
}

export const REMEMBER_HINT = "[--global] [preference|decision|gotcha|howto|reference:] <fact>";

// `/remember [--global] [type:] <fact>`. Without a type the fact is a reference; without --global it
// belongs to the workspace's repo.
export function parseRemember(args: string): RememberRequest {
  let rest = args.trim();
  let scope: Scope = "repo";
  if (/^--global\b/.test(rest)) {
    scope = "global";
    rest = rest.replace(/^--global\b/, "").trim();
  }
  let type: MemoryType = "reference";
  const typed = /^([a-z]+):\s*/.exec(rest);
  if (typed && memoryTypeSchema.safeParse(typed[1]).success) {
    type = memoryTypeSchema.parse(typed[1]);
    rest = rest.slice(typed[0].length);
  }
  const body = rest.trim();
  if (body === "") throw new Error(`Write the fact after /remember, like: /remember ${REMEMBER_HINT}`);
  if (body.length > MAX_BODY_CHARS) throw new Error(`A memory holds one fact of at most ${MAX_BODY_CHARS} characters; this one has ${body.length}`);
  const firstLine = body.split("\n")[0];
  const subject = firstLine.length > MAX_SUBJECT_CHARS ? `${firstLine.slice(0, MAX_SUBJECT_CHARS - 1)}…` : firstLine;
  return { scope, type, subject, body };
}
