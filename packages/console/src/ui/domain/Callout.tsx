import type { ReactNode } from "react";
import type { StatusTone } from "../../theme/tokens";
import { IconAlert, IconBlocked, IconCheck, IconCross, IconDot, IconInfo } from "../primitives/icons";
import { toneVariables, TONE_WORDS } from "../primitives/tone";
import "./Callout.css";

/**
 * A bordered block that states a consequence.
 *
 * Its hero use is the one that sets every rule here — spec §3.2 item 3, the
 * "If you approve" block on the approval screen: a bordered callout carrying
 * the concrete effect of a decision in up to four bullets. That is the most
 * consequential paragraph in the product, so this component defaults to the
 * bordered treatment rather than a tint, keeps the title out of the heading
 * outline, and never dresses a consequence up as a notification.
 *
 * **The title is a paragraph, not a heading.** Callouts appear in the middle of
 * a section; slotting an `h3` between an `h2` and its real `h3` corrupts the
 * outline that screen-reader users navigate the page by, and a corrupted
 * outline is worse than a missing one because it looks fine to everyone who
 * cannot see it.
 *
 * **The tone contributes a mark and a word, never a colour on its own.** The
 * mark is visible and differs in shape between tones; the word goes to
 * assistive technology, where a coloured border says nothing at all.
 *
 * **`live` is opt-in and only ever polite.** A callout that was on the page
 * from the start must not be announced — announcing it means a screen-reader
 * user hears the page twice. Assertive is not offered: it interrupts whatever
 * the reader was in the middle of, which is right for "your session expired"
 * and wrong for everything this component is used for.
 */

const MARKS: Readonly<Record<StatusTone, ReactNode>> = {
  success: <IconCheck />,
  warning: <IconAlert />,
  danger: <IconCross />,
  info: <IconInfo />,
  neutral: <IconDot />,
  denied: <IconBlocked />,
};

export interface CalloutProps {
  /** The line that states the consequence. Required — a callout with no claim is a box. */
  readonly title: ReactNode;
  readonly children?: ReactNode;
  readonly tone?: StatusTone;
  /**
   * `outline` is the default and the one the approval screen uses: a strong
   * boundary, no fill. `tinted` adds the tone's surface, for a callout that has
   * to be found in a scroll of dense content.
   */
  readonly emphasis?: "outline" | "tinted";
  /** Controls that belong to the consequence — "Preview the letter", "Change the rule". */
  readonly actions?: ReactNode;
  /** Announced politely when it appears mid-flow. Omit for content present at load. */
  readonly live?: "polite";
  /** Overrides the word the tone contributes to assistive technology. */
  readonly toneLabel?: string;
  /** Drops the actions and keeps the layout. Auditors read callouts; they do not act on them. */
  readonly readOnly?: boolean;
  readonly className?: string;
}

export function Callout({
  title,
  children,
  tone = "info",
  emphasis = "outline",
  actions,
  live,
  toneLabel,
  readOnly = false,
  className,
}: CalloutProps) {
  return (
    <div
      className={className === undefined ? "pv-notice" : `pv-notice ${className}`}
      data-tone={tone}
      data-emphasis={emphasis}
      style={toneVariables(tone)}
      role={live === undefined ? undefined : "status"}
      aria-live={live}
    >
      <span className="pv-notice-mark" aria-hidden="true">
        {MARKS[tone]}
      </span>
      <div className="pv-notice-content">
        <p className="pv-notice-title">
          {/* The tone in words. A screen reader gets nothing at all from the
              border colour, and the mark beside it is aria-hidden. */}
          <span className="pv-sr-only">{toneLabel ?? TONE_WORDS[tone]}: </span>
          {title}
        </p>
        {children === undefined ? null : <div className="pv-notice-body">{children}</div>}
        {actions === undefined || readOnly ? null : (
          <div className="pv-notice-actions">{actions}</div>
        )}
      </div>
    </div>
  );
}
