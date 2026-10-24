import { describe, expect, it, vi } from "vitest";
import { memoryChanged, onMemoryChanged } from "./memory-events";

describe("memory change events", () => {
  it("reach open panels until they unsubscribe", () => {
    const listener = vi.fn();
    const unsubscribe = onMemoryChanged(listener);
    memoryChanged();
    unsubscribe();
    memoryChanged();
    expect(listener).toHaveBeenCalledTimes(1);
  });
});
