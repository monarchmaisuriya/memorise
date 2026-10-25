// Single-key review of suggestions, worked out without the DOM so it can be tested: j or ↓ moves
// to the next suggestion, k or ↑ to the previous one, a approves, r rejects. A key held with a
// modifier, or typed into a text field, is never a review key.
export type ReviewAction = "next" | "previous" | "approve" | "reject";

export interface ReviewKey {
  key: string;
  metaKey: boolean;
  ctrlKey: boolean;
  altKey: boolean;
  inTextField: boolean;
}

const ACTIONS: Record<string, ReviewAction> = { j: "next", arrowdown: "next", k: "previous", arrowup: "previous", a: "approve", r: "reject" };

export function reviewAction({ key, metaKey, ctrlKey, altKey, inTextField }: ReviewKey): ReviewAction | null {
  if (metaKey || ctrlKey || altKey || inTextField) return null;
  return ACTIONS[key.toLowerCase()] ?? null;
}

// The focused suggestion after a move, kept inside a list of `length` (which may have shrunk).
export function moveFocus(index: number, action: "next" | "previous", length: number): number {
  if (length === 0) return 0;
  const clamped = Math.min(index, length - 1);
  return action === "next" ? Math.min(clamped + 1, length - 1) : Math.max(clamped - 1, 0);
}
