import { describe, expect, it } from "vitest";
import { moveFocus, reviewAction } from "./review-keys";

const key = (value: string, extra: Partial<{ metaKey: boolean; ctrlKey: boolean; altKey: boolean; inTextField: boolean }> = {}) => ({ key: value, metaKey: false, ctrlKey: false, altKey: false, inTextField: false, ...extra });

describe("review keys", () => {
  it("maps j/k and the arrows to moving, a to approve, and r to reject", () => {
    expect(["j", "ArrowDown", "k", "ArrowUp", "a", "r", "A", "R"].map((value) => reviewAction(key(value)))).toEqual(["next", "next", "previous", "previous", "approve", "reject", "approve", "reject"]);
  });

  it("does nothing while typing in a field, with a modifier held, or for other keys", () => {
    expect(reviewAction(key("a", { inTextField: true }))).toBeNull();
    expect(reviewAction(key("r", { metaKey: true }))).toBeNull();
    expect(reviewAction(key("j", { ctrlKey: true }))).toBeNull();
    expect(reviewAction(key("k", { altKey: true }))).toBeNull();
    expect(reviewAction(key("x"))).toBeNull();
  });

  it("moves focus within the list and keeps it there when the list shrinks", () => {
    expect(moveFocus(0, "next", 3)).toBe(1);
    expect(moveFocus(2, "next", 3)).toBe(2);
    expect(moveFocus(0, "previous", 3)).toBe(0);
    expect(moveFocus(5, "previous", 3)).toBe(1);
    expect(moveFocus(5, "next", 3)).toBe(2);
    expect(moveFocus(0, "next", 0)).toBe(0);
  });
});
