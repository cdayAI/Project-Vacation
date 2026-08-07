import { useId, useState, type CSSProperties, type ReactNode, type Ref } from "react";
import { IconChevronDown } from "../primitives/icons";
import { GLASS_PRIORITY, useGlassSurface } from "./glassSurface";
import { IDENTITY_ATTRIBUTE } from "./originMotion";
import { ReadOnlyChip } from "./ReadOnlyChip";
import { ResizeSeparator } from "./ResizeSeparator";
import { SurfaceState } from "./SurfaceState";
import "./Panel.css";

/**
 * A panel: a titled region that is part of the furniture rather than part of
 * the content.
 *
 * The console's right-hand context panel is one (glass, resizable, collapsible,
 * holding the copilot and the record). So is every collapsible section inside a
 * detail view. They are the same component because they have the same
 * obligations — a stable heading, a collapse that a keyboard can reach and a
 * screen reader can understand, and a width the operator can change and keep.
 *
 * Two decisions worth stating:
 *
 * **Collapsing hides, it does not unmount.** A collapsed panel keeps its
 * subtree with the `hidden` attribute, so expanding it does not refetch, does
 * not lose scroll position, and does not restart whatever the copilot was
 * saying. `hidden` is also what takes its controls out of the tab order, which
 * a `max-height: 0` collapse notoriously does not.
 *
 * **Width is the caller's state.** A panel that remembered its own width would
 * let the persisted width and the rendered width disagree, and the disagreement
 * shows up as a panel that snaps back after a reload.
 */

export interface PanelResize {
  /** Names what is being resized, for the separator's accessible name. */
  readonly label: string;
  readonly width: number;
  readonly min: number;
  readonly max: number;
  /** Which edge the handle sits on. The context panel's is `inline-start`. */
  readonly edge?: "inline-start" | "inline-end";
  readonly onWidthChange: (width: number) => void;
  /** Called when a drag or keypress finishes. Where persistence belongs. */
  readonly onWidthCommit?: (width: number) => void;
}

export interface PanelProps {
  readonly ref?: Ref<HTMLElement>;
  readonly title: string;
  readonly titleLevel?: 2 | 3 | 4;
  /** One line under the title. Context, not instructions. */
  readonly description?: ReactNode;
  readonly actions?: ReactNode;
  readonly footer?: ReactNode;
  readonly children: ReactNode;

  /** Glass. For the shell's context panel; not for a panel holding a table. */
  readonly glass?: boolean;

  readonly collapsible?: boolean;
  /** Controlled collapse. Omit for a panel that manages its own. */
  readonly collapsed?: boolean;
  readonly defaultCollapsed?: boolean;
  readonly onCollapsedChange?: (collapsed: boolean) => void;

  readonly resize?: PanelResize;

  readonly loading?: boolean;
  readonly error?: ReactNode;
  readonly empty?: ReactNode;
  readonly readOnly?: boolean;

  /** Ties this panel to the card it expanded from. See originMotion. */
  readonly identity?: string;
  readonly className?: string;
}

export function Panel({
  ref,
  title,
  titleLevel = 2,
  description,
  actions,
  footer,
  children,
  glass = false,
  collapsible = false,
  collapsed,
  defaultCollapsed = false,
  onCollapsedChange,
  resize,
  loading = false,
  error,
  empty,
  readOnly = false,
  identity,
  className,
}: PanelProps) {
  const titleId = useId();
  const bodyId = useId();
  const [uncontrolledCollapsed, setUncontrolledCollapsed] = useState(defaultCollapsed);
  const surface = useGlassSurface({ priority: GLASS_PRIORITY.chrome, wantsBlur: glass });

  const isCollapsed = collapsible && (collapsed ?? uncontrolledCollapsed);

  function toggle(): void {
    const next = !isCollapsed;
    if (collapsed === undefined) setUncontrolledCollapsed(next);
    onCollapsedChange?.(next);
  }

  const Heading = `h${titleLevel}` as const;

  const classes = ["pv-panel"];
  if (glass) classes.push(surface.surfaceClassName, "pv-panel-glass");
  if (isCollapsed) classes.push("pv-panel-collapsed");
  if (resize !== undefined) classes.push("pv-panel-resizable");
  if (className !== undefined) classes.push(className);

  // A width in pixels is a measurement, not a design value: it comes from the
  // operator's drag and goes back to storage unchanged.
  const style: CSSProperties | undefined =
    resize === undefined ? undefined : { inlineSize: `${resize.width}px` };

  return (
    <section
      ref={ref}
      className={classes.join(" ")}
      style={style}
      aria-labelledby={titleId}
      data-read-only={readOnly || undefined}
    >
      {resize === undefined ? null : (
        <ResizeSeparator
          label={resize.label}
          value={resize.width}
          min={resize.min}
          max={resize.max}
          // Dragging toward the middle of the screen widens a trailing panel,
          // so the arrow keys have to agree with the drag.
          direction={resize.edge === "inline-start" ? -1 : 1}
          onChange={resize.onWidthChange}
          onCommit={resize.onWidthCommit}
          className={
            resize.edge === "inline-start" ? "pv-panel-resize-leading" : "pv-panel-resize-trailing"
          }
        />
      )}

      <div className={glass ? `pv-panel-header ${surface.scrimClassName}` : "pv-panel-header"}>
        <div className="pv-panel-heading-group">
          <Heading className="pv-panel-title" id={titleId} {...{ [IDENTITY_ATTRIBUTE]: identity }}>
            {collapsible ? (
              <button
                type="button"
                className="pv-panel-collapse"
                aria-expanded={!isCollapsed}
                aria-controls={bodyId}
                onClick={toggle}
              >
                <IconChevronDown className="pv-panel-collapse-mark" size="sm" />
                {title}
              </button>
            ) : (
              title
            )}
          </Heading>
          {description === undefined ? null : (
            <p className="pv-panel-description">{description}</p>
          )}
        </div>
        <div className="pv-panel-header-trailing">
          {readOnly ? <ReadOnlyChip /> : null}
          {readOnly ? null : actions}
        </div>
      </div>

      {/* Hidden rather than unmounted: expanding must not refetch, must not
          lose scroll position, and must not restart the copilot. `hidden` is
          also what removes the contents from the tab order. */}
      <div
        id={bodyId}
        className={glass ? `pv-panel-body ${surface.scrimClassName}` : "pv-panel-body"}
        hidden={isCollapsed}
      >
        <SurfaceState loading={loading} error={error} empty={empty}>
          {children}
        </SurfaceState>
      </div>

      {footer === undefined || isCollapsed ? null : (
        <div className={glass ? `pv-panel-footer ${surface.scrimClassName}` : "pv-panel-footer"}>
          {footer}
        </div>
      )}
    </section>
  );
}
