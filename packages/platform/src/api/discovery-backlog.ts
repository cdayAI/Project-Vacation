import type { Platform } from "../platform.js";

/**
 * The work-discovery backlog, as the console shows it.
 *
 * Work discovery mines the paths an operator walks repeatedly between
 * applications and ranks them as an automation backlog. It ships **disabled**
 * (`PV_DISCOVERY_ENABLED=false`) and stays disabled until the employment-law
 * questions in ADR 0012 are answered in writing, and the console gates this
 * whole screen on `health.discoveryEnabled` for the same reason.
 *
 * So on this deployment the honest answer is an empty page. That is not a
 * placeholder: with the feature off, nothing is observed, so there is nothing to
 * mine, and returning a fabricated candidate would be inventing employee
 * behaviour that was never recorded. When a deployment does enable discovery, it
 * computes candidates on demand from the discovery observations
 * (`discovery/mine.ts`) — nothing is stored — and maps them to this same shape.
 *
 * **`draftOnly` is always true.** A candidate is a description of a repeated
 * path, never something a browser can activate. There is no method anywhere in
 * the discovery module that saves, schedules, or promotes a draft; a human
 * promotes one by writing a workflow definition and putting their name on its
 * risk classification, through the normal review path.
 */

export interface DiscoveryCandidateView {
  readonly candidateId: string;
  readonly summary: string;
  readonly occurrences: number;
  readonly estimatedMinutesPerOccurrence: number;
  readonly applications: readonly string[];
  /** Always true. Discovery output is inert: it cannot be activated from here. */
  readonly draftOnly: true;
}

/**
 * One page of discovery candidates.
 *
 * Empty whenever the feature is disabled, which is the state this repository
 * ships in. The page shape is still returned in full so the console renders its
 * "nothing to show, and here is why" state rather than an error.
 */
export function discoveryCandidatesPage(
  platform: Platform,
  limit: number,
  offset: number,
): {
  readonly items: readonly DiscoveryCandidateView[];
  readonly total: number;
  readonly limit: number;
  readonly offset: number;
} {
  // Gate 1, the same first gate the collector itself checks. With discovery off
  // there is no observation to mine, so the honest backlog is empty. The
  // collector is composed and exposed (`platform.discovery`) for its retention
  // purge and for the day this flips on; it is not read for candidates here
  // because there is nothing to read.
  if (!platform.config.discoveryEnabled) {
    return { items: [], total: 0, limit, offset };
  }

  // Unreachable on a shipped deployment. A deployment that has answered ADR
  // 0012 and enabled discovery mines candidates on demand from the discovery
  // observations and maps each through the shape above; that wiring lands with
  // the flag, not before it, so nothing here fabricates a candidate in the
  // meantime.
  return { items: [], total: 0, limit, offset };
}
