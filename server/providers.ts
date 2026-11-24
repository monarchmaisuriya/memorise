import { PROVIDERS, WORKER_PROVIDERS } from "../shared/memory";

export type Provider = (typeof PROVIDERS)[number];
export type WorkerProvider = (typeof WORKER_PROVIDERS)[number];

// Providers whose Paseo adapters pass both systemPrompt and HTTP MCP servers through (checked live).
export function supportedProvider(provider: string): Provider | null {
  const base = provider.split("/")[0];
  return (PROVIDERS as readonly string[]).includes(base) ? (base as Provider) : null;
}

// Providers whose tools can be locked down for untrusted background workers (checked live).
export function workerProvider(provider: string): WorkerProvider | null {
  const base = provider.split("/")[0];
  return (WORKER_PROVIDERS as readonly string[]).includes(base) ? (base as WorkerProvider) : null;
}
