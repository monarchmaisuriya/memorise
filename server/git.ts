import { execFile } from "node:child_process";
import { promisify } from "node:util";

const runFile = promisify(execFile);

export class GitError extends Error {
  constructor(
    message: string,
    readonly exitCode: number | null,
    readonly stderr: string,
  ) {
    super(message);
  }
}

// A git blocked on a hung mount can ignore the kill from execFile's own timeout, and Paseo fails
// agent creation when a hook takes 30 s, so every call also races a deadline of its own.
export async function git(cwd: string, args: readonly string[], timeoutMs: number): Promise<string> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new GitError(`git ${args[0]} gave no answer in ${timeoutMs} ms`, null, "")), timeoutMs);
  });
  try {
    const { stdout } = await Promise.race([
      runFile("git", ["-C", cwd, ...args], { timeout: timeoutMs, env: { ...process.env, LC_ALL: "C" }, maxBuffer: 4 * 1024 * 1024 }),
      deadline,
    ]);
    return stdout.trim();
  } catch (error) {
    if (error instanceof GitError) throw error;
    const exitCode: unknown = Reflect.get(Object(error), "code");
    const stderr: unknown = Reflect.get(Object(error), "stderr");
    throw new GitError(
      `git ${args.join(" ")} failed: ${typeof stderr === "string" && stderr.trim() !== "" ? stderr.trim() : String(error)}`,
      typeof exitCode === "number" ? exitCode : null,
      typeof stderr === "string" ? stderr : "",
    );
  } finally {
    clearTimeout(timer);
  }
}
