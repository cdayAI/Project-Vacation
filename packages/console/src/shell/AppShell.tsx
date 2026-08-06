import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type ReactNode,
  type RefObject,
} from "react";
import { useCommandSource } from "../keyboard/KeyboardProvider";
import type { CommandDefinition } from "../keyboard/registry";
import type { BreadcrumbEntry, NavigationZone } from "../routes";
import { navigate } from "../routing";
import { useTheme } from "../theme/ThemeProvider";
import { CommandPalette } from "../ui/palette/CommandPalette";
import { ShortcutReference } from "../ui/palette/ShortcutReference";
import { GLASS_PRIORITY, useGlassSurface } from "../ui/surfaces/glassSurface";
import { ContextPanel } from "./ContextPanel";
import { NavigationRail } from "./NavigationRail";
import { TopBar } from "./TopBar";
import type { ShellNotification } from "./NotificationsBell";
import { resolveShellLayout, useViewportWidth, type ShellLayout } from "./layout";
import {
  readPanelPreference,
  readRailCollapsed,
  writePanelPreference,
  writeRailCollapsed,
} from "./shellPreferences";
import "./AppShell.css";

/**
 * The frame.
 *
 * Specification §2's three-column shell: a 56px glass top bar, a 240px rail
 * that collapses to 64px, content with 24px gutters, and a 380px glass context
 * panel that resizes between 320 and 520 and remembers its state per route.
 *
 * What this component owns is the *state* of the frame — which is the part that
 * has to be in one place. The rail's collapse, the panel's width and collapse,
 * the palette, and the shortcut reference are all reachable from three
 * directions each: a control in the chrome, a keyboard verb, and a palette
 * command. Holding that state anywhere else would mean three copies of it, and
 * three copies of a toggle is how a panel ends up open according to the button
 * and closed according to the keyboard.
 *
 * -----------------------------------------------------------------------------
 * WHAT IT KEEPS FROM THE SHELL IT REPLACES
 *
 * Four things, and none of them are decoration:
 *
 *   - the **skip link** first in the document, so one keypress reaches content;
 *   - exactly one **`<main>` landmark**, which the route change moves focus to;
 *   - the **route-change announcement**, without which a client-side navigation
 *     is silent to a screen reader;
 *   - the **platform-state banner**, which states the three facts an operator
 *     must never go looking for.
 *
 * -----------------------------------------------------------------------------
 * THE BLUR BUDGET
 *
 * Three chrome surfaces and the budget is three (§1.5): the top bar and the
 * rail lease here, the context panel leases inside `Panel`. When a modal, a
 * sheet, or the palette opens it outranks all three and one of them quietly
 * renders solid — under a scrim, where nobody sees it happen.
 */

export interface AppShellProps {
  readonly zones: readonly NavigationZone[];
  readonly breadcrumb: readonly BreadcrumbEntry[];
  /** Identifies the surface for the panel's per-route memory. */
  readonly routeId: string;

  readonly actorName: string;
  readonly actorRoles: readonly string[];
  readonly readOnly?: boolean;

  /** The platform-state banner. Between the top bar and `<main>`, never inside it. */
  readonly banner?: ReactNode;

  /** What the context panel is showing. The copilot lives inside it. */
  readonly contextTitle?: string;
  readonly contextDescription?: ReactNode;
  readonly contextPanel?: ReactNode;

  readonly notifications?: readonly ShellNotification[];
  readonly onOpenNotification?: (notification: ShellNotification) => void;
  readonly onSignOut?: () => void;

  /**
   * Where Escape goes from here — the parent surface, if this one has one.
   * Registered as a command so it is in the palette and in the reference too.
   */
  readonly backTo?: { readonly label: string; readonly path: string };

  /** Focused on every route change. Owned by the caller, which announces it. */
  readonly mainRef: RefObject<HTMLElement | null>;
  readonly children: ReactNode;
}

/**
 * The layout a screen is being drawn into.
 *
 * Two of specification §2's rungs change what a *screen* should render, not
 * only what the frame looks like: below 900 the guidance is "read-only layouts
 * only — no data entry designed for phones unless the owner asks", and a
 * screen with a form has to know that. Reading it from here rather than from a
 * media query in each screen keeps one answer to the question, and it is the
 * same answer the frame acted on.
 */
const ShellLayoutContext = createContext<ShellLayout | null>(null);

export function useShellLayout(): ShellLayout {
  const layout = useContext(ShellLayoutContext);
  if (layout === null) {
    throw new Error("useShellLayout was called outside AppShell.");
  }
  return layout;
}

/** Which navigation item each "go to" verb lands on. */
const GO_TO_SHORTCUTS: Readonly<Record<string, "goQueue" | "goApprovals" | "goEvidence">> = {
  work: "goQueue",
  approvals: "goApprovals",
  audit: "goEvidence",
};

export function AppShell({
  zones,
  breadcrumb,
  routeId,
  actorName,
  actorRoles,
  readOnly = false,
  banner,
  contextTitle = "Context",
  contextDescription,
  contextPanel,
  notifications,
  onOpenNotification,
  onSignOut,
  backTo,
  mainRef,
  children,
}: AppShellProps) {
  const paletteTriggerRef = useRef<HTMLButtonElement | null>(null);

  const [paletteOpen, setPaletteOpen] = useState(false);
  const [shortcutsOpen, setShortcutsOpen] = useState(false);
  const [copilotFocus, setCopilotFocus] = useState(0);

  const [railCollapsed, setRailCollapsed] = useState<boolean>(() => readRailCollapsed());
  const [panelPreference, setPanelPreference] = useState(() => readPanelPreference(routeId));
  /**
   * The overlay sheet is open only because the operator opened it, and it is
   * not remembered.
   *
   * Below 900px the panel covers the screen. Restoring "it was open on this
   * route yesterday" would greet somebody on a small screen with a sheet over
   * the thing they came to read, and a stored preference set on a desktop would
   * do it to them on a phone.
   */
  const [overlayOpen, setOverlayOpen] = useState(false);

  // Per route (§2). Re-read rather than kept per key in memory: the operator may
  // have changed it in another tab, and a stored preference that loses to a
  // stale in-memory copy is a preference that appears not to save.
  useEffect(() => {
    setPanelPreference(readPanelPreference(routeId));
  }, [routeId]);

  const viewportWidth = useViewportWidth();
  const layout = resolveShellLayout(viewportWidth, {
    railCollapsed,
    panelWidth: panelPreference.width,
  });

  const { themePreference, setThemePreference, density, setDensity, transparency, setTransparency } =
    useTheme();

  const topBarSurface = useGlassSurface({ priority: GLASS_PRIORITY.chrome });
  const railSurface = useGlassSurface({ priority: GLASS_PRIORITY.chrome });

  const toggleRail = useCallback(() => {
    setRailCollapsed((current) => {
      const next = !current;
      writeRailCollapsed(next);
      return next;
    });
  }, []);

  const panelCollapsed = layout.panel === "overlay" ? !overlayOpen : panelPreference.collapsed;

  const setPanelCollapsed = useCallback(
    (collapsed: boolean) => {
      if (layout.panel === "overlay") {
        setOverlayOpen(!collapsed);
        return;
      }
      setPanelPreference((current) => {
        const next = { ...current, collapsed };
        writePanelPreference(routeId, next);
        return next;
      });
    },
    [layout.panel, routeId],
  );

  const onWidthChange = useCallback((width: number) => {
    // Not written here: a drag fires this on every pointer move, and writing
    // storage sixty times a second is how a resize starts to feel heavy.
    setPanelPreference((current) => ({ ...current, width }));
  }, []);

  const onWidthCommit = useCallback(
    (width: number) => {
      setPanelPreference((current) => {
        const next = { ...current, width };
        writePanelPreference(routeId, next);
        return next;
      });
    },
    [routeId],
  );

  const focusCopilot = useCallback(() => {
    setPanelCollapsed(false);
    setCopilotFocus((current) => current + 1);
  }, [setPanelCollapsed]);

  // ---------------------------------------------------------------------------
  // What the shell contributes to the registry
  // ---------------------------------------------------------------------------

  const navigationCommands = useMemo<readonly CommandDefinition[]>(() => {
    const items = zones.flatMap((zone) => zone.items.map((item) => ({ zone, item })));

    // "Go to settings" has no settings screen to land on — configuration lives
    // across the Admin zone. It lands on the first Admin surface this role can
    // open, and is simply not registered when the role has none, which is why
    // the reference can say honestly that the verb does nothing here.
    const firstAdmin = items.find((entry) => entry.zone.id === "admin");

    return items.map(({ zone, item }) => {
      const goTo = GO_TO_SHORTCUTS[item.id];
      const isSettingsLanding = firstAdmin !== undefined && firstAdmin.item.id === item.id;
      const shortcut = goTo ?? (isSettingsLanding ? "goSettings" : undefined);

      return {
        id: `navigate.${item.id}`,
        label: item.label,
        kind: "navigate",
        hint: item.hint,
        keywords: [zone.label, item.path],
        ...(shortcut === undefined ? {} : { shortcut }),
        run: () => navigate(item.path),
      } satisfies CommandDefinition;
    });
  }, [zones]);

  const shellCommands = useMemo<readonly CommandDefinition[]>(() => {
    const commands: CommandDefinition[] = [
      {
        id: "shell.command-palette",
        label: "Command palette",
        kind: "action",
        shortcut: "commandPalette",
        hidden: true,
        run: () => setPaletteOpen(true),
      },
      {
        id: "shell.search",
        label: "Search this screen",
        kind: "action",
        shortcut: "search",
        // The fallback for a screen with no search of its own. A screen that
        // has one registers the same verb and, being mounted later, wins.
        hidden: true,
        run: () => setPaletteOpen(true),
      },
      {
        id: "shell.shortcuts",
        label: "Keyboard shortcuts",
        kind: "action",
        hint: "Every verb, and whether it does anything on this screen.",
        keywords: ["help", "keys", "reference"],
        shortcut: "shortcutReference",
        run: () => setShortcutsOpen(true),
      },
      {
        id: "shell.copilot",
        label: "Focus the copilot",
        kind: "action",
        hint: "Opens the context panel and puts the cursor in the composer.",
        keywords: ["assistant", "ask", "chat"],
        shortcut: "focusCopilot",
        run: focusCopilot,
      },
      {
        id: "shell.toggle-panel",
        label: panelCollapsed ? "Show the context panel" : "Hide the context panel",
        kind: "action",
        hint: "Remembered separately for each screen.",
        keywords: ["panel", "sidebar", "context"],
        run: () => setPanelCollapsed(!panelCollapsed),
      },
      {
        id: "shell.toggle-rail",
        label: railCollapsed ? "Expand navigation" : "Collapse navigation to icons",
        kind: "action",
        keywords: ["rail", "sidebar", "menu"],
        ...(layout.railIsChoice
          ? {}
          : {
              disabled: true,
              disabledReason: "there is not enough width for labels on this screen",
            }),
        run: toggleRail,
      },
    ];

    // Only the changes that would change something. A palette offering "Use the
    // light theme" to somebody already in it is a palette padded with no-ops.
    if (themePreference !== "dark") {
      commands.push({
        id: "shell.theme-dark",
        label: "Use the dark theme",
        kind: "action",
        keywords: ["appearance", "night"],
        run: () => setThemePreference("dark"),
      });
    }
    if (themePreference !== "light") {
      commands.push({
        id: "shell.theme-light",
        label: "Use the light theme",
        kind: "action",
        keywords: ["appearance", "day"],
        run: () => setThemePreference("light"),
      });
    }
    if (themePreference !== "system") {
      commands.push({
        id: "shell.theme-system",
        label: "Match my system theme",
        kind: "action",
        keywords: ["appearance", "automatic"],
        run: () => setThemePreference("system"),
      });
    }

    commands.push({
      id: "shell.density",
      label: density === "compact" ? "Use comfortable density" : "Use compact density",
      kind: "action",
      hint:
        density === "compact"
          ? "Taller rows, easier to read across."
          : "About a third more rows on a screen.",
      keywords: ["rows", "spacing", "size"],
      run: () => setDensity(density === "compact" ? "comfortable" : "compact"),
    });

    commands.push({
      id: "shell.transparency",
      label: transparency === "reduced" ? "Allow transparency" : "Reduce transparency",
      kind: "action",
      hint: "Replaces every frosted surface with a solid one.",
      keywords: ["glass", "blur", "accessibility"],
      run: () => setTransparency(transparency === "reduced" ? "system" : "reduced"),
    });

    if (backTo !== undefined) {
      commands.push({
        id: "shell.back",
        label: `Back to ${backTo.label.toLowerCase()}`,
        kind: "navigate",
        shortcut: "dismiss",
        keywords: ["escape", "up", "close"],
        // Escape is allowed while typing, but *this* Escape is not: leaving the
        // screen from inside a half-written rejection reason would throw the
        // reason away, and the reason is improvement signal (§3.2).
        whileTyping: false,
        run: () => navigate(backTo.path),
      });
    }

    return commands;
  }, [
    backTo,
    density,
    focusCopilot,
    layout.railIsChoice,
    panelCollapsed,
    railCollapsed,
    setDensity,
    setPanelCollapsed,
    setThemePreference,
    setTransparency,
    themePreference,
    toggleRail,
    transparency,
  ]);

  const commands = useMemo(
    () => [...navigationCommands, ...shellCommands],
    [navigationCommands, shellCommands],
  );
  useCommandSource(commands);

  return (
    <ShellLayoutContext.Provider value={layout}>
      <div
        className="pv-shell"
        data-rail={layout.rail}
        data-panel={layout.panel}
        data-panel-collapsed={panelCollapsed ? "true" : undefined}
        // A measurement, not a design value: the rail's two widths are tokens
        // and are chosen in CSS from `data-rail`, but the panel's width is
        // whatever the operator dragged it to, so it can only arrive from here.
        style={{ "--pv-shell-panel-current": `${layout.panelWidth}px` } as CSSProperties}
      >
        {/* First in the document, always. One press from a fresh page load puts
            a keyboard operator in the content. */}
        <a className="pv-skip-link" href="#main-content">
          Skip to main content
        </a>

        <TopBar
          breadcrumb={breadcrumb}
          onOpenPalette={() => setPaletteOpen(true)}
          paletteTriggerRef={paletteTriggerRef}
          railCollapsed={layout.rail === "icons"}
          railIsChoice={layout.railIsChoice}
          onToggleRail={toggleRail}
          panelCollapsed={panelCollapsed}
          onTogglePanel={() => setPanelCollapsed(!panelCollapsed)}
          actorName={actorName}
          actorRoles={actorRoles}
          readOnly={readOnly}
          {...(notifications === undefined ? {} : { notifications })}
          {...(onOpenNotification === undefined ? {} : { onOpenNotification })}
          onShowShortcuts={() => setShortcutsOpen(true)}
          {...(onSignOut === undefined ? {} : { onSignOut })}
          surfaceClassName={topBarSurface.surfaceClassName}
        />

        <NavigationRail
          zones={zones}
          collapsed={layout.rail === "icons"}
          surfaceClassName={railSurface.surfaceClassName}
        />

        <div className="pv-shell-content">
          {banner}
          {/* tabIndex -1 so a route change can move focus here. Not in the tab
              order; the skip link is what puts a keyboard user into the content. */}
          <main className="pv-shell-main" id="main-content" ref={mainRef} tabIndex={-1}>
            <div className="pv-shell-main-inner">{children}</div>
          </main>
        </div>

        <ContextPanel
          title={contextTitle}
          {...(contextDescription === undefined ? {} : { description: contextDescription })}
          mode={layout.panel}
          collapsed={panelCollapsed}
          width={layout.panelWidth}
          onCollapsedChange={setPanelCollapsed}
          onWidthChange={onWidthChange}
          onWidthCommit={onWidthCommit}
          readOnly={readOnly}
          focusSignal={copilotFocus}
          {...(contextPanel === undefined ? {} : { children: contextPanel })}
        />

        <CommandPalette
          open={paletteOpen}
          onClose={() => setPaletteOpen(false)}
          triggerRef={paletteTriggerRef}
          readOnly={readOnly}
        />

        <ShortcutReference open={shortcutsOpen} onClose={() => setShortcutsOpen(false)} />
      </div>
    </ShellLayoutContext.Provider>
  );
}
