/**
 * Display formatting.
 *
 * Every timestamp on the wire is an ISO-8601 UTC string (api/contract.ts). It
 * is formatted here, in the viewer's own locale and timezone, and always
 * alongside a machine-readable `<time dateTime>` so the exact instant is
 * recoverable from the markup.
 *
 * Absent values render as a short sentence rather than a dash. "—" is read
 * aloud as nothing at all by some screen readers and as "em dash" by others,
 * and neither tells an operator that the platform has no value for the field.
 */

export const NOT_RECORDED = "Not recorded";

export function formatUsd(amount: number): string {
  if (!Number.isFinite(amount)) return NOT_RECORDED;
  // Model spend is often fractions of a cent. Rounding it to two places turns
  // a real number into $0.00, which reads as "free" rather than "very cheap".
  const fractionDigits = amount !== 0 && Math.abs(amount) < 0.01 ? 4 : 2;
  return new Intl.NumberFormat(undefined, {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: fractionDigits,
    maximumFractionDigits: fractionDigits,
  }).format(amount);
}

export function formatDateTime(iso: string | undefined): string {
  if (iso === undefined || iso === "") return NOT_RECORDED;
  const value = new Date(iso);
  if (Number.isNaN(value.getTime())) return NOT_RECORDED;
  return new Intl.DateTimeFormat(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
    timeZoneName: "short",
  }).format(value);
}

export function formatDate(iso: string | undefined): string {
  if (iso === undefined || iso === "") return NOT_RECORDED;
  const value = new Date(iso);
  if (Number.isNaN(value.getTime())) return NOT_RECORDED;
  return new Intl.DateTimeFormat(undefined, { dateStyle: "medium" }).format(value);
}

export function formatDurationMs(durationMs: number | undefined): string {
  if (durationMs === undefined || !Number.isFinite(durationMs)) return NOT_RECORDED;
  if (durationMs < 1000) return `${Math.round(durationMs)} ms`;
  const totalSeconds = durationMs / 1000;
  if (totalSeconds < 60) return `${totalSeconds.toFixed(1)} s`;
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = Math.round(totalSeconds - minutes * 60);
  return `${minutes} min ${String(seconds).padStart(2, "0")} s`;
}

export interface Countdown {
  readonly expired: boolean;
  /** Spelled out in words so it is unambiguous when read aloud. */
  readonly text: string;
  readonly totalMs: number;
}

/**
 * Time remaining until `iso`, relative to `now`.
 *
 * Rendered in words rather than as "01:04:12" because a colon-separated clock
 * is read out character by character by some screen readers, and an approver
 * hearing "zero one colon zero four" has to do arithmetic to learn that they
 * have about an hour.
 */
export function formatCountdown(iso: string, now: Date): Countdown {
  const target = new Date(iso).getTime();
  if (Number.isNaN(target)) return { expired: false, text: NOT_RECORDED, totalMs: 0 };

  const remaining = target - now.getTime();
  if (remaining <= 0) return { expired: true, text: "Expired", totalMs: 0 };

  const totalSeconds = Math.floor(remaining / 1000);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;

  const parts: string[] = [];
  if (hours > 0) parts.push(`${hours} ${hours === 1 ? "hour" : "hours"}`);
  if (minutes > 0) parts.push(`${minutes} ${minutes === 1 ? "minute" : "minutes"}`);
  if (hours === 0) parts.push(`${seconds} ${seconds === 1 ? "second" : "seconds"}`);

  return { expired: false, text: `${parts.join(" ")} remaining`, totalMs: remaining };
}

/** A whole-number count of items, with the noun agreeing. */
export function pluralise(count: number, singular: string, plural: string): string {
  return `${count} ${count === 1 ? singular : plural}`;
}
