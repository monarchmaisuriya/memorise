// Saves made outside the Memory panel (the /remember command) tell open panels to reload.
const listeners = new Set<() => void>();

export function onMemoryChanged(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function memoryChanged(): void {
  for (const listener of listeners) listener();
}
