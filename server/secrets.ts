// Memory text is sent to every provider in later prompts, so anything secret-shaped is refused at
// write time with the pattern's name. A saved memory is never silently redacted; only transcripts
// sent to the capture worker are (redactSecrets), because there is no one to bounce them back to.
const SECRET_PATTERNS: ReadonlyArray<readonly [string, RegExp]> = [
  ["private key", /-----BEGIN [A-Z ]*PRIVATE KEY-----/],
  ["AWS access key", /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/],
  ["GitHub token", /\b(?:gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{30,})\b/],
  ["API key (sk-)", /\bsk-[A-Za-z0-9_-]{20,}/],
  ["Slack token", /\bxox[abprs]-[A-Za-z0-9-]{10,}/],
  ["Google API key", /\bAIza[0-9A-Za-z_-]{35}\b/],
  ["JSON web token", /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/],
  ["password or key assignment", /\b(?:password|passwd|secret|api[_-]?key|access[_-]?token|auth[_-]?token)\b\s*[:=]\s*['"]?[^\s'"]{6,}/i],
  ["text marked private", /<private>/i],
];

export function findSecret(text: string): string | null {
  for (const [name, pattern] of SECRET_PATTERNS) if (pattern.test(text)) return name;
  return null;
}

export function assertNoSecret(...texts: string[]): void {
  const found = findSecret(texts.join("\n"));
  if (found) throw new Error(`Refused: the memory looks like it contains a ${found}. Memories are sent to model providers in later prompts; remove the secret and save again.`);
}

// Replaces every secret-shaped span with [removed: <pattern name>].
export function redactSecrets(text: string): string {
  let redacted = text;
  for (const [name, pattern] of SECRET_PATTERNS) {
    const everywhere = new RegExp(pattern.source, pattern.flags.includes("g") ? pattern.flags : `${pattern.flags}g`);
    redacted = redacted.replace(everywhere, `[removed: ${name}]`);
  }
  return redacted;
}
