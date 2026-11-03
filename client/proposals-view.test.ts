import { describe, expect, it } from "vitest";
import { cardSuggestions } from "./proposals-view";

const waiting = (id: string, agentId: string | null) => ({ id, source: { agentId } });

describe("proposals card", () => {
  const proposals = [waiting("a", "agent-1"), waiting("b", "agent-1"), waiting("c", "agent-1"), waiting("d", "agent-2")];

  it("lists only the waiting suggestions its own pass added", () => {
    expect(cardSuggestions(proposals, "agent-1", ["b", "c"]).map((proposal) => proposal.id)).toEqual(["b", "c"]);
    // A decided suggestion is no longer waiting, so it drops out; another agent's never shows.
    expect(cardSuggestions(proposals, "agent-1", ["gone", "d"])).toEqual([]);
  });

  it("lists every waiting suggestion from the agent on a card that names none (added before 0.10.4)", () => {
    expect(cardSuggestions(proposals, "agent-1", undefined).map((proposal) => proposal.id)).toEqual(["a", "b", "c"]);
  });
});
