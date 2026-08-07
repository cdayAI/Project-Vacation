import { useEffect, useRef, type ReactNode } from "react";
import { Panel } from "../ui/surfaces/Panel";
import { Sheet } from "../ui/surfaces/Sheet";
import { tabbableWithin } from "../ui/surfaces/focusScope";
import { PANEL_WIDTH_MAX, PANEL_WIDTH_MIN, type PanelMode } from "./layout";
import { IconPanelToggle } from "./navIcons";
import "./ContextPanel.css";

/**
 * The right-hand context panel — 380px of glass, and where the copilot lives.
 *
 * Specification §2 gives it four properties and every one of them is load
 * bearing: it is collapsible, it is resizable between 320 and 520, its state
 * persists **per route**, and below 900px it becomes an overlay sheet rather
 * than a column.
 *
 * The per-route memory is the one that is easy to miss and the one operators
 * feel. On an approval the panel holds the record being decided and stays open;
 * on the executive view it is a third of the screen taken from a chart. A single
 * remembered width loses that argument on one of the two screens every time.
 * The state lives with the shell, which owns storage; this component is
 * controlled and draws what it is told.
 *
 * The overlay below 900 is a genuinely different component — `Sheet`, with its
 * focus trap and its scrim — rather than the same panel restyled. A 320px column
 * on a 600px window leaves 280px of content, which is not a narrow layout, it is
 * a broken one.
 */

export interface ContextPanelProps {
  /** What the panel is showing, as a heading. "Case 41823", not "Context". */
  readonly title: string;
  readonly description?: ReactNode;
  readonly mode: PanelMode;
  readonly collapsed: boolean;
  readonly width: number;
  readonly onCollapsedChange: (collapsed: boolean) => void;
  readonly onWidthChange: (width: number) => void;
  /** Called when a drag or a keypress finishes. Where persistence belongs. */
  readonly onWidthCommit: (width: number) => void;
  readonly readOnly?: boolean;
  readonly loading?: boolean;
  readonly error?: ReactNode;
  /**
   * Changing this number moves focus into the panel's body. This is what `C`
   * does (spec §5), and it is a signal rather than a callback so the shell can
   * raise it from a keyboard verb, a palette command, or a button without three
   * code paths.
   */
  readonly focusSignal?: number;
  readonly children?: ReactNode;
}

/** Shown when a route has given the panel nothing. A designed state, not a gap. */
function EmptyContext() {
  return (
    <div className="pv-context-empty">
      <p className="pv-context-empty-title">Nothing is selected.</p>
      <p>
        Choose a row and its record appears here. The copilot answers from whatever this panel can
        see, so it always knows where you are.
      </p>
    </div>
  );
}

export function ContextPanel({
  title,
  description,
  mode,
  collapsed,
  width,
  onCollapsedChange,
  onWidthChange,
  onWidthCommit,
  readOnly = false,
  loading = false,
  error,
  focusSignal = 0,
  children,
}: ContextPanelProps) {
  const bodyRef = useRef<HTMLDivElement | null>(null);
  const handledSignal = useRef(focusSignal);

  /**
   * `C` lands on the first control *inside the body* — which on every route
   * that has a copilot is the composer — and never on the panel's own collapse
   * button, which is the first tabbable element of the panel as a whole. A
   * "focus the copilot" verb that lands on "collapse the panel" is worse than
   * one that does nothing, because the next keystroke closes the panel.
   */
  useEffect(() => {
    if (focusSignal === handledSignal.current) return;
    handledSignal.current = focusSignal;
    if (collapsed) return;

    const body = bodyRef.current;
    if (body === null) return;
    const [first] = tabbableWithin(body);
    if (first !== undefined) first.focus();
    else body.focus();
  }, [focusSignal, collapsed]);

  // tabIndex -1 so the fallback above can land here and a screen reader reads
  // the panel's contents from the top. Not a tab stop.
  const body = (
    <div className="pv-context-body" ref={bodyRef} tabIndex={-1}>
      {children ?? <EmptyContext />}
    </div>
  );

  return (
    <div
      className="pv-context-slot"
      // The region the top bar's toggle names with `aria-controls`. Rendered in
      // every mode — including while the overlay sheet is closed and there is
      // nothing inside it — because an `aria-controls` pointing at an id that
      // is not in the document is a broken reference.
      id="context-panel"
      data-mode={mode}
      data-collapsed={collapsed ? "true" : undefined}
    >
      {mode !== "overlay" && collapsed ? (
        // Collapsed is a designed state, not an absence. A 48px strip with one
        // control keeps the way back where the panel was, rather than making
        // the operator remember that the only way back is in the top bar.
        <div className="pv-context-strip">
          <button
            type="button"
            className="pv-context-expand"
            aria-label="Show the context panel"
            onClick={() => onCollapsedChange(false)}
          >
            <IconPanelToggle />
          </button>
        </div>
      ) : mode === "overlay" ? (
        <Sheet
          open={!collapsed}
          onClose={() => onCollapsedChange(true)}
          title={title}
          {...(description === undefined ? {} : { description })}
          size="md"
          readOnly={readOnly}
          loading={loading}
          {...(error === undefined ? {} : { error })}
        >
          {body}
        </Sheet>
      ) : (
        <Panel
          title={title}
          {...(description === undefined ? {} : { description })}
          glass
          collapsible
          collapsed={collapsed}
          onCollapsedChange={onCollapsedChange}
          readOnly={readOnly}
          loading={loading}
          {...(error === undefined ? {} : { error })}
          className="pv-context-panel"
          resize={{
            label: "Context panel width",
            width,
            min: PANEL_WIDTH_MIN,
            max: PANEL_WIDTH_MAX,
            edge: "inline-start",
            onWidthChange,
            onWidthCommit,
          }}
        >
          {body}
        </Panel>
      )}
    </div>
  );
}
