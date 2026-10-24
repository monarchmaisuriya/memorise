import { execFileSync } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { type FactListItem, factSchema, pathGlobSchema } from "../shared/memory";
import { buildMemorySection, PINNED_MAX_LINES } from "./index-prompt";
import { SearchIndex } from "./search-index";
import { newFactId } from "./store";
import { tempDir } from "./test-temp-dir";
import { UsageLog } from "./usage";
import { isVisibleToAgents, rankForAgent } from "./visibility";
import { factMatchesFiles, PathMatcher, workFiles } from "./work-files";

function fact(overrides: Partial<FactListItem> = {}): FactListItem {
  const now = new Date().toISOString();
  return {
    id: newFactId(),
    scope: "repo",
    repoKey: "github.com/acme/api",
    type: "gotcha",
    subject: "s",
    body: "b",
    status: "active",
    pinned: false,
    paths: [],
    supersedes: null,
    created: now,
    modified: now,
    lastUsed: now,
    source: { by: "agent", provider: "codex", branch: null, commit: null },
    citations: [],
    superseded: false,
    ...overrides,
  };
}

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", ["-C", cwd, "-c", "user.email=t@t", "-c", "user.name=t", ...args]).toString().trim();
}

describe("ranking for a new agent", () => {
  it("lists pinned facts, then facts about changed files, then global, then the rest", () => {
    const older = new Date(Date.now() - 60_000).toISOString();
    const unrelated = fact({ subject: "unrelated", lastUsed: new Date().toISOString() });
    const aboutChanged = fact({ subject: "about api", paths: ["src/api/**"], lastUsed: older });
    const cited = fact({ subject: "cites db", citations: [{ path: "src/db.ts", commit: "abc1234" }], lastUsed: older });
    const global = fact({ subject: "global pref", scope: "global", repoKey: null, lastUsed: older });
    const pinned = fact({ subject: "pinned", pinned: true, lastUsed: older });
    const order = rankForAgent([unrelated, aboutChanged, cited, global, pinned], new PathMatcher(["src/api/routes.ts", "src/db.ts"])).map((item) => item.subject);
    expect(order).toEqual(["pinned", "about api", "cites db", "global pref", "unrelated"]);
  });

  it("caps pinned facts so they cannot crowd out the rest", () => {
    const pinned = Array.from({ length: PINNED_MAX_LINES + 5 }, (_, i) => fact({ subject: `pin ${i}`, pinned: true }));
    const section = buildMemorySection({ repoKey: "github.com/acme/api", facts: [...pinned, fact({ subject: "other" })], notes: new Map(), maxLines: 150, toolsAvailable: true, problems: [] });
    expect(section.text.split("\n").filter((line) => line.includes("(pinned)"))).toHaveLength(PINNED_MAX_LINES);
    expect(section.text).toContain("other");
    expect(section.shownIds).toHaveLength(PINNED_MAX_LINES + 1);
  });

  it("ranks 300 facts with 10 globs each against 2,000 changed files well within the hook budget", () => {
    const facts = Array.from({ length: 300 }, (_, i) => fact({ subject: `f${i}`, paths: Array.from({ length: 10 }, (_, g) => `area${i % 40}/sub${g}/**/*.ts`), lastUsed: new Date(Date.now() - ((i * 7919) % 300) * 1000).toISOString() }));
    const files = Array.from({ length: 2000 }, (_, i) => `pkg/mod${i}/file${i}.go`);
    const started = performance.now();
    rankForAgent(facts, new PathMatcher(files, 500));
    expect(performance.now() - started).toBeLessThan(1_000);
  });

  it("stops glob matching when the budget is spent and says so", () => {
    const facts = Array.from({ length: 50 }, (_, i) => fact({ paths: [`only${i}/**`] }));
    const matcher = new PathMatcher(["only49/x.ts"], 0);
    expect(facts.some((item) => matcher.matches(item))).toBe(false);
    expect(matcher.skipped).toBe(true);
  });

  it("keeps pinned facts visible past the expiry window", () => {
    const old = new Date(Date.now() - 400 * 24 * 60 * 60 * 1000).toISOString();
    expect(isVisibleToAgents(fact({ pinned: true, lastUsed: old }), 60)).toBe(true);
    expect(isVisibleToAgents(fact({ pinned: false, lastUsed: old }), 60)).toBe(false);
  });

  it("matches path globs and cited files", () => {
    expect(factMatchesFiles(fact({ paths: ["src/**/*.ts"] }), ["src/a/b.ts"])).toBe(true);
    expect(factMatchesFiles(fact({ paths: ["docs/**"] }), ["src/a.ts"])).toBe(false);
    expect(factMatchesFiles(fact({ citations: [{ path: "a.ts", commit: "abc1234" }] }), ["a.ts"])).toBe(true);
  });

  it("refuses path globs that escape the repo or expand without bound", () => {
    expect(pathGlobSchema.safeParse("src/{a,b}/*.ts").success).toBe(true);
    for (const bad of ["/etc/passwd", "../x", "src/{a,{b,c}}", "{a,b}/{c,d}", "src/$(rm)"]) expect(pathGlobSchema.safeParse(bad).success).toBe(false);
  });

  it("finds the files a worktree changed since branching, plus uncommitted ones", async () => {
    const origin = tempDir("origin-");
    git(origin, "init", "-q", "--bare");
    const seed = tempDir("seed-");
    git(seed, "init", "-q");
    await writeFile(join(seed, "base.ts"), "1\n");
    git(seed, "add", "-A");
    git(seed, "commit", "-q", "-m", "base");
    git(seed, "push", "-q", origin, "HEAD:main");
    git(origin, "symbolic-ref", "HEAD", "refs/heads/main");
    const clone = join(tempDir("clone-"), "c");
    execFileSync("git", ["clone", "-q", origin, clone]);
    git(clone, "checkout", "-q", "-b", "feature");
    await writeFile(join(clone, "committed.ts"), "x\n");
    git(clone, "add", "committed.ts");
    git(clone, "commit", "-q", "-m", "feature");
    await writeFile(join(clone, "base.ts"), "2\n");
    await writeFile(join(clone, "new.ts"), "y\n");
    expect((await workFiles(clone)).sort()).toEqual(["base.ts", "committed.ts", "new.ts"]);
    // From a subfolder, every path is still relative to the repo root.
    await mkdir(join(clone, "pkg"));
    await writeFile(join(clone, "pkg", "deep.ts"), "z\n");
    expect((await workFiles(join(clone, "pkg"))).sort()).toEqual(["base.ts", "committed.ts", "new.ts", "pkg/deep.ts"]);
  });

  it("schema defaults keep v1 fact files readable", () => {
    const v1 = { ...fact(), superseded: undefined, pinned: undefined, paths: undefined };
    const parsed = factSchema.parse(v1);
    expect(parsed.pinned).toBe(false);
    expect(parsed.paths).toEqual([]);
  });
});

function find(index: SearchIndex, facts: FactListItem[], query: string, limit: number): string[] {
  return index.search("ctx", facts, new Set(facts.map((item) => item.id)), query, limit);
}

describe("full-text search", () => {
  it("ranks by relevance, weighting subjects, and is fast on 200 facts", async () => {
    const index = new SearchIndex(tempDir("index-"));
    const filler = Array.from({ length: 197 }, (_, i) => fact({ subject: `note ${i}`, body: `unrelated text number ${i}` }));
    const inBody = fact({ subject: "test setup", body: "the DOCKER_HOST variable must point at the VM" });
    const inSubject = fact({ subject: "DOCKER_HOST timeout", body: "raise the timeout for DOCKER_HOST connections" });
    const weak = fact({ subject: "timeouts", body: "general timeout advice" });
    const facts = [...filler, inBody, weak, inSubject];
    const started = performance.now();
    const ids = find(index, facts, "DOCKER_HOST timeout", 5);
    const elapsed = performance.now() - started;
    expect(ids[0]).toBe(inSubject.id);
    expect(ids).toContain(inBody.id);
    expect(find(index, facts, "DOCKER_HOST", 5)).not.toContain(filler[0].id);
    expect(elapsed).toBeLessThan(200);
    const warm = performance.now();
    find(index, facts, "timeout", 5);
    expect(performance.now() - warm).toBeLessThan(50);
    index.close();
  });

  it("treats query text as words, never as query syntax", async () => {
    const index = new SearchIndex(tempDir("index-"));
    const facts = [fact({ subject: "deploy", body: "use make release" })];
    expect(() => find(index, facts, 'deploy" OR NOT (*) NEAR', 5)).not.toThrow();
    expect(find(index, facts, '"; DROP TABLE facts; --', 5)).toEqual([]);
    index.close();
  });

  it("keeps each repo's index apart and returns only allowed ids", async () => {
    const index = new SearchIndex(tempDir("index-"));
    const a = fact({ subject: "docker in repo a" });
    const b = fact({ subject: "docker in repo b" });
    expect(index.search("repo-a", [a], new Set([a.id]), "docker", 5)).toEqual([a.id]);
    expect(index.search("repo-b", [b], new Set([b.id]), "docker", 5)).toEqual([b.id]);
    expect(index.search("repo-a", [a], new Set([a.id]), "docker", 5)).toEqual([a.id]);
    expect(index.search("repo-a", [a], new Set(), "docker", 5)).toEqual([]);
    index.close();
  });

  it("rebuilds when the facts change, so results never go stale", async () => {
    const index = new SearchIndex(tempDir("index-"));
    const first = fact({ subject: "alpha" });
    expect(find(index, [first], "alpha", 5)).toEqual([first.id]);
    const second = fact({ subject: "beta" });
    expect(find(index, [second], "alpha", 5)).toEqual([]);
    expect(find(index, [second], "beta", 5)).toEqual([second.id]);
    index.close();
  });
});

describe("usage log", () => {
  it("counts shown, read, and found per fact, across compaction", async () => {
    const root = tempDir("usage-");
    const usage = new UsageLog(root, 300);
    for (let i = 0; i < 10; i += 1) await usage.record("shown", ["A", "B"]);
    await usage.record("read", ["A"]);
    await usage.record("found", ["A", "B"]);
    const counts = await usage.counts();
    expect(counts.A).toMatchObject({ shown: 10, read: 1, found: 1 });
    expect(counts.B).toMatchObject({ shown: 10, read: 0, found: 1 });
    expect(JSON.parse(await readFile(join(root, "usage-summary.json"), "utf8")).A.shown).toBeGreaterThan(0);
  });
});
