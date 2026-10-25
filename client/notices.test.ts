import { afterEach, describe, expect, it, vi } from "vitest";
import { announce, dismissNotice, type Notice, NOTICE_MS, onNotice, undoNotice } from "./notices";

afterEach(() => {
  dismissNotice();
  vi.useRealTimers();
});

describe("notices with undo", () => {
  it("shows the latest notice to every open list, and clears it after a while", () => {
    vi.useFakeTimers();
    const seen: (Notice | null)[] = [];
    const stop = onNotice((notice) => seen.push(notice));
    announce({ text: "Archived “Local dev ports”" });
    expect(seen.at(-1)?.text).toBe("Archived “Local dev ports”");
    vi.advanceTimersByTime(NOTICE_MS);
    expect(seen.at(-1)).toBeNull();
    stop();
  });

  it("runs the undo once and clears the notice", async () => {
    const undo = vi.fn(async () => undefined);
    let latest: Notice | null = null;
    const stop = onNotice((notice) => {
      latest = notice;
    });
    announce({ text: "Archived", undo });
    await undoNotice();
    await undoNotice();
    expect(undo).toHaveBeenCalledTimes(1);
    expect(latest).toBeNull();
    stop();
  });

  it("says when the undo failed, with the error's own text", async () => {
    let latest: Notice | null = null;
    const stop = onNotice((notice) => {
      latest = notice;
    });
    announce({
      text: "Archived",
      undo: async () => {
        throw Object.assign(new Error("Request failed: Memory not found requestType=plugin.rpc.invoke.request code=handler_error"), { requestType: "plugin.rpc.invoke.request", code: "handler_error" });
      },
    });
    await undoNotice();
    expect(latest).toEqual({ text: "Couldn't undo: Memory not found", tone: "danger" });
    stop();
  });
});
