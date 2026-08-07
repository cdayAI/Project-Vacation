import type { CSSProperties } from "react";
import {
  statusBorderToken,
  statusSurfaceToken,
  statusToken,
  type StatusTone,
} from "../../theme/tokens";

/**
 * Binds one status tone to three local custom properties.
 *
 * The alternative is six near-identical selector blocks in every component that
 * has tones, which is six places to forget a tone when one is added. Setting the
 * variables on the element instead means the stylesheet says `var(--pv-tone-text)`
 * once and the tone becomes data — and because they are still token references
 * rather than resolved colours, the theme swap and the reduced-transparency
 * swap keep working untouched.
 *
 * The cast is unavoidable: React's CSSProperties has no index signature for
 * custom properties, though the DOM has accepted them for years.
 */
export function toneVariables(tone: StatusTone): CSSProperties {
  return {
    "--pv-tone-text": `var(${statusToken(tone)})`,
    "--pv-tone-surface": `var(${statusSurfaceToken(tone)})`,
    "--pv-tone-border": `var(${statusBorderToken(tone)})`,
  } as CSSProperties;
}

/**
 * The word that goes beside a tone when the caller has not written one.
 *
 * Exported because more than one component needs the same vocabulary, and
 * because a status whose only label is its colour is the defect this table
 * exists to prevent.
 */
export const TONE_WORDS: Readonly<Record<StatusTone, string>> = {
  success: "Success",
  warning: "Warning",
  danger: "Error",
  info: "Information",
  neutral: "Note",
  denied: "Denied",
};
