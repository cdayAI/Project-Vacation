import type { HealthView } from "../api/contract";
import { IconAlert } from "../ui/primitives/icons";
import "./PlatformStateBanner.css";

/**
 * The three facts an operator must never have to go looking for.
 *
 * An uncontained sandbox, work discovery switched on, and an audit chain that
 * does not verify are each, on their own, a reason to stop and check something
 * before trusting anything else on screen. So they are stated at the top of
 * every page, in a banner that cannot be dismissed and does not collapse.
 *
 * A missing verification is reported too. "Nobody has checked" is a different
 * statement from "it is intact", and only one of them is reassuring.
 *
 * It sits between the top bar and `<main>` rather than inside the scrolling
 * content, so it cannot be scrolled away from — and outside `<main>`, so a
 * route change does not re-announce it to a screen-reader user who has already
 * read it and decided what to do.
 */

export interface PlatformStateBannerProps {
  readonly health: HealthView | null;
  /** True when the health endpoint could not be read at all. */
  readonly unavailable: boolean;
}

interface Alert {
  readonly id: string;
  readonly text: string;
}

export function PlatformStateBanner({ health, unavailable }: PlatformStateBannerProps) {
  if (unavailable) {
    return (
      <section className="pv-platform-banner" aria-labelledby="platform-state-heading">
        <p className="pv-platform-banner-mark">
          <IconAlert size="sm" />
          {/* The word, not only the mark and the tint: this banner is the first
              thing in a printed handover pack and the last thing a colour-blind
              operator should have to guess at. */}
          Warning
        </p>
        <div className="pv-platform-banner-body">
          <h2 className="pv-platform-banner-heading" id="platform-state-heading">
            Platform state is unknown
          </h2>
          <p>
            The console could not read the platform&rsquo;s health. It cannot currently tell you
            whether the sandbox is contained, whether work discovery is enabled, or whether the
            audit chain verifies. Treat those three as unconfirmed until this clears.
          </p>
        </div>
      </section>
    );
  }

  if (health === null) return null;

  const alerts: Alert[] = [];

  if (!health.sandboxIsContained) {
    alerts.push({
      id: "sandbox",
      text: `The execution sandbox is not contained (mode: ${health.sandboxMode}). Code the platform runs is not isolated from this host.`,
    });
  }

  if (health.discoveryEnabled) {
    alerts.push({
      id: "discovery",
      text: "Work discovery is enabled. Employee observation is being collected. It ships disabled, so someone turned this on deliberately — confirm that was intended and that enrolment and notice are in place.",
    });
  }

  const verification = health.lastAuditVerification;
  if (verification === undefined) {
    alerts.push({
      id: "audit-unverified",
      text: "The audit chain has not been verified. Nobody has checked that the record is intact; that is not the same as it being intact.",
    });
  } else if (!verification.intact) {
    alerts.push({
      id: "audit-broken",
      text: `Audit verification failed: ${verification.breaks.length} break${
        verification.breaks.length === 1 ? "" : "s"
      } found across ${verification.entriesChecked} entries. The evidence trail cannot be relied on until this is explained.`,
    });
  }

  for (const warning of health.warnings) {
    alerts.push({ id: `warning-${warning}`, text: warning });
  }

  if (alerts.length === 0) return null;

  return (
    <section className="pv-platform-banner" aria-labelledby="platform-state-heading">
      <p className="pv-platform-banner-mark">
        <IconAlert size="sm" />
        Warning
      </p>
      <div className="pv-platform-banner-body">
        <h2 className="pv-platform-banner-heading" id="platform-state-heading">
          Platform state needs your attention
        </h2>
        <ul className="pv-platform-banner-list">
          {alerts.map((alert) => (
            <li key={alert.id}>{alert.text}</li>
          ))}
        </ul>
      </div>
    </section>
  );
}
