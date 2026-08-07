import type { ComponentPropsWithRef, MouseEvent, ReactNode } from "react";
import { cx } from "./classes";
import { Spinner } from "./Spinner";
import "./Button.css";

/**
 * Button — primary, secondary, ghost, danger, at 28 / 32 / 40px.
 *
 * Three behaviours here exist because of specific failures:
 *
 * **Loading keeps its width.** The label stays in the box at zero opacity and
 * the spinner is drawn over it. An approval bar that reflows the instant
 * someone presses Approve moves Reject under their cursor, and the operator is
 * six items into a queue of forty.
 *
 * **Loading does not disable.** `disabled` removes a control from the tab
 * order, and the browser then drops focus to `<body>`. Pressing Enter on
 * Approve would cost a keyboard operator their place in the page. Instead the
 * button stays focusable, announces itself busy and unavailable, and refuses
 * the second click — which is the actual requirement, since the failure being
 * prevented is a double submission.
 *
 * **`unavailable` is not `disabled`.** A natively disabled control is invisible
 * to a screen reader walking the page, so an operator finds a missing button
 * rather than an explained one. `unavailable` keeps it reachable and announced,
 * and takes a `describedBy` pointing at the sentence that says why. Use
 * `disabled` when the reason is obvious from context, `unavailable` when the
 * operator will otherwise ask "where is the approve button".
 */

export type ButtonVariant = "primary" | "secondary" | "ghost" | "danger";

/** 28 / 32 / 40px, per spec §4. */
export type ButtonSize = "sm" | "md" | "lg";

type NativeButtonProps = Omit<
  ComponentPropsWithRef<"button">,
  "className" | "type" | "aria-disabled" | "aria-busy"
>;

interface ButtonCommonProps extends NativeButtonProps {
  readonly variant?: ButtonVariant;
  readonly size?: ButtonSize;
  /** Explicit because an unset `type` inside a form submits it by accident. */
  readonly type?: "button" | "submit" | "reset";
  /** Draws the spinner, refuses further clicks, keeps the width and the focus. */
  readonly loading?: boolean;
  /** Reachable, announced unavailable. Pair with `describedBy`. */
  readonly unavailable?: boolean;
  /** The id of the sentence explaining why the button is unavailable. */
  readonly describedBy?: string;
  readonly fullWidth?: boolean;
  readonly className?: string;
}

interface LabelledButtonProps extends ButtonCommonProps {
  readonly iconOnly?: false;
  readonly children: ReactNode;
}

interface IconButtonProps extends ButtonCommonProps {
  readonly iconOnly: true;
  /**
   * The accessible name. Required by the type rather than by a convention,
   * because an icon button with no name is the single most common accessibility
   * defect in an operator console and a comment does not prevent it.
   */
  readonly label: string;
  readonly children: ReactNode;
}

export type ButtonProps = LabelledButtonProps | IconButtonProps;

export function Button(props: ButtonProps) {
  const {
    variant = "secondary",
    size = "md",
    type = "button",
    loading = false,
    unavailable = false,
    describedBy,
    fullWidth = false,
    className,
    disabled = false,
    children,
    onClick,
    // Pulled out of `rest` rather than left in it: both are this component's
    // own props, and React warns loudly when an unknown attribute reaches a DOM
    // element — which is the warning that means a typo silently became markup.
    iconOnly: iconOnlyProp,
    label: labelProp,
    "aria-describedby": ariaDescribedBy,
    ...rest
  } = props as ButtonCommonProps & {
    readonly iconOnly?: boolean;
    readonly label?: string;
    readonly children: ReactNode;
  };

  const iconOnly = iconOnlyProp === true;
  const label = iconOnly ? labelProp : undefined;

  // Everything that makes the button refuse a click, in one flag. Kept separate
  // from `disabled` so the styling covers all three cases and the behaviour
  // does not have to be re-derived at every branch below.
  const inert = disabled || unavailable || loading;

  // Merged rather than overwritten. A wrapper — a Tooltip, a form-level error
  // summary — adds its own `aria-describedby` from outside; writing this
  // component's own value over it would silently drop the wrapper's, and the
  // symptom is a description that exists in the DOM and is never announced.
  const described = [describedBy, ariaDescribedBy]
    .filter((part): part is string => typeof part === "string" && part.length > 0)
    .join(" ");

  return (
    <button
      {...rest}
      type={type}
      className={cx("pv-ui-button", className)}
      data-variant={variant}
      data-size={size}
      data-loading={loading ? "true" : undefined}
      data-inert={inert ? "true" : undefined}
      data-icon-only={iconOnly ? "true" : undefined}
      data-full-width={fullWidth ? "true" : undefined}
      disabled={disabled}
      aria-disabled={unavailable || loading ? true : undefined}
      aria-busy={loading ? true : undefined}
      aria-label={label}
      aria-describedby={described.length > 0 ? described : undefined}
      onClick={(event: MouseEvent<HTMLButtonElement>) => {
        if (inert) {
          // preventDefault matters on a submit button: without it the form
          // still submits, which is the double submission this is here to stop.
          event.preventDefault();
          return;
        }
        onClick?.(event);
      }}
    >
      <span className="pv-ui-button-content">{children}</span>
      {loading && (
        <span className="pv-ui-button-spinner">
          {/* Decorative: `aria-busy` on the button already carries the state,
              and a status region in here would append "Loading" to the
              button's accessible name on every render. */}
          <Spinner size={size === "lg" ? "md" : "sm"} decorative />
        </span>
      )}
    </button>
  );
}
