import type { PluginSidebarItemProps } from "@getpaseo/plugin/client";
import { SidebarRow } from "@getpaseo/plugin/client/ui";

// Shown, hidden, and moved under Paseo's Settings > Sidebar.
export function MemoriseSidebarItem({ currentScreen, openScreen }: PluginSidebarItemProps) {
  return <SidebarRow icon="Brain" active={currentScreen?.screenId === "manager"} onPress={() => openScreen({ screenId: "manager" })} />;
}
