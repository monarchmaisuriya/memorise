import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { INBOX_DAILY_LIMIT, Interop } from "./interop";
import { ProposalStore } from "./proposals";
import { MemoryStore, type NewFact } from "./store";
import { tempDir } from "./test-temp-dir";

const REPO = "github.com/acme/api";
const NOW = new Date("2026-10-29T12:00:00.000Z");

function repoFact(body: string, overrides: Partial<NewFact> = {}): NewFact {
  return {
    scope: "repo",
    repoKey: REPO,
    type: "gotcha",
    subject: "item refs",
    body,
    supersedes: null,
    source: { by: "agent", provider: "codex", branch: "main", commit: "3f2a1c9" },
    citations: [{ path: "shared/contracts.ts", lines: "40-52", commit: "3f2a1c9" }],
    ...overrides,
  };
}

describe("Interop", () => {
  let root: string;
  let store: MemoryStore;
  let proposals: ProposalStore;
  let interop: Interop;
  const v1 = () => join(root, "interop", "v1");
  const drop = async (name: string, content: unknown, repoKey = REPO) => {
    const dir = join(v1(), "inbox", ...repoKey.split("/"));
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, name), typeof content === "string" ? content : JSON.stringify(content));
  };
  const suggestion = (target: string, overrides: Record<string, unknown> = {}) => ({
    version: 1,
    from: "contextualise",
    kind: "retire",
    targets: [target],
    reason: "Cites parseItemRef in shared/contracts.ts, removed at 9c1d2e3.",
    ...overrides,
  });

  beforeEach(() => {
    root = tempDir("memorise-interop-");
    store = new MemoryStore(root);
    proposals = new ProposalStore(root);
    interop = new Interop({ root, store, proposals, now: () => NOW });
  });

  it("writes a status file that names the contract version and the time", async () => {
    await interop.writeStatus();
    expect(JSON.parse(await readFile(join(v1(), "status.json"), "utf8"))).toEqual({ version: 1, plugin: "memorise", writtenAt: NOW.toISOString() });
  });

  it("exports each project's memories without their text, and leaves global memories out", async () => {
    const fact = await store.create(repoFact("parseItemRef accepts bare Jira keys.", { paths: ["shared/**"] }));
    await store.create(repoFact("Prefer short answers.", { scope: "global", repoKey: null, type: "preference" }));
    await interop.exportAll();
    const exported = JSON.parse(await readFile(join(v1(), "export", "github.com", "acme", "api.json"), "utf8"));
    expect(exported).toEqual({
      version: 1,
      repoKey: REPO,
      writtenAt: NOW.toISOString(),
      memories: [
        {
          id: fact.id,
          type: "gotcha",
          subject: "item refs",
          status: "active",
          enabled: true,
          paths: ["shared/**"],
          citations: [{ path: "shared/contracts.ts", lines: "40-52", commit: "3f2a1c9" }],
        },
      ],
    });
    expect(JSON.stringify(exported)).not.toContain("bare Jira keys");
  });

  it("leaves superseded versions out of the export", async () => {
    const fact = await store.create(repoFact("Old wording."));
    const newer = await store.supersede(fact.id, REPO, { body: "New wording." });
    await interop.exportAll();
    const exported = JSON.parse(await readFile(join(v1(), "export", "github.com", "acme", "api.json"), "utf8"));
    expect(exported.memories.map((memory: { id: string }) => memory.id)).toEqual([newer.id]);
  });

  it("files a retire suggestion from another plugin for review and removes it from the inbox", async () => {
    const fact = await store.create(repoFact("parseItemRef accepts bare Jira keys."));
    await drop("a.json", suggestion(fact.id));
    expect(await interop.ingest()).toEqual({ accepted: 1, rejected: 0 });
    const [proposal] = await proposals.list(REPO);
    expect(proposal).toMatchObject({
      kind: "retire",
      targets: [fact.id],
      type: "gotcha",
      subject: "item refs",
      body: "parseItemRef accepts bare Jira keys.",
      reason: "Cites parseItemRef in shared/contracts.ts, removed at 9c1d2e3.",
      source: { from: "plugin", plugin: "contextualise", agentId: null, provider: "contextualise", model: null },
    });
    expect(await readdir(join(v1(), "inbox", "github.com", "acme", "api"))).toEqual([]);
  });

  it("files a replace suggestion with the new wording", async () => {
    const fact = await store.create(repoFact("parseItemRef accepts bare Jira keys."));
    await drop("a.json", suggestion(fact.id, { kind: "replace", body: "parseRef accepts bare Jira keys.", reason: "parseItemRef was renamed to parseRef." }));
    await interop.ingest();
    expect((await proposals.list(REPO))[0]).toMatchObject({ kind: "replace", subject: "item refs", body: "parseRef accepts bare Jira keys." });
  });

  it.each([
    ["a target that does not exist", () => suggestion("01JB8Z6X3T5Q9V2M4N7P8R1S0W"), "no active memory"],
    ["a replace with no new wording", (id: string) => suggestion(id, { kind: "replace" }), "new subject or text"],
    ["a kind other plugins may not send", (id: string) => suggestion(id, { kind: "new" }), "kind"],
    ["an unknown field", (id: string) => ({ ...suggestion(id), approve: true }), "approve"],
    ["text that looks like a secret", (id: string) => suggestion(id, { kind: "replace", body: "Use token ghp_abcdefghijklmnopqrstuvwxyz0123456789 here." }), "secret"],
    ["a file that is not JSON", () => "{not json", "JSON"],
  ])("moves %s to inbox-rejected with the reason", async (_label, make, reason) => {
    const fact = await store.create(repoFact("parseItemRef accepts bare Jira keys."));
    await drop("bad.json", make(fact.id));
    expect(await interop.ingest()).toEqual({ accepted: 0, rejected: 1 });
    expect(await proposals.list(REPO)).toEqual([]);
    const [name] = await readdir(join(v1(), "inbox-rejected"));
    expect(await readFile(join(v1(), "inbox-rejected", name), "utf8")).toContain(reason);
  });

  it("does not suggest again what the user rejected", async () => {
    const fact = await store.create(repoFact("parseItemRef accepts bare Jira keys."));
    await drop("a.json", suggestion(fact.id));
    await interop.ingest();
    const [first] = await proposals.list(REPO);
    await proposals.reject(first.id, REPO);
    await drop("b.json", suggestion(fact.id));
    await interop.ingest();
    expect(await proposals.list(REPO)).toEqual([]);
  });

  it(`accepts at most ${INBOX_DAILY_LIMIT} suggestions per project per day and leaves the rest waiting`, async () => {
    const facts = [];
    for (let i = 0; i <= INBOX_DAILY_LIMIT; i += 1) facts.push(await store.create(repoFact(`Memory number ${i}.`, { subject: `memory ${i}` })));
    for (const [i, fact] of facts.entries()) await drop(`${String(i).padStart(2, "0")}.json`, suggestion(fact.id));
    expect(await interop.ingest()).toEqual({ accepted: INBOX_DAILY_LIMIT, rejected: 0 });
    expect(await readdir(join(v1(), "inbox", "github.com", "acme", "api"))).toHaveLength(1);
  });

  it("ignores inbox folders that are not a project key", async () => {
    const dir = join(v1(), "inbox", "..hidden");
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, "a.json"), JSON.stringify(suggestion("01JB8Z6X3T5Q9V2M4N7P8R1S0W")));
    expect(await interop.ingest()).toEqual({ accepted: 0, rejected: 0 });
  });
});
