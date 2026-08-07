import { useId, type ReactNode, type Ref } from "react";
import { GLASS_PRIORITY, useGlassSurface } from "./glassSurface";
import { IDENTITY_ATTRIBUTE } from "./originMotion";
import { ReadOnlyChip } from "./ReadOnlyChip";
import { SurfaceState } from "./SurfaceState";
import "./Card.css";

/**
 * A card.
 *
 * The quiet workhorse: a bounded region with a title, some content, and
 * sometimes an action. It exists mostly so that "a bounded region with a title"
 * is one decision made once rather than fourteen slightly different ones.
 *
 * Three things here are not obvious and are deliberate.
 *
 * **The title is the trigger, not the card.** When a card opens something, the
 * title becomes a button and a pseudo-element stretches its hit area over the
 * whole card. Wrapping the entire card in a `<button>` is the other common
 * approach and it produces an accessible name that reads as the card's whole
 * text — title, three metrics, a timestamp, and a footnote — every time an
 * operator arrows past it. A card whose name is its title is a card a screen
 * reader user can skim.
 *
 * **Glass is opt-in and only for summary cards.** Spec §1.5 puts glass on
 * chrome and overlays; the one card allowed it is the summary card that floats
 * over the shell. A card carrying a table, a form, or a paragraph must not ask
 * for it, and asking spends a lease from the blur budget that a real overlay
 * needs more.
 *
 * **Read-only is a state of the card, not an absence of buttons.** It keeps the
 * layout, drops the affordances, and says so once in the header.
 */

export type CardTone = "default" | "glass";

export interface CardProps {
  readonly ref?: Ref<HTMLElement>;
  /** Omit for a card whose content names itself — a metric tile, a chart. */
  readonly title?: string;
  /**
   * Heading level. Structure, not size: the type step is fixed by the design,
   * and the level comes from where the card sits in the page outline.
   */
  readonly titleLevel?: 2 | 3 | 4;
  /** Small uppercase text above the title. Category, not sentence. */
  readonly eyebrow?: ReactNode;
  /** Rendered in the header, trailing the title. Suppressed when read-only. */
  readonly actions?: ReactNode;
  readonly footer?: ReactNode;
  readonly children?: ReactNode;

  readonly tone?: CardTone;
  /** Draws the card as chosen: accent boundary plus a 2px leading bar. */
  readonly selected?: boolean;

  /**
   * Makes the title a button covering the card. The card must then contain no
   * other interactive content — a second control inside a stretched hit area
   * is unreachable by pointer.
   */
  readonly onActivate?: () => void;
  /** The same, as navigation. Mutually exclusive with `onActivate`. */
  readonly href?: string;
  readonly disabled?: boolean;

  /** Skeleton in place of the body. The caller owns the 300ms delay (spec §7). */
  readonly loading?: boolean;
  /** Replaces the body with a stated failure. Never a bare "Something went wrong". */
  readonly error?: ReactNode;
  /** Replaces the body when there is nothing to show and that is not a failure. */
  readonly empty?: ReactNode;
  readonly readOnly?: boolean;

  /** Ties this card to the panel or sheet it expands into. See originMotion. */
  readonly identity?: string;
  readonly className?: string;
}

export function Card({
  ref,
  title,
  titleLevel = 3,
  eyebrow,
  actions,
  footer,
  children,
  tone = "default",
  selected = false,
  onActivate,
  href,
  disabled = false,
  loading = false,
  error,
  empty,
  readOnly = false,
  identity,
  className,
}: CardProps) {
  const titleId = useId();
  const glass = useGlassSurface({
    priority: GLASS_PRIORITY.chrome,
    wantsBlur: tone === "glass",
  });

  const interactive = !disabled && (onActivate !== undefined || href !== undefined);
  const Heading = `h${titleLevel}` as const;
  // A card that is only a title and a footer should not carry an empty body
  // element: the gap it leaves is a gap nobody chose.
  const hasBody =
    loading ||
    (error !== undefined && error !== null) ||
    (empty !== undefined && empty !== null) ||
    (children !== undefined && children !== null);

  const classes = ["pv-card"];
  if (tone === "glass") classes.push(glass.surfaceClassName, "pv-card-glass");
  if (interactive) classes.push("pv-card-interactive");
  if (selected) classes.push("pv-card-selected");
  if (disabled) classes.push("pv-card-disabled");
  if (className !== undefined) classes.push(className);

  const titleContent =
    title === undefined ? null : (
      <Heading className="pv-card-title" id={titleId} {...{ [IDENTITY_ATTRIBUTE]: identity }}>
        {href !== undefined && !disabled ? (
          <a className="pv-card-trigger" href={href}>
            {title}
          </a>
        ) : onActivate !== undefined && !disabled ? (
          <button type="button" className="pv-card-trigger" onClick={onActivate}>
            {title}
          </button>
        ) : (
          title
        )}
      </Heading>
    );

  const header =
    titleContent === null && eyebrow === undefined && !readOnly && actions === undefined ? null : (
      <div className="pv-card-header">
        <div className="pv-card-heading-group">
          {eyebrow === undefined ? null : <p className="pv-card-eyebrow">{eyebrow}</p>}
          {titleContent}
        </div>
        <div className="pv-card-header-trailing">
          {readOnly ? <ReadOnlyChip /> : null}
          {/* Actions are dropped rather than disabled in the read-only state:
              a row of dimmed buttons is an invitation to keep clicking them. */}
          {readOnly ? null : actions}
        </div>
      </div>
    );

  // `article` rather than `section`: a named `section` is a region landmark, and
  // a dashboard with twelve summary cards would then hold twelve landmarks —
  // which is not navigation, it is noise, and it is the fastest way to make
  // landmark navigation useless on the screens that need it most. An article is
  // still named and still reachable by its own rotor.
  return (
    <article
      ref={ref}
      className={classes.join(" ")}
      aria-labelledby={title === undefined ? undefined : titleId}
      data-disabled={disabled || undefined}
      data-selected={selected || undefined}
      data-read-only={readOnly || undefined}
    >
      {header}
      {hasBody ? (
        <div className="pv-card-body">
          <SurfaceState loading={loading} error={error} empty={empty}>
            {children}
          </SurfaceState>
        </div>
      ) : null}
      {footer === undefined ? null : <div className="pv-card-footer">{footer}</div>}
    </article>
  );
}
