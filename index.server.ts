import type { PluginServerContext } from "@getpaseo/plugin/server";
import { resolveMemoryRoot } from "./server/paseo-home";
import { contributeMemory } from "./server/plugin";

export default function contribute(server: PluginServerContext) {
  return contributeMemory(server, resolveMemoryRoot);
}
