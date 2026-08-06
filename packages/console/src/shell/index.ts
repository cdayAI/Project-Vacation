/**
 * The app shell.
 *
 * The frame from specification §2 — top bar, rail, content, context panel — and
 * the state that makes it one thing rather than four: which zone you are in,
 * how wide the panel is on this route, whether the rail is collapsed for this
 * operator, and what the command palette is currently showing.
 *
 * This is the shell barrel only. `src/ui/index.ts` is assembled centrally once
 * every part of the library has landed; nothing here writes to it.
 */

export { AppShell, useShellLayout } from "./AppShell";
export type { AppShellProps } from "./AppShell";

export { Breadcrumb } from "./Breadcrumb";
export type { BreadcrumbProps } from "./Breadcrumb";

export { NavigationRail } from "./NavigationRail";
export type { NavigationRailProps } from "./NavigationRail";

export { TopBar } from "./TopBar";
export type { TopBarProps } from "./TopBar";

export { AvatarMenu } from "./AvatarMenu";
export type { AvatarMenuProps } from "./AvatarMenu";

export { NotificationsBell } from "./NotificationsBell";
export type { NotificationsBellProps, ShellNotification } from "./NotificationsBell";

export { ContextPanel } from "./ContextPanel";
export type { ContextPanelProps } from "./ContextPanel";

export { PlatformStateBanner } from "./PlatformStateBanner";
export type { PlatformStateBannerProps } from "./PlatformStateBanner";

export { DesignGalleryRoute } from "./DesignGalleryRoute";

export {
  PANEL_WIDTH_DEFAULT,
  PANEL_WIDTH_MAX,
  PANEL_WIDTH_MIN,
  clampPanelWidth,
  resolveShellLayout,
  useViewportWidth,
} from "./layout";
export type { LayoutInput, PanelMode, RailMode, ShellLayout } from "./layout";

export {
  DEFAULT_PANEL_PREFERENCE,
  SHELL_STORAGE_KEYS,
  readPanelPreference,
  readPanelPreferences,
  readRailCollapsed,
  writePanelPreference,
  writeRailCollapsed,
} from "./shellPreferences";
export type { PanelPreference, PanelPreferences } from "./shellPreferences";

export {
  IconApprovals,
  IconBell,
  IconChain,
  IconChart,
  IconExchange,
  IconLoop,
  IconPanelToggle,
  IconPulse,
  IconQueue,
  IconRailToggle,
  IconRole,
  IconSearchGlass,
  IconShield,
  IconSystem,
} from "./navIcons";
export type { NavIconProps } from "./navIcons";
