# ADR 0010 — Single tenant, with a data-scoping seam kept clean

**Status:** Accepted
**Date:** 2026-08-06

## Context

This is a custom build for one customer. Multi-tenancy is expensive: it touches
every query, every cache key, every test fixture, and every authorization
decision, and it is the source of the highest-severity class of bug a platform
like this can have — one customer seeing another's data.

Building it speculatively, for a second customer who does not exist, would be
paying that cost with no benefit. But MVW is not a monolith either: vacation
ownership, exchange, and resort management have different data-sensitivity
profiles, and many homeowners' associations are separate legal entities whose
data should not be freely readable across boundaries.

## Decision

**Do not build multi-tenancy.** There is no tenant id, no tenant-scoped
connection routing, and no per-tenant configuration.

**Do keep a clean data-scoping seam**, which is needed for MVW's own internal
boundaries regardless:

- Authorization carries `requiredScopes` on an action request, and entitlements
  are expressed as `scope:` prefixed roles derived from directory groups
  (`guard/authorize.ts`).
- Domain objects carry an explicit access scope where the data is sensitive —
  corpora, documents, associations.
- Queries filter by scope at the port boundary rather than in the caller, so
  the filter cannot be forgotten by a new call site.

If multi-tenancy is ever required, tenancy becomes another dimension of the
existing scope mechanism rather than a new concept threaded through everything.

## Consequences

- Significant complexity avoided in the first release.
- The association-level and business-line boundaries MVW actually needs are
  supported today, which is the requirement that exists rather than the one
  that might.
- If a second customer is ever contemplated, this is a substantial project, not
  a configuration change. That should be said plainly rather than implied to be
  cheap.
- Deployment isolation remains the strongest boundary available: a second
  customer would get a second deployment.

## Alternatives considered

**Row-level tenancy from the start.** Rejected as speculative complexity, per
the explicit instruction not to build multi-tenancy unless asked.

**Schema-per-tenant.** Same objection, plus it complicates the migration story,
which has a hard requirement to be additive and zero-downtime.
