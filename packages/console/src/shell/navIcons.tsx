import type { ReactNode } from "react";

/**
 * The navigation marks.
 *
 * `ui/primitives/icons.tsx` draws the *status and control* marks — check, alert,
 * cross, chevron, lock. Those are the second channel beside a word and there are
 * a dozen of them. A collapsed rail needs something different: eleven marks that
 * have to be told apart at 64px with no label beside them, which is the hardest
 * job an icon in this console does.
 *
 * They are drawn here, in the same 16-unit box and the same 1.5 stroke, for the
 * reasons the primitive set gives: a glyph font renders differently on every
 * platform, and a stroked path in `currentColor` survives a printed pack. They
 * are separate from that set because they are the shell's vocabulary, not the
 * component library's.
 *
 * Every one is `aria-hidden` without exception. A collapsed rail item carries
 * its name in `aria-label` and in a tooltip; the mark is never the only thing
 * saying what a link is, which is also why the rail is never icon-only by
 * choice on a wide screen.
 */

export interface NavIconProps {
  readonly className?: string;
}

function NavGlyph({ className, children }: NavIconProps & { readonly children: ReactNode }) {
  return (
    <svg
      className={className === undefined ? "pv-nav-icon" : `pv-nav-icon ${className}`}
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

/** The work queue: a list with a marker on the row you are standing on. */
export function IconQueue(props: NavIconProps) {
  return (
    <NavGlyph {...props}>
      <path d="M6.25 4h7" />
      <path d="M6.25 8h7" />
      <path d="M6.25 12h7" />
      <circle cx="3" cy="4" r="1" fill="currentColor" stroke="none" />
      <circle cx="3" cy="8" r="1" fill="currentColor" stroke="none" />
      <circle cx="3" cy="12" r="1" fill="currentColor" stroke="none" />
    </NavGlyph>
  );
}

/** Approvals: a decision recorded against a document. */
export function IconApprovals(props: NavIconProps) {
  return (
    <NavGlyph {...props}>
      <path d="M12.75 7.5V3.25a1 1 0 0 0-1-1h-7.5a1 1 0 0 0-1 1v9.5a1 1 0 0 0 1 1h3.5" />
      <path d="M5.75 5.5h4.5" />
      <path d="M5.75 8h2.5" />
      <path d="M9 12.25 10.75 14l3-3.5" />
    </NavGlyph>
  );
}

/** Audit and evidence: links in a chain. */
export function IconChain(props: NavIconProps) {
  return (
    <NavGlyph {...props}>
      <rect x="1.75" y="5.75" width="6.5" height="4.5" rx="2.25" />
      <rect x="7.75" y="5.75" width="6.5" height="4.5" rx="2.25" />
    </NavGlyph>
  );
}

/** Containment: a shield. What is held back rather than what has failed. */
export function IconShield(props: NavIconProps) {
  return (
    <NavGlyph {...props}>
      <path d="M8 1.75 13.25 3.5v4.25c0 3.1-2.1 5.4-5.25 6.5-3.15-1.1-5.25-3.4-5.25-6.5V3.5z" />
      <path d="M5.75 7.75h4.5" />
    </NavGlyph>
  );
}

/** The executive view: a measurement, over time. */
export function IconChart(props: NavIconProps) {
  return (
    <NavGlyph {...props}>
      <path d="M2.25 13.25h11.5" />
      <path d="M4.5 13.25V9" />
      <path d="M8 13.25V4.75" />
      <path d="M11.5 13.25V7" />
    </NavGlyph>
  );
}

/** Improvements: the loop that comes back better than it left. */
export function IconLoop(props: NavIconProps) {
  return (
    <NavGlyph {...props}>
      <path d="M13.25 8a5.25 5.25 0 1 1-1.9-4.05" />
      <path d="M13.25 1.75v3h-3" />
    </NavGlyph>
  );
}

/** Work discovery: looking for work nobody has written down. */
export function IconSearchGlass(props: NavIconProps) {
  return (
    <NavGlyph {...props}>
      <circle cx="7.25" cy="7.25" r="4.5" />
      <path d="m10.75 10.75 3 3" />
    </NavGlyph>
  );
}

/** Agent roles: a role the platform dispatches to. */
export function IconRole(props: NavIconProps) {
  return (
    <NavGlyph {...props}>
      <circle cx="8" cy="5.25" r="2.75" />
      <path d="M2.75 13.75a5.25 5.25 0 0 1 10.5 0" />
    </NavGlyph>
  );
}

/** External agents: something outside, calling in and being answered. */
export function IconExchange(props: NavIconProps) {
  return (
    <NavGlyph {...props}>
      <path d="M2.75 5.75h9" />
      <path d="M9.5 3.5 11.75 5.75 9.5 8" />
      <path d="M13.25 10.25h-9" />
      <path d="M6.5 8 4.25 10.25 6.5 12.5" />
    </NavGlyph>
  );
}

/** Platform health: a pulse. */
export function IconPulse(props: NavIconProps) {
  return (
    <NavGlyph {...props}>
      <path d="M1.75 8h3l1.75-4 2.5 8 1.75-4h3.5" />
    </NavGlyph>
  );
}

/** Notifications. */
export function IconBell(props: NavIconProps) {
  return (
    <NavGlyph {...props}>
      <path d="M4 6.75a4 4 0 0 1 8 0c0 2.5.75 3.5 1.25 4.25h-10.5C3.25 10.25 4 9.25 4 6.75z" />
      <path d="M6.5 11v.75a1.5 1.5 0 0 0 3 0V11" />
    </NavGlyph>
  );
}

/** The rail's collapse control: a frame with its leading column marked. */
export function IconRailToggle(props: NavIconProps) {
  return (
    <NavGlyph {...props}>
      <rect x="2.25" y="2.75" width="11.5" height="10.5" rx="1.5" />
      <path d="M6.5 2.75v10.5" />
    </NavGlyph>
  );
}

/** The context panel's control: the same frame, marked on the trailing edge. */
export function IconPanelToggle(props: NavIconProps) {
  return (
    <NavGlyph {...props}>
      <rect x="2.25" y="2.75" width="11.5" height="10.5" rx="1.5" />
      <path d="M9.5 2.75v10.5" />
    </NavGlyph>
  );
}

/** The design gallery: the system itself, laid out. */
export function IconSystem(props: NavIconProps) {
  return (
    <NavGlyph {...props}>
      <rect x="2.25" y="2.25" width="5" height="5" rx="1" />
      <rect x="2.25" y="8.75" width="5" height="5" rx="1" />
      <circle cx="11.25" cy="4.75" r="2.5" />
      <circle cx="11.25" cy="11.25" r="2.5" />
    </NavGlyph>
  );
}
