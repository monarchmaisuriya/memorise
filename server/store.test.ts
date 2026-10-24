import { chmod, mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { factIdSchema } from "../shared/memory";
import { MemoryStore, type NewFact, newFactId, parseFact } from "./store";
import { tempDir } from "./test-temp-dir";

const REPO = "github.com/acme/api";

function repoFact(body: string, overrides: Partial<NewFact> = {}): NewFact {
  return {
    scope: "repo",
    repoKey: REPO,
    type: "gotcha",
    subject: "integration tests",
    body,
    supersedes: null,
    source: { by: "agent", provider: "codex", branch: "main", commit: "3f2a1c9" },
    citations: [{ path: "scripts/test-int.sh", lines: "12-18", commit: "3f2a1c9" }],
    ...overrides,
  };
}

describe("MemoryStore", () => {
  let store: MemoryStore;
  beforeEach(async () => {
    store = new MemoryStore(tempDir("memorise-"));
  });

  it("creates sortable ids", () => {
    const first = newFactId(1_000);
    const second = newFactId(2_000);
    expect(factIdSchema.parse(first)).toBe(first);
    expect(first < second).toBe(true);
  });

  it("writes one Markdown file per fact under the repo key and reads it back", async () => {
    const fact = await store.create(repoFact("Integration tests need DOCKER_HOST set."));
    const files = await readdir(join(store.root, "repos", "github.com", "acme", "api"));
    expect(files).toEqual([`${fact.id}.md`]);
    const text = await readFile(join(store.root, "repos", "github.com", "acme", "api", files[0]), "utf8");
    expect(text).toMatch(/^---\n[\s\S]*\n---\nIntegration tests need DOCKER_HOST set\.\n$/);
    expect(parseFact(text)).toEqual(fact);
  });

  it("lists global facts with repo facts and keeps other repos out", async () => {
    await store.create(repoFact("Repo fact."));
    await store.create(repoFact("Other repo fact.", { repoKey: "github.com/acme/web" }));
    await store.create(repoFact("Global fact.", { scope: "global", repoKey: null, type: "preference" }));
    const bodies = (await store.list(REPO)).map((fact) => fact.body).sort();
    expect(bodies).toEqual(["Global fact.", "Repo fact."]);
    expect((await store.list(null)).map((fact) => fact.body)).toEqual(["Global fact."]);
  });

  it("supersedes with one new file and derives the old version's state from it", async () => {
    const old = await store.create(repoFact("Old wording."));
    const next = await store.supersede(old.id, REPO, { body: "New wording." });
    const listed = await store.list(REPO);
    expect(listed.find((fact) => fact.id === old.id)?.superseded).toBe(true);
    expect(listed.find((fact) => fact.id === next.id)).toMatchObject({ superseded: false, supersedes: old.id, body: "New wording." });
    await expect(store.supersede(old.id, REPO, { body: "Again." })).rejects.toThrow(/already replaced/);
  });

  it("retires without deleting", async () => {
    const fact = await store.create(repoFact("Soon retired."));
    await store.retire(fact.id, REPO);
    expect((await store.get(fact.id, REPO)).status).toBe("retired");
  });

  it("restores a retired fact", async () => {
    const fact = await store.create(repoFact("Back again."));
    await store.retire(fact.id, REPO);
    await store.restore(fact.id, REPO);
    expect((await store.get(fact.id, REPO)).status).toBe("active");
  });

  it("deletes a fact together with the versions it replaced", async () => {
    const old = await store.create(repoFact("v1"));
    const next = await store.supersede(old.id, REPO, { body: "v2" });
    await store.delete(next.id, REPO);
    expect(await store.list(REPO)).toEqual([]);
  });

  it("does not find a fact from another repo", async () => {
    const fact = await store.create(repoFact("Private to api.", { repoKey: "github.com/acme/web" }));
    await expect(store.get(fact.id, REPO)).rejects.toThrow(/No memory with id/);
  });

  it("keeps every write when many happen at once", async () => {
    const created = await Promise.all(Array.from({ length: 25 }, (_, i) => store.create(repoFact(`Fact ${i}.`))));
    await Promise.all(created.map((fact) => store.markUsed(fact.id, REPO)));
    expect((await store.list(REPO)).length).toBe(25);
  });

  it("reports and skips a broken hand-edited file instead of hiding the rest", async () => {
    const fact = await store.create(repoFact("Still listed."));
    await writeFile(join(store.root, "repos", "github.com", "acme", "api", "01JB8Z6X3T5Q9V2M4N7P8R1S0W.md"), "not frontmatter");
    expect((await store.list(REPO)).map((item) => item.id)).toEqual([fact.id]);
  });

  it("rejects a repo key that could escape the store", async () => {
    await expect(store.create(repoFact("Escape.", { repoKey: "github.com/../../etc" }))).rejects.toThrow();
  });

  it("returns a fact's whole version chain, newest first, from any version's id", async () => {
    const v1 = await store.create(repoFact("v1"));
    const v2 = await store.supersede(v1.id, REPO, { body: "v2" });
    const v3 = await store.supersede(v2.id, REPO, { body: "v3", type: "decision" });
    expect((await store.history(v1.id, REPO)).map((fact) => fact.body)).toEqual(["v3", "v2", "v1"]);
    expect((await store.history(v3.id, REPO))[0]).toMatchObject({ id: v3.id, type: "decision" });
  });

  it("reverts by writing a new version with an older version's content, overwriting nothing", async () => {
    const v1 = await store.create(repoFact("original", { subject: "first subject" }));
    const v2 = await store.supersede(v1.id, REPO, { subject: "second subject", body: "changed" });
    const source = { by: "user" as const, provider: null, branch: null, commit: null };
    const v3 = await store.revert(v2.id, v1.id, REPO, source);
    expect(v3).toMatchObject({ subject: "first subject", body: "original", supersedes: v2.id, source });
    expect((await store.history(v3.id, REPO)).map((fact) => fact.id)).toEqual([v3.id, v2.id, v1.id]);
    await expect(store.revert(v2.id, v1.id, REPO, source)).rejects.toThrow(/already replaced/);
  });

  it("moves a repo fact to global as a new fact, retiring the original and dropping its citations", async () => {
    const original = await store.create(repoFact("Prefer pnpm.", { paths: ["package.json"] }));
    const moved = await store.move(original.id, REPO, "global");
    expect(moved).toMatchObject({ scope: "global", repoKey: null, body: "Prefer pnpm.", paths: ["package.json"], citations: [], supersedes: null });
    expect((await store.get(original.id, REPO)).status).toBe("retired");
    expect((await store.list("github.com/acme/web")).map((fact) => fact.id)).toEqual([moved.id]);
    await expect(store.move(moved.id, REPO, "global")).rejects.toThrow(/already global/);
    await expect(store.move(moved.id, null, "repo")).rejects.toThrow(/Choose a repo/);
  });

  it("leaves only the original when retiring it fails during a move", async () => {
    const original = await store.create(repoFact("Stays put."));
    const repoDir = join(store.root, "repos", "github.com", "acme", "api");
    await mkdir(join(store.root, "global"), { recursive: true });
    await chmod(repoDir, 0o500);
    try {
      await expect(store.move(original.id, REPO, "global")).rejects.toThrow();
    } finally {
      await chmod(repoDir, 0o700);
    }
    const current = (await store.list(REPO)).filter((fact) => fact.status === "active" && !fact.superseded);
    expect(current.map((fact) => fact.id)).toEqual([original.id]);
  });

  it("counts current facts per repo and for global", async () => {
    const replaced = await store.create(repoFact("old"));
    await store.supersede(replaced.id, REPO, { body: "new" });
    const retired = await store.create(repoFact("gone"));
    await store.retire(retired.id, REPO);
    await store.create(repoFact("Global one.", { scope: "global", repoKey: null }));
    const summaries = await store.summaries();
    expect(summaries.map(({ repoKey, active, retired: count }) => ({ repoKey, active, retired: count }))).toEqual([
      { repoKey: null, active: 1, retired: 0 },
      { repoKey: REPO, active: 1, retired: 1 },
    ]);
    expect(summaries[1].lastModified).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });
});
