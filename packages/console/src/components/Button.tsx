import type { ButtonHTMLAttributes, ReactNode } from "react";

export type ButtonVariant = "primary" | "secondary" | "danger" | "quiet";

export interface ButtonProps
  extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, "className" | "type"> {
  readonly variant?: ButtonVariant;
  readonly type?: "button" | "submit" | "reset";
  /**
   * Marks the control unavailable without removing it from the tab order.
   *
   * `disabled` takes a control out of the tab order entirely, so a keyboard or
   * screen-reader user finds a missing button rather than an explained one.
   * `aria-disabled` keeps it reachable and announced as unavailable; pair it
   * with `describedBy` pointing at the sentence that says why. The handler
   * refuses regardless — this is a presentation decision, and the server
   * re-checks the action either way.
   */
  readonly unavailable?: boolean;
  readonly describedBy?: string;
  readonly children: ReactNode;
}

export function Button({
  variant = "secondary",
  type = "button",
  unavailable = false,
  describedBy,
  children,
  onClick,
  ...rest
}: ButtonProps) {
  return (
    <button
      {...rest}
      type={type}
      className={`pv-button pv-button-${variant}`}
      aria-disabled={unavailable ? true : undefined}
      aria-describedby={describedBy}
      onClick={(event) => {
        if (unavailable) {
          event.preventDefault();
          return;
        }
        onClick?.(event);
      }}
    >
      {children}
    </button>
  );
}
