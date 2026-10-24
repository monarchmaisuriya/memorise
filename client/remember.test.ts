import { describe, expect, it } from "vitest";
import { parseRemember } from "./remember";

describe("parseRemember", () => {
  it("defaults to a repo reference", () => {
    expect(parseRemember("Deploys go through make release")).toEqual({ scope: "repo", type: "reference", subject: "Deploys go through make release", body: "Deploys go through make release" });
  });

  it("reads --global and a type prefix", () => {
    expect(parseRemember("--global preference: Never commit without asking")).toMatchObject({ scope: "global", type: "preference", body: "Never commit without asking" });
  });

  it("keeps an unknown prefix as part of the fact", () => {
    expect(parseRemember("note: keep this").body).toBe("note: keep this");
  });

  it("explains an empty fact", () => {
    expect(() => parseRemember("--global ")).toThrow(/Write the fact after \/remember/);
  });
});
