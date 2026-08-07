import type { RefObject } from "react";
import { SHORTCUTS, displaySequence } from "../keyboard/shortcuts";
import type { BreadcrumbEntry } from "../routes";
import { Tooltip } from "../ui/primitives/Tooltip";
import { Breadcrumb } from "./Breadcrumb";
import { NotificationsBell, type ShellNotification } from "./NotificationsBell";
import { AvatarMenu } from "./AvatarMenu";
import { IconPanelToggle, IconRailToggle, IconSearchGlass } from "./navIcons";
import "./TopBar.css";

/**
 * The 56px top bar.
 *
 * Four things, in the order specification §2 puts them: where you are, the way
 * to get anywhere, what has happened while you were working, and who you are.
 *
 * The centred command trigger is the part worth defending. It is a button that
 * says what it does and prints its own shortcut, not a search field. A field
 * would invite typing into the chrome, and this console's search is always the
 * search of a *screen* — the queue's filter, the audit browser's rail. The
 * palette is a different thing: it is how you leave. Making it look like a
 * field would have taught operators the wrong model on their first morning, and
 * printing `⌘K` on it teaches the right one on their second.
 */

export interface TopBarProps {
  readonly breadcrumb: readonly BreadcrumbEntry[];

  readonly onOpenPalette: () => void;
  readonly paletteTriggerRef: RefObject<HTMLButtonElement | null>;

  readonly railCollapsed: boolean;
  /** False below 1024, where the rail is icons because there is no room. */
  readonly railIsChoice: boolean;
  readonly onToggleRail: () => void;

  readonly panelCollapsed: boolean;
  readonly onTogglePanel: () => void;

  readonly actorName: string;
  readonly actorRoles: readonly string[];
  readonly readOnly?: boolean;

  readonly notifications?: readonly ShellNotification[];
  readonly onOpenNotification?: (notification: ShellNotification) => void;

  readonly onShowShortcuts: () => void;
  readonly onSignOut?: () => void;

  /** The glass or designed-solid class the shell leased for its chrome. */
  readonly surfaceClassName: string;
}

export function TopBar({
  breadcrumb,
  onOpenPalette,
  paletteTriggerRef,
  railCollapsed,
  railIsChoice,
  onToggleRail,
  panelCollapsed,
  onTogglePanel,
  actorName,
  actorRoles,
  readOnly = false,
  notifications,
  onOpenNotification,
  onShowShortcuts,
  onSignOut,
  surfaceClassName,
}: TopBarProps) {
  const paletteKeys = displaySequence(SHORTCUTS.commandPalette);

  return (
    <header className={`pv-topbar ${surfaceClassName}`}>
      <div className="pv-topbar-lead">
        <Tooltip
          content={
            railIsChoice
              ? railCollapsed
                ? "Show the navigation labels"
                : "Collapse navigation to icons"
              : "There is not enough width for labels on this screen"
          }
        >
          <button
            type="button"
            className="pv-topbar-icon-button"
            aria-label={railCollapsed ? "Expand navigation" : "Collapse navigation"}
            // Describes the rail, which is a sibling region — the pressed state
            // would say "on"/"off" without saying what is on.
            aria-expanded={!railCollapsed}
            aria-controls="primary-navigation"
            aria-disabled={railIsChoice ? undefined : true}
            onClick={() => {
              if (railIsChoice) onToggleRail();
            }}
          >
            <IconRailToggle />
          </button>
        </Tooltip>

        <Breadcrumb entries={breadcrumb} />
      </div>

      <div className="pv-topbar-centre">
        <button
          ref={paletteTriggerRef}
          type="button"
          className="pv-command-trigger"
          onClick={onOpenPalette}
        >
          <IconSearchGlass className="pv-command-trigger-mark" />
          <span className="pv-command-trigger-label">Search or run a command</span>
          {/* Decorative: the button's own words already name it, and hearing
              "Meta K" appended to every mention of it is noise. */}
          <kbd className="pv-command-trigger-keys" aria-hidden="true">
            {paletteKeys}
          </kbd>
        </button>
      </div>

      <div className="pv-topbar-trailing">
        <Tooltip content={panelCollapsed ? "Show the context panel" : "Hide the context panel"}>
          <button
            type="button"
            className="pv-topbar-icon-button"
            aria-label={panelCollapsed ? "Show the context panel" : "Hide the context panel"}
            aria-expanded={!panelCollapsed}
            aria-controls="context-panel"
            onClick={onTogglePanel}
          >
            <IconPanelToggle />
          </button>
        </Tooltip>

        <NotificationsBell
          notifications={notifications}
          {...(onOpenNotification === undefined ? {} : { onOpenNotification })}
        />

        <AvatarMenu
          name={actorName}
          roles={actorRoles}
          readOnly={readOnly}
          onShowShortcuts={onShowShortcuts}
          {...(onSignOut === undefined ? {} : { onSignOut })}
        />
      </div>
    </header>
  );
}
