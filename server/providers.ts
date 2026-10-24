import { PROVIDERS } from "../shared/memory";

export type Provider = (typeof PROVIDERS)[number];

// Providers whose Paseo adapters pass both systemPrompt and HTTP MCP servers through (checked live).
export function supportedProvider(provider: string): Provider | null {
  const base = provider.split("/")[0];
  return (PROVIDERS as readonly string[]).includes(base) ? (base as Provider) : null;
}
