import { Platform } from "react-native";
import type { ReviewKey } from "./review-keys";

// The only module that touches the DOM, and only on web. Just what it uses is declared here; on
// other platforms every export is a no-op.
interface KeyboardEventLike {
  key: string;
  metaKey: boolean;
  ctrlKey: boolean;
  altKey: boolean;
  target: unknown;
  preventDefault(): void;
}
declare const window: { addEventListener(type: "keydown", listener: (event: KeyboardEventLike) => void): void; removeEventListener(type: "keydown", listener: (event: KeyboardEventLike) => void): void } | undefined;

function inTextField(target: unknown): boolean {
  const element = target as { tagName?: string; isContentEditable?: boolean } | null;
  return element !== null && typeof element === "object" && (element.isContentEditable === true || ["INPUT", "TEXTAREA", "SELECT"].includes(element.tagName ?? ""));
}

// Calls `handler` for each key press on web; when it returns true the key's default action is
// stopped. Returns the remover.
export function onKey(handler: (key: ReviewKey) => boolean): () => void {
  if (Platform.OS !== "web" || typeof window === "undefined") return () => undefined;
  const listener = (event: KeyboardEventLike) => {
    if (handler({ key: event.key, metaKey: event.metaKey, ctrlKey: event.ctrlKey, altKey: event.altKey, inTextField: inTextField(event.target) })) event.preventDefault();
  };
  window.addEventListener("keydown", listener);
  return () => window?.removeEventListener("keydown", listener);
}

export const keyboardAvailable = Platform.OS === "web";

// Scrolls a rendered view (on web, its DOM element) into sight, as little as needed.
export function scrollIntoView(node: unknown): void {
  if (Platform.OS !== "web") return;
  (node as { scrollIntoView?(options: { block: "nearest"; behavior: "smooth" }): void } | null)?.scrollIntoView?.({ block: "nearest", behavior: "smooth" });
}
