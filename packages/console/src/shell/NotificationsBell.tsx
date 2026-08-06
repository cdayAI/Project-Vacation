import { useId, useRef, useState } from "react";
import type { StatusTone } from "../theme/tokens";
import { Badge } from "../ui/primitives/Badge";
import { Button } from "../ui/primitives/Button";
import { Popover, popoverTriggerProps } from "../ui/surfaces/Popover";
import { IconBell } from "./navIcons";
import "./NotificationsBell.css";

/**
 * The bell.
 *
 * A count on a bell is a promise that something is waiting, so two rules apply
 * and both are here rather than left to a caller:
 *
 *   **The number is never the whole message.** The button's accessible name
 *   spells it out — "Notifications, 3 unread" — because a badge is a visual
 *   affordance and a screen-reader user hears the name. A bare "3" beside a
 *   glyph tells them nothing.
 *
 *   **Zero is not a badge.** An empty badge, a dash, or a grey nought all read
 *   as "something is here" at a glance. Nothing unread means no badge, and the
 *   panel says so in words.
 *
 * The list itself is data the console does not yet have a contract for. Rather
 * than invent one, this takes the notifications it is given and draws its empty
 * state honestly when there are none — which is also the state it will be in on
 * a healthy morning, so it is a state worth designing rather than a placeholder.
 */

export interface ShellNotification {
  readonly id: string;
  /** What happened, in one line. "Approval 4182 has been waiting two hours." */
  readonly title: string;
  /** What it means or what to do. Optional; never a restatement of the title. */
  readonly detail?: string;
  /** Already formatted for reading — "2h ago", "09:41". The shell does not parse. */
  readonly when: string;
  readonly href?: string;
  readonly unread: boolean;
  /** Paired with the tone's own word in the badge. Never colour alone. */
  readonly tone?: StatusTone;
  /** The word beside the tone. Required whenever a tone is set. */
  readonly toneWord?: string;
}

export interface NotificationsBellProps {
  readonly notifications?: readonly ShellNotification[];
  readonly onOpenNotification?: (notification: ShellNotification) => void;
}

export function NotificationsBell({
  notifications = [],
  onOpenNotification,
}: NotificationsBellProps) {
  const [open, setOpen] = useState(false);
  const anchorRef = useRef<HTMLButtonElement | null>(null);
  const surfaceId = useId();

  const unread = notifications.filter((notification) => notification.unread).length;
  const name =
    unread === 0
      ? "Notifications, nothing unread"
      : `Notifications, ${unread} unread`;

  return (
    <>
      <button
        ref={anchorRef}
        type="button"
        className="pv-bell"
        aria-label={name}
        {...popoverTriggerProps(surfaceId, open)}
        onClick={() => setOpen((current) => !current)}
      >
        <IconBell />
        {unread > 0 ? (
          // Decorative: the button's accessible name already carries the
          // count, and announcing it twice is how a bell becomes noise.
          <span className="pv-bell-count" aria-hidden="true" data-numeric>
            {unread > 9 ? "9+" : unread}
          </span>
        ) : null}
      </button>

      <Popover
        open={open}
        onClose={() => setOpen(false)}
        anchorRef={anchorRef}
        id={surfaceId}
        title="Notifications"
        placement="bottom-end"
        empty={
          notifications.length === 0 ? (
            <div className="pv-bell-empty">
              <p className="pv-bell-empty-title">Nothing new.</p>
              <p>
                Approvals that have been waiting, failed runs, and anything that breaches a limit
                appear here. A digest of the day lands at 9:00 each morning.
              </p>
            </div>
          ) : undefined
        }
      >
        {notifications.length === 0 ? null : (
          <ul className="pv-bell-list">
            {notifications.map((notification) => (
              <li className="pv-bell-item" key={notification.id} data-unread={notification.unread}>
                <div className="pv-bell-item-head">
                  {notification.unread ? (
                    // The word, not just the dot: the dot is a tint and the
                    // console is read in greyscale on a printed handover.
                    <span className="pv-bell-unread">
                      <span className="pv-bell-unread-mark" aria-hidden="true" />
                      Unread
                    </span>
                  ) : null}
                  {notification.tone !== undefined && notification.toneWord !== undefined ? (
                    <Badge tone={notification.tone} size="sm">
                      {notification.toneWord}
                    </Badge>
                  ) : null}
                  <span className="pv-bell-when">{notification.when}</span>
                </div>
                <p className="pv-bell-title">{notification.title}</p>
                {notification.detail === undefined ? null : (
                  <p className="pv-bell-detail">{notification.detail}</p>
                )}
                {notification.href === undefined && onOpenNotification === undefined ? null : (
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => {
                      setOpen(false);
                      onOpenNotification?.(notification);
                    }}
                  >
                    Open
                  </Button>
                )}
              </li>
            ))}
          </ul>
        )}
      </Popover>
    </>
  );
}
