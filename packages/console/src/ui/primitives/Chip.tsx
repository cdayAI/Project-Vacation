import type { ReactNode } from "react";
import type { StatusTone } from "../../theme/tokens";
import { cx } from "./classes";
import { IconCheck, IconCross } from "./icons";
import { toneVariables } from "./tone";
import "./Chip.css";

/**
 * Chip — a dense label, a filter toggle, or a removable token.
 *
 * Three shapes from one component because they share every visual decision and
 * differ only in what the operator can do to them:
 *
 *   static      no handlers            → a `<span>`
 *   toggle      `onSelect`             → a `<button aria-pressed>`
 *   removable   `onRemove`             → a span holding a small remove button
 *
 * A toggle chip is a button with `aria-pressed` rather than a checkbox with a
 * styled box: it is a filter, its label already says what it filters, and
 * `aria-pressed` is announced by every screen reader without any scripting.
 * Selection is carried by a check mark as well as by the fill, because a
 * saved-view pill whose only "on" signal is a tint is invisible in greyscale
 * and to a monochromat.
 */

export interface ChipProps {
  readonly children: ReactNode;
  /** Tints the chip to a status tone. Always paired with the chip's own words. */
  readonly tone?: StatusTone;
  /** A leading glyph. Decorative — the chip's text carries the meaning. */
  readonly icon?: ReactNode;
  /** `sm` is a metadata chip at 20px; `md` is the default and meets 24×24. */
  readonly size?: "sm" | "md";
  /** Present only on a toggle chip. `aria-pressed` follows it. */
  readonly selected?: boolean;
  readonly onSelect?: () => void;
  readonly onRemove?: () => void;
  /**
   * The remove button's accessible name. Defaults to `Remove <label>`, which
   * needs `label` when the children are not a plain string — an unnamed icon
   * button is the most common accessibility defect in a token list.
   */
  readonly removeLabel?: string;
  /** A count rendered after the label, in tabular figures. */
  readonly count?: number;
  readonly disabled?: boolean;
  /** Used for the default remove label when the children are not a string. */
  readonly label?: string;
  readonly className?: string;
}

export function Chip({
  children,
  tone,
  icon,
  size = "md",
  selected,
  onSelect,
  onRemove,
  removeLabel,
  count,
  disabled = false,
  label,
  className,
}: ChipProps) {
  const interactive = onSelect !== undefined || onRemove !== undefined;
  const text = label ?? (typeof children === "string" ? children : undefined);

  const body = (
    <>
      {selected === true && <IconCheck className="pv-ui-chip-check" size="sm" />}
      {icon !== undefined && (
        <span className="pv-ui-chip-icon" aria-hidden="true">
          {icon}
        </span>
      )}
      <span className="pv-ui-chip-label">{children}</span>
      {count !== undefined && <span className="pv-ui-chip-count">{count.toLocaleString()}</span>}
    </>
  );

  const shell = (inner: ReactNode) => (
    <span
      className={cx("pv-ui-chip", className)}
      data-size={size}
      data-toned={tone !== undefined ? "true" : undefined}
      data-interactive={interactive ? "true" : undefined}
      data-selected={selected === true ? "true" : undefined}
      data-disabled={disabled ? "true" : undefined}
      style={tone !== undefined ? toneVariables(tone) : undefined}
    >
      {inner}
    </span>
  );

  if (onSelect !== undefined) {
    return shell(
      <>
        <button
          type="button"
          className="pv-ui-chip-toggle"
          aria-pressed={selected === true}
          disabled={disabled}
          onClick={onSelect}
        >
          {body}
        </button>
        {onRemove !== undefined && (
          <RemoveButton
            disabled={disabled}
            onRemove={onRemove}
            name={removeLabel ?? (text !== undefined ? `Remove ${text}` : "Remove")}
          />
        )}
      </>,
    );
  }

  if (onRemove !== undefined) {
    return shell(
      <>
        {body}
        <RemoveButton
          disabled={disabled}
          onRemove={onRemove}
          name={removeLabel ?? (text !== undefined ? `Remove ${text}` : "Remove")}
        />
      </>,
    );
  }

  return shell(body);
}

function RemoveButton({
  disabled,
  onRemove,
  name,
}: {
  readonly disabled: boolean;
  readonly onRemove: () => void;
  readonly name: string;
}) {
  return (
    <button
      type="button"
      className="pv-ui-chip-remove"
      aria-label={name}
      disabled={disabled}
      onClick={onRemove}
    >
      <IconCross size="sm" />
    </button>
  );
}
