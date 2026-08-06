# ADR 0012 — Work discovery ships disabled, pending written employment-law answers

**Status:** Accepted
**Date:** 2026-08-06

## Context

Work discovery observes how repetitive work actually flows so that the
automation backlog can be chosen from evidence rather than opinion. It is
genuinely useful: opinion and anecdote pick badly, and the alternative sources —
interviews and process metrics — are slower and biased toward whoever is
loudest.

It also observes employees, which makes it the most legally sensitive component
in the product. The obligations are not uniform and not optional:

- Several US states require advance written notice of electronic monitoring,
  with varying requirements and penalties.
- European or other non-US staff bring works-council consultation and GDPR
  obligations. In several jurisdictions monitoring without consultation is
  unlawful *regardless of individual consent*.
- Union and collective-agreement constraints may apply.
- Contact-centre staff, already recorded for QA, may or may not be treated
  differently from corporate staff.

None of these are answered. A privacy incident here would cost far more than
the prioritisation it buys.

## Decision

**The component is built, and it ships disabled.**

Built, because retrofitting privacy into an observation system does not work —
the structural exclusions have to be in the type system and the tests from the
beginning, and deciding them under delivery pressure later produces a worse
answer.

Disabled, because the questions above are unresolved.

The controls, all enforced in code:

- **Three independent gates**: the feature enabled in configuration (default
  false), a named owner and device enrolled with a *positive* application
  allowlist (an empty allowlist observes nothing), and a collector started
  deliberately.
- **Structural exclusions, not settings.** Screen contents, window titles,
  keystrokes, clipboard, URLs and query strings, document contents, form
  values, message bodies, and customer records cannot be represented in the
  observation type, and a runtime validator rejects any observation carrying an
  unexpected key. Tests enumerate every forbidden field and assert rejection,
  and a further test asserts the observation's key set exactly matches an
  explicit allowlist — so adding a field breaks the build until someone
  reconsiders.
- **An immutable blocklist floor** covering communication tools and systems of
  record, which always beats the allowlist and cannot be weakened by enrollment
  policy.
- **Short retention** with a hard ceiling enforced in code; candidates computed
  on demand rather than accumulated in a second store.
- **No egress.** Observations never reach a model provider or third party; the
  module does not import the models module, and a test asserts it.
- **The observed person is in control**: pause, stop, revoke, and erase, at any
  time, without an administrator.
- **Proposals are inert.** Discovery may draft a workflow and a role. It may
  never execute, save, schedule, or activate either, and no method exists that
  would.

Configuration warns loudly at startup and in the health check when the feature
is enabled.

## Consequences

- The automation backlog for the first release is chosen from interviews and
  metrics. That is slower and less rigorous, and it is the right trade.
- When the employment-law questions are answered in writing, enabling this is a
  configuration change plus an enrollment, not a build.
- If the answer is "never", the module is deleted and nothing else changes,
  because nothing depends on it.
- Shipping disabled code carries a maintenance cost and a risk that it rots
  untested. Mitigated by its tests running in CI like everything else.

## Alternatives considered

**Do not build it at all until the questions are answered.** Defensible. It
would leave the privacy design to be done later under schedule pressure, which
is when it gets done badly.

**Build it enabled and rely on deployment configuration.** Rejected. The
default must be the safe one, and a component that observes employees should
require a deliberate act to switch on.
