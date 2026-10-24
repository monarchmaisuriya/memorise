import { describe, expect, it, vi } from "vitest";
import { tempDir } from "./test-temp-dir";

// Fail the second removal, as a crash or a permission error partway through a delete would.
const removals = vi.hoisted(() => ({ count: 0 }));
vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...actual,
    rm: async (...args: Parameters<typeof actual.rm>) => {
      removals.count += 1;
      if (removals.count === 2) throw new Error("simulated failure");
      return actual.rm(...args);
    },
  };
});

const { MemoryStore } = await import("./store");

describe("an interrupted delete", () => {
  it("never makes a replaced version current again", async () => {
    const store = new MemoryStore(tempDir("agent-memory-"));
    const source = { by: "user" as const, provider: null, branch: null, commit: null };
    const v1 = await store.create({ scope: "repo", repoKey: "github.com/acme/api", type: "howto", subject: "s", body: "v1", supersedes: null, source, citations: [] });
    const v2 = await store.supersede(v1.id, "github.com/acme/api", { body: "v2" });
    const v3 = await store.supersede(v2.id, "github.com/acme/api", { body: "v3" });
    await expect(store.delete(v3.id, "github.com/acme/api")).rejects.toThrow("simulated failure");
    const current = (await store.list("github.com/acme/api")).filter((fact) => !fact.superseded).map((fact) => fact.body);
    expect(current).toEqual(["v3"]);
  });
});
