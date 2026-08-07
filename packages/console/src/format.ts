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
  // Model and retrieval spend lands in fractions of a cent, and a single run
  // is often a few cents in total. Two decimal places would render most of
  // this console's real numbers as $0.00 or $0.02 — precise enough to look
  // authoritative and too coarse to add up. Anything under a dollar keeps four
  // places; anything above it reads as money.
  const fractionDigits = amount !== 0 && Math.abs(amount) < 1 ? 4 : 2;
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
  // Explicit components rather than dateStyle/timeStyle: the two forms cannot
  // be combined, and the timezone name has to be shown. An operator reading a
  // rescission deadline needs to know which clock it is on.
  return new Intl.DateTimeFormat(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
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

/**
 * How long ago `iso` was, in the compact form the work queue's age column uses.
 *
 * Two units at most: "2d 4h" rather than "2d 4h 17m". The third unit is never
 * the one anybody triages on, and it makes the column jitter every minute in a
 * table an operator is trying to read down.
 *
 * A future instant reads "not yet" rather than a negative age. Clock skew
 * between the browser and the platform is small but real, and "-3s" in an age
 * column reads as a bug in the queue rather than as a difference of opinion
 * about the time.
 */
export function formatAge(iso: string, now: Date): string {
  const started = new Date(iso).getTime();
  if (Number.isNaN(started)) return NOT_RECORDED;

  const elapsed = now.getTime() - started;
  if (elapsed < 0) return "not yet";

  const minutes = Math.floor(elapsed / 60_000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes}m`;

  const hours = Math.floor(minutes / 60);
  if (hours < 24) {
    const remainderMinutes = minutes - hours * 60;
    return remainderMinutes === 0 ? `${hours}h` : `${hours}h ${remainderMinutes}m`;
  }

  const days = Math.floor(hours / 24);
  const remainderHours = hours - days * 24;
  return remainderHours === 0 ? `${days}d` : `${days}d ${remainderHours}h`;
}

/** A whole-number count of items, with the noun agreeing. */
export function pluralise(count: number, singular: string, plural: string): string {
  return `${count} ${count === 1 ? singular : plural}`;
}

/**
 * A proportion in the range 0–1, rendered as a percentage.
 *
 * One decimal place by default: evaluation accuracy moves in fractions of a
 * point, and rounding 96.25% to 96% makes two materially different results
 * look identical.
 */
export function formatPercent(fraction: number, fractionDigits = 1): string {
  if (!Number.isFinite(fraction)) return NOT_RECORDED;
  return new Intl.NumberFormat(undefined, {
    style: "percent",
    minimumFractionDigits: fractionDigits,
    maximumFractionDigits: fractionDigits,
  }).format(fraction);
}

/**
 * A signed percentage-point change, with the sign always written.
 *
 * "+2.9 points" rather than "2.9 points": an unsigned number beside a delta
 * reads as a value, and the direction is the whole point of a delta.
 */
export function formatPercentagePoints(points: number): string {
  if (!Number.isFinite(points)) return NOT_RECORDED;
  const rounded = points.toFixed(2);
  const sign = points > 0 ? "+" : "";
  return `${sign}${rounded} percentage points`;
}

/** A count formatted in the viewer's locale, so 11284 reads as 11,284. */
export function formatCount(count: number): string {
  if (!Number.isFinite(count)) return NOT_RECORDED;
  return new Intl.NumberFormat(undefined).format(count);
}
