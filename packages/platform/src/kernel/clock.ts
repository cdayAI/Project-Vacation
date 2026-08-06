/**
 * Time.
 *
 * Statutory deadlines are computed from these values, the demo has to be
 * reproducible, and workflow timers have to be testable without waiting. All
 * three require that nothing in the platform calls `Date.now()` directly.
 * A lint rule and an architecture test enforce that; this is the sanctioned
 * way to read the time.
 */

/** Milliseconds since the Unix epoch. */
export type Instant = number;

export interface Clock {
  /** Current time as an epoch-millisecond value. */
  now(): Instant;
  /** Current time as an ISO-8601 string in UTC, e.g. `2026-08-06T13:05:00.000Z`. */
  nowIso(): string;
}

export class SystemClock implements Clock {
  now(): Instant {
    return Date.now();
  }

  nowIso(): string {
    return new Date(this.now()).toISOString();
  }
}

/**
 * A clock the caller drives.
 *
 * Used by the test suite and by the seeded demo, where "runs twice in a row
 * identically from a cold start" is a stated gate and any wall-clock reading
 * would break it.
 */
export class FixedClock implements Clock {
  private current: Instant;

  constructor(start: Instant | string) {
    this.current = typeof start === "string" ? Date.parse(start) : start;
    if (!Number.isFinite(this.current)) {
      throw new TypeError(`FixedClock needs a valid instant, received: ${String(start)}`);
    }
  }

  now(): Instant {
    return this.current;
  }

  nowIso(): string {
    return new Date(this.current).toISOString();
  }

  /** Move time forward. Negative values are rejected: time does not go back. */
  advance(milliseconds: number): void {
    if (milliseconds < 0) {
      throw new RangeError("FixedClock cannot move backwards");
    }
    this.current += milliseconds;
  }

  /** Jump to an explicit instant, which may be earlier than the current one. */
  set(instant: Instant | string): void {
    const next = typeof instant === "string" ? Date.parse(instant) : instant;
    if (!Number.isFinite(next)) {
      throw new TypeError(`FixedClock needs a valid instant, received: ${String(instant)}`);
    }
    this.current = next;
  }
}

export const MILLISECOND = 1;
export const SECOND = 1000 * MILLISECOND;
export const MINUTE = 60 * SECOND;
export const HOUR = 60 * MINUTE;
export const DAY = 24 * HOUR;
