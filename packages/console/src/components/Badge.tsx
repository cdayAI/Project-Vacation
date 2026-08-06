import type { ReactNode } from "react";

/**
 * Tones. "denied" is separate from "danger" on purpose: a refusal is the
 * platform working, and giving it the colour of a failure teaches operators
 * that governance looks like breakage. See tokens.css.
 */
export type Tone = "neutral" | "success" | "warning" | "danger" | "info" | "denied";

export interface BadgeProps {
  readonly tone?: Tone;
  /**
   * A decorative second visual channel, hidden from assistive technology. The
   * badge's text is the meaning; the glyph exists so that the distinction
   * survives being printed in greyscale or read by someone who cannot
   * distinguish the two tints.
   */
  readonly glyph?: string;
  readonly children: ReactNode;
}

export function Badge({ tone = "neutral", glyph, children }: BadgeProps) {
  return (
    <span className={`pv-badge pv-badge-${tone}`}>
      {glyph !== undefined && (
        <span className="pv-badge-glyph" aria-hidden="true">
          {glyph}
        </span>
      )}
      {children}
    </span>
  );
}
