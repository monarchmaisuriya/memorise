import { errorText } from "./copy";
import { memoryChanged } from "./memory-events";

// A short notice after an action that moves a memory out of the list (archive, move), with Undo.
// It lives outside the card, which may be gone from the list by then; every open list shows the
// latest one until it is undone, dismissed, replaced, or NOTICE_MS has passed.
export const NOTICE_MS = 10_000;

export interface Notice {
  text: string;
  undo?: () => Promise<unknown>;
  tone?: "danger";
}

let current: Notice | null = null;
let timer: ReturnType<typeof setTimeout> | null = null;
const listeners = new Set<(notice: Notice | null) => void>();

function show(notice: Notice | null): void {
  current = notice;
  if (timer) clearTimeout(timer);
  timer = notice ? setTimeout(() => show(null), NOTICE_MS) : null;
  for (const listener of listeners) listener(current);
}

export function announce(notice: Notice): void {
  show(notice);
}

export function dismissNotice(): void {
  show(null);
}

export function onNotice(listener: (notice: Notice | null) => void): () => void {
  listeners.add(listener);
  listener(current);
  return () => {
    listeners.delete(listener);
  };
}

// Runs the current notice's undo once. A failure is shown in its place, never dropped.
export async function undoNotice(): Promise<void> {
  const undo = current?.undo;
  if (!undo) return;
  show(null);
  try {
    await undo();
    memoryChanged();
  } catch (error) {
    show({ text: `Couldn't undo: ${errorText(error)}`, tone: "danger" });
  }
}
