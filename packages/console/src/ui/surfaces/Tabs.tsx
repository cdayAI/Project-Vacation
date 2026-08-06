import { useId, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import { ReadOnlyChip } from "./ReadOnlyChip";
import { SurfaceState } from "./SurfaceState";
import "./Tabs.css";

/**
 * Tabs.
 *
 * The configuration screens depend on these: spec §3.7 makes every
 * configuration surface **Current → Draft → Diff → Impact → Publish**, with the
 * Diff tab mandatory before publish and the Impact tab carrying an evaluation
 * delta. Tabs there are not decoration, they are a gate, and an operator who
 * cannot tell which tab they are on is an operator who publishes the wrong
 * draft.
 *
 * Three decisions:
 *
 * **Activation is manual by default.** Arrow keys move focus; Enter or Space
 * switches. Automatic activation — where arrowing switches panels — is the
 * pattern most tab implementations copy, and it is wrong for panels that fetch:
 * arrowing from Current to Publish fires three requests the operator did not
 * want and lands them somewhere they did not mean to be. Automatic is available
 * for tabs whose panels are already in memory, where it is genuinely nicer.
 *
 * **Selection is never colour alone.** The selected tab gets an accent
 * underline, a heavier weight, and `aria-selected`. Any one of those alone
 * fails somebody: the underline fails nobody, the colour fails a monochrome
 * print, and `aria-selected` fails everyone looking at the screen.
 *
 * **A disabled tab stays reachable.** It is focusable and says why it is
 * disabled, because a tab an operator cannot focus is a tab they cannot find
 * out about. It simply does not activate.
 */

export interface TabDefinition {
  readonly id: string;
  readonly label: string;
  /** A count beside the label — changed files, failing cases. Tabular. */
  readonly count?: number;
  /** What the count counts, for the screen reader: "changes", "cases". */
  readonly countDescription?: string;
  readonly disabled?: boolean;
  /** Why it is disabled. Read by assistive technology; keep it short. */
  readonly disabledReason?: string;
}

export interface TabsProps {
  /** Names the tab list. "Configuration stages", not "Tabs". */
  readonly label: string;
  readonly tabs: readonly TabDefinition[];
  readonly activeId: string;
  readonly onActiveIdChange: (id: string) => void;
  /**
   * `manual` (default) moves focus with the arrows and switches on Enter or
   * Space. `automatic` switches as focus moves — only for panels already in
   * memory.
   */
  readonly activation?: "manual" | "automatic";
  /** The active tab's panel. The caller renders one panel at a time. */
  readonly children?: ReactNode;

  readonly loading?: boolean;
  readonly error?: ReactNode;
  readonly empty?: ReactNode;
  /** Says once, beside the tabs, that this whole surface cannot be changed. */
  readonly readOnly?: boolean;
  readonly className?: string;
}

export function Tabs({
  label,
  tabs,
  activeId,
  onActiveIdChange,
  activation = "manual",
  children,
  loading = false,
  error,
  empty,
  readOnly = false,
  className,
}: TabsProps) {
  const baseId = useId();
  const buttons = useRef(new Map<string, HTMLButtonElement>());
  // Focus roams independently of selection under manual activation, so the
  // roving tabindex has to follow focus rather than the active tab.
  const [focusedId, setFocusedId] = useState<string | null>(null);

  const activeIndex = tabs.findIndex((tab) => tab.id === activeId);
  const tabId = (id: string) => `${baseId}-tab-${id}`;
  const panelId = `${baseId}-panel`;

  // The tab stop is whichever tab focus last touched, or the active one. A
  // tablist with no valid stop would trap Tab, so an unknown activeId falls
  // back to the first tab.
  const rovingId =
    focusedId !== null && tabs.some((tab) => tab.id === focusedId)
      ? focusedId
      : activeIndex >= 0
        ? activeId
        : (tabs[0]?.id ?? "");

  function moveFocus(toIndex: number): void {
    const bounded = ((toIndex % tabs.length) + tabs.length) % tabs.length;
    const target = tabs[bounded];
    if (target === undefined) return;
    setFocusedId(target.id);
    buttons.current.get(target.id)?.focus();
    if (activation === "automatic" && target.disabled !== true) onActiveIdChange(target.id);
  }

  function onKeyDown(event: KeyboardEvent<HTMLButtonElement>, index: number): void {
    switch (event.key) {
      case "ArrowRight":
        moveFocus(index + 1);
        break;
      case "ArrowLeft":
        moveFocus(index - 1);
        break;
      case "Home":
        moveFocus(0);
        break;
      case "End":
        moveFocus(tabs.length - 1);
        break;
      default:
        return;
    }
    event.preventDefault();
  }

  return (
    <div className={className === undefined ? "pv-tabs" : `pv-tabs ${className}`}>
      <div className="pv-tabs-bar">
        <div className="pv-tabs-list" role="tablist" aria-label={label}>
          {tabs.map((tab, index) => {
            const selected = tab.id === activeId;
            const disabled = tab.disabled === true;
            return (
              <button
                key={tab.id}
                type="button"
                role="tab"
                id={tabId(tab.id)}
                className="pv-tab"
                aria-selected={selected}
                aria-controls={selected ? panelId : undefined}
                // aria-disabled rather than the disabled attribute: a disabled
                // tab an operator cannot focus is a tab they cannot find out
                // about, and the reason below is the whole point of reaching it.
                aria-disabled={disabled || undefined}
                tabIndex={tab.id === rovingId ? 0 : -1}
                ref={(element) => {
                  if (element === null) buttons.current.delete(tab.id);
                  else buttons.current.set(tab.id, element);
                }}
                onFocus={() => setFocusedId(tab.id)}
                onClick={() => {
                  if (!disabled) onActiveIdChange(tab.id);
                }}
                onKeyDown={(event) => onKeyDown(event, index)}
              >
                <span className="pv-tab-label">{tab.label}</span>
                {tab.count === undefined ? null : (
                  <span className="pv-tab-count" data-numeric>
                    {tab.count.toLocaleString()}
                    {tab.countDescription === undefined ? null : (
                      <span className="pv-sr-only"> {tab.countDescription}</span>
                    )}
                  </span>
                )}
                {disabled && tab.disabledReason !== undefined ? (
                  <span className="pv-sr-only">, unavailable: {tab.disabledReason}</span>
                ) : null}
                {/* The underline. A pseudo-element would be invisible to a
                    forced-colours mode that drops backgrounds; a real element
                    with a border survives it. */}
                <span className="pv-tab-indicator" aria-hidden="true" />
              </button>
            );
          })}
        </div>
        {readOnly ? (
          // Outside the tablist: a tablist's children must all be tabs, and a
          // chip inside one is an invalid child that a screen reader may skip.
          <div className="pv-tabs-bar-trailing">
            <ReadOnlyChip />
          </div>
        ) : null}
      </div>

      <div
        className="pv-tabs-panel"
        role="tabpanel"
        id={panelId}
        aria-labelledby={activeIndex >= 0 ? tabId(activeId) : undefined}
        // Focusable so a panel with no controls of its own can still be
        // scrolled and read from the keyboard.
        tabIndex={0}
      >
        <SurfaceState loading={loading} error={error} empty={empty}>
          {children}
        </SurfaceState>
      </div>
    </div>
  );
}
