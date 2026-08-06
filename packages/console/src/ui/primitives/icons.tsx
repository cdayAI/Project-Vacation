import type { ReactNode } from "react";
import { cx } from "./classes";
import "./icons.css";

/**
 * The primitive icon set.
 *
 * Drawn here rather than pulled from a font or an icon package for two reasons
 * that both matter to this product. A glyph font renders differently on every
 * platform and a status mark that becomes a box on one operator's machine takes
 * the *second* channel away from a status — the one the specification requires
 * so that colour is never alone. And an audit pack is printed: these are stroked
 * paths in `currentColor`, so they survive greyscale at any size.
 *
 * Every icon is `aria-hidden` and `focusable="false"` without exception. An icon
 * in this system is always the second channel beside a word, never the only
 * carrier of meaning, so it has nothing to contribute to the accessibility tree
 * and `focusable="false"` keeps older engines from putting an SVG in the tab
 * order. A caller that genuinely needs a labelled graphic wraps one in an
 * element carrying the label.
 */

export interface IconProps {
  /** `md` is 16px and `sm` is 12px — both on the spacing scale. */
  readonly size?: "sm" | "md";
  readonly className?: string;
}

function Glyph({
  size = "md",
  className,
  children,
}: IconProps & { readonly children: ReactNode }) {
  return (
    <svg
      className={cx("pv-ui-icon", size === "sm" && "pv-ui-icon-sm", className)}
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.5}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      {children}
    </svg>
  );
}

/** Success, and the selected mark inside a checkbox. */
export function IconCheck(props: IconProps) {
  return (
    <Glyph {...props}>
      <path d="M3.25 8.5 6.5 11.75 12.75 4.75" />
    </Glyph>
  );
}

/** Warning — approaching a limit or a deadline. */
export function IconAlert(props: IconProps) {
  return (
    <Glyph {...props}>
      <path d="M8 2.25 14.5 13.5H1.5z" />
      <path d="M8 6.5v3" />
      <path d="M8 11.75h.008" />
    </Glyph>
  );
}

/** Danger — breached, failed, blocked. Also the dismiss mark on a chip. */
export function IconCross(props: IconProps) {
  return (
    <Glyph {...props}>
      <path d="M4 4l8 8" />
      <path d="M12 4l-8 8" />
    </Glyph>
  );
}

/** Info — in progress, informational. */
export function IconInfo(props: IconProps) {
  return (
    <Glyph {...props}>
      <circle cx="8" cy="8" r="6" />
      <path d="M8 7.5v4" />
      <path d="M8 4.75h.008" />
    </Glyph>
  );
}

/** Neutral — inert, archived, not applicable. */
export function IconDot(props: IconProps) {
  return (
    <Glyph {...props}>
      <circle cx="8" cy="8" r="3" fill="currentColor" />
    </Glyph>
  );
}

/**
 * Denied. A refusal is the governance working, so it gets its own mark rather
 * than borrowing the failure cross.
 */
export function IconBlocked(props: IconProps) {
  return (
    <Glyph {...props}>
      <circle cx="8" cy="8" r="6" />
      <path d="M3.75 12.25 12.25 3.75" />
    </Glyph>
  );
}

/** The disclosure mark on a select trigger and a date field. */
export function IconChevronDown(props: IconProps) {
  return (
    <Glyph {...props}>
      <path d="M4 6.25 8 10.25l4-4" />
    </Glyph>
  );
}

export function IconChevronLeft(props: IconProps) {
  return (
    <Glyph {...props}>
      <path d="M9.75 3.75 5.5 8l4.25 4.25" />
    </Glyph>
  );
}

export function IconChevronRight(props: IconProps) {
  return (
    <Glyph {...props}>
      <path d="M6.25 3.75 10.5 8l-4.25 4.25" />
    </Glyph>
  );
}

export function IconCalendar(props: IconProps) {
  return (
    <Glyph {...props}>
      <rect x="2.25" y="3.25" width="11.5" height="10.5" rx="1.5" />
      <path d="M2.25 6.5h11.5" />
      <path d="M5.5 1.75v2.5" />
      <path d="M10.5 1.75v2.5" />
    </Glyph>
  );
}

/** The read-only marker. Read-only is a designed state, not a broken one. */
export function IconLock(props: IconProps) {
  return (
    <Glyph {...props}>
      <rect x="3.25" y="7" width="9.5" height="6.75" rx="1.5" />
      <path d="M5.75 7V5.25a2.25 2.25 0 0 1 4.5 0V7" />
    </Glyph>
  );
}

/** The empty half of a radio, and the selected half when filled by CSS. */
export function IconCircle(props: IconProps) {
  return (
    <Glyph {...props}>
      <circle cx="8" cy="8" r="5.5" />
    </Glyph>
  );
}

/** Not selected, and the indeterminate mark inside a checkbox. */
export function IconDash(props: IconProps) {
  return (
    <Glyph {...props}>
      <path d="M4 8h8" />
    </Glyph>
  );
}
