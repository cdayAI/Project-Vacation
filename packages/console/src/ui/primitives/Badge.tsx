import type { ReactNode } from "react";
import type { StatusTone } from "../../theme/tokens";
import { cx } from "./classes";
import { IconAlert, IconBlocked, IconCheck, IconCross, IconDot, IconInfo } from "./icons";
import { toneVariables } from "./tone";
import "./Badge.css";

/**
 * Badge — a status, stated. Never interactive.
 *
 * That is the line between this and Chip, and it is worth holding: a badge is
 * the system telling the operator what something is, a chip is something the
 * operator can do. A screen where the two look alike is a screen where people
 * click things that are not buttons and miss things that are.
 *
 * The words are required and the mark is automatic. A badge whose only content
 * is a colour is unreadable on the printed evidence export, to a monochrome
 * display, and to the roughly one operator in twelve who cannot separate the
 * red from the green — and the export being printed is not hypothetical, it is
 * how a regulator request is answered.
 *
 * `denied` is a tone of its own rather than a shade of `danger`. A refused
 * action is the governance working; painting it the colour of a breach teaches
 * operators to read control as breakage.
 */

const DEFAULT_MARKS: Readonly<Record<StatusTone, ReactNode>> = {
  success: <IconCheck size="sm" />,
  warning: <IconAlert size="sm" />,
  danger: <IconCross size="sm" />,
  info: <IconInfo size="sm" />,
  neutral: <IconDot size="sm" />,
  denied: <IconBlocked size="sm" />,
};

export interface BadgeProps {
  readonly tone?: StatusTone;
  /** Replaces the tone's mark. Decorative — the words carry the meaning. */
  readonly icon?: ReactNode;
  /** `sm` is the uppercase micro badge for a dense row; `md` reads as a chip. */
  readonly size?: "sm" | "md";
  /** `outline` drops the tint where a column of filled badges becomes a stripe. */
  readonly emphasis?: "soft" | "outline";
  /** The words. Required by the type, because a wordless badge is a defect. */
  readonly children: ReactNode;
  readonly className?: string;
}

export function Badge({
  tone = "neutral",
  icon,
  size = "md",
  emphasis = "soft",
  children,
  className,
}: BadgeProps) {
  return (
    <span
      className={cx("pv-ui-badge", className)}
      data-tone={tone}
      data-size={size}
      data-emphasis={emphasis}
      style={toneVariables(tone)}
    >
      <span aria-hidden="true">{icon ?? DEFAULT_MARKS[tone]}</span>
      <span className="pv-ui-badge-label">{children}</span>
    </span>
  );
}
