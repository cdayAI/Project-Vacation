# Threat model

**Method:** STRIDE, applied per trust boundary, with AI-specific threats treated
as first-class rather than as an appendix.
**Scope:** the Project Vacation platform — API, console, workflow engine,
knowledge layer, model gateway, and their data stores.
**Out of scope:** MVW's systems of record, MVW's identity provider, MVW's
payment estate, and the cloud control plane. Each appears here as an external
entity with an interface and a set of assumptions, not as an asset we defend.
**Last reviewed:** 2026-08-06.

Mitigations name the code that implements them. Where a threat is accepted or
only partly mitigated, this document says so — a threat model that lists only
solved problems is marketing.

---

## 1. Assets, in priority order

| # | Asset | Why it matters | Worst realistic outcome |
| --- | --- | --- | --- |
| A1 | The audit chain | It is the product's evidentiary claim | An action nobody can account for, or a record an auditor cannot trust |
| A2 | Approval integrity | It is the control the risk committee relies on | A high-consequence action taken without a real human decision |
| A3 | Owner personal data | Regulatory and reputational exposure | Unauthorised disclosure of owner data |
| A4 | Statutory deadline correctness | A wrong deadline voids a contract | Rescission window miscomputed at scale |
| A5 | Containment controls | The ability to stop | An operator cannot halt in-flight work |
| A6 | Integration credentials | Access to systems of record | Lateral movement into MVW's estate |
| A7 | Model and prompt configuration | Determines system behaviour | Silent behaviour change with no review |
| A8 | Employee observation data (§discovery) | Employment-law exposure | Monitoring beyond what was disclosed and consented to |

---

## 2. Trust boundaries

```
                    ┌─────────────────────────────────────────┐
   MVW staff ──1──▶ │  Console (browser)                       │
                    └───────────────┬─────────────────────────┘
                                    │ 2 (authenticated HTTPS)
                    ┌───────────────▼─────────────────────────┐
   MVW IdP ───3───▶ │  API + platform process                  │
                    │  ┌────────────────────────────────────┐  │
                    │  │ authorization chokepoint (guard/)  │  │
                    │  └───┬──────────┬──────────┬──────────┘  │
                    └──────│──────────│──────────│─────────────┘
                       4   │      5   │      6   │
              ┌────────────▼──┐ ┌─────▼──────┐ ┌─▼─────────────┐
              │ Postgres      │ │ Model      │ │ MVW systems   │
              │ (record,      │ │ provider   │ │ of record     │
              │  audit)       │ │ (external) │ │ (external)    │
              └───────────────┘ └────────────┘ └───────────────┘
                                       ▲
                                   7   │ untrusted content
                          ┌────────────┴──────────────┐
                          │ owner messages, uploaded  │
                          │ documents, 3rd-party data │
                          └───────────────────────────┘

              ┌───────────────────────────┐
              │ agents MVW runs elsewhere │──8──▶ API + platform process
              │ (CRM, cloud agent service,│       (inbound, agent-authenticated)
              │  purchased products)      │
              └───────────────────────────┘
```

1. Browser to console assets
2. Console to API
3. API to identity provider
4. Platform to its own database
5. Platform to model provider
6. Platform to MVW systems of record
7. Untrusted content entering the platform
8. Agents running outside this platform, calling in

---

## 3. STRIDE by boundary

### Boundary 2 — Console to API

| Threat | STRIDE | Mitigation | Residual |
| --- | --- | --- | --- |
| Forged session | S | OIDC with PKCE; signed httpOnly cookies; ID-token signature, issuer, audience, expiry all verified (`identity/oidc.ts`) | Depends on IdP integrity — accepted, IdP is MVW's |
| Privilege escalation via crafted request | E | Every action resolves through `ActionRegistry`; unregistered actions refused; roles derived from IdP groups, never client-supplied (`guard/authorize.ts`) | — |
| Approving without re-authentication | E | Step-up required for high-consequence actions; age of authentication checked server-side | — |
| Repudiation of an approval | R | Approval decisions recorded with actor, timestamp, step-up state, and proposal digest | — |
| Cross-site request forgery | T | SameSite cookies; state parameter on the OIDC flow | — |
| Data exposure beyond entitlement | I | `requiredScopes` on action requests; scope filtering at the port boundary (ADR 0010) | Scope assignment correctness depends on MVW group hygiene |

### Boundary 4 — Platform to database

| Threat | STRIDE | Mitigation | Residual |
| --- | --- | --- | --- |
| **Audit entry altered or deleted** | T | Hash chain over content and linkage; `verifyChain` reports every break; Postgres trigger raises on UPDATE/DELETE of the audit table | **An actor with database *and* application write access could rewrite the whole chain consistently.** Detecting that needs an external anchor — see §5.1 |
| Audit chain forked by concurrent writes | T | Sequence and previous-hash assigned inside an advisory-locked transaction; contract tests run 20 concurrent appends and verify the result | — |
| Approval replayed | E | `consumeApproval` is an atomic compare-and-set; contract tests run 10 concurrent consumptions and assert exactly one success | — |
| Approval satisfied by one person twice | E | Store rejects a second decision from the same actor atomically; requester cannot approve (`guard/approvals.ts`) | — |
| SQL injection | T,I | Parameterised queries only; no string-built SQL | — |
| Credential theft from connection string | I | Secrets from the secret manager; redaction removes connection strings from logs (`kernel/redact.ts`) | — |
| Data loss | D | Backups with a *tested* restore; drill result recorded (`docs/ops/backup-and-restore.md`) | — |

### Boundary 5 — Platform to model provider

| Threat | STRIDE | Mitigation | Residual |
| --- | --- | --- | --- |
| Owner data or secrets sent to provider | I | Boundary screen redacts before the call; models declare whether they may see owner data; prompt/response stored as digests only (`models/invoke.ts`) | Redaction is heuristic — see §5.2 |
| Provider outage degrades answers silently | D | Declared fallback chain; `model.degraded` recorded; total failure denies rather than degrading (ADR 0013) | — |
| Cost exhaustion | D | Ceilings enforced at consumption with reservation; per-run, per-day, and rate limits (`guard/ceilings.ts`) | Rate window is per-process — see §5.3 |
| Provider retains or trains on MVW data | I | Contractual: zero retention and no training must be confirmed in writing and recorded before production use | **Open — not yet confirmed.** On the confirm-before-building list |

### Boundary 6 — Platform to MVW systems of record

| Threat | STRIDE | Mitigation | Residual |
| --- | --- | --- | --- |
| Calling an unintended host | S,I | Host allowlist from config; empty allowlist refuses everything (`integrations/egress.ts`) | — |
| Duplicate external effect on retry | T | Idempotency keys checked against the operating record before any effect (ADR 0007) | Depends on the remote system honouring them — must be confirmed per integration |
| Credential leakage | I | Secret-manager provider; individually revocable; never logged, never in an audit record; tested | — |
| Silent degradation to a worse answer | T | Explicit `DegradationPolicy` — queue, park, or refuse (`integrations/degrade.ts`) | — |

### Boundary 7 — Untrusted content

This is the boundary that distinguishes an AI platform's threat model from an
ordinary application's.

| Threat | STRIDE | Mitigation | Residual |
| --- | --- | --- | --- |
| **Prompt injection via owner message or uploaded document** | T,E | Screened before reaching a model or any instruction surface; a screen that errors *denies* (`guard/screen.ts`) | **Heuristic detection will miss novel phrasing — see §5.2** |
| Injected instruction causes a consequential action | E | Architectural, not detective: a model never holds tool authority the calling role lacks, and every action passes the chokepoint regardless of what any model asked for | — |
| Corpus poisoning | T | Ingestion is governed: screened, classified, access-scoped, provenance recorded, refusal audited (`knowledge/ingest.ts`) | — |
| Exfiltration via crafted output | I | Outbound content passes the contact gate; consumer-facing output above a risk threshold requires human approval | — |
| Oversized input as denial of service | D | Length ceiling; oversized input refused rather than truncated, because truncating would screen only part of what the model sees | — |

### Boundary 8 — Agents running outside this platform

The newest boundary and the least conventional one. The caller is a program
this platform did not build, running on a host it does not administer, operated
by a team or a vendor it cannot instrument. It cannot be reached, throttled at
its source, or killed. Everything below follows from that.

| Threat | STRIDE | Mitigation | Residual |
| --- | --- | --- | --- |
| **Unenrolled or unknown caller acts** | S,E | Enrollment is the basis of admission; an unenrolled id is refused with no anonymous path (`external/admission.ts`) | — |
| Stolen bearer token replayed | S | Tokens stored as a hash and shown once; individually revocable; an agent holding **any** strong credential is refused bearer authentication entirely | A bearer-only agent's stolen token works until revoked — which is why strong credentials exist and why the switch defaults on |
| Forged identity assertion | S | JWT verified **offline** against a local key file, asymmetric algorithms only, subject claim required to equal the enrolled agent id; envelopes are domain-separated over a pinned key | — |
| Captured signed request replayed | S,E | Durable per-agent nonce claims plus a freshness window; single-use applies to HMAC as well as envelopes; nonce burned only after the signature verifies | Bounded **per agent**, never globally, so one busy tenant cannot evict another's claims |
| **Approved request swapped for another at commit** | T,E | The approval binds to the digest of the exact request; any difference voids the action and counts as misbehaviour | — |
| Approval spent twice | E | One-shot ledger with a floor: an evicted entry is refused rather than forgotten, so ageing out never re-opens an approval | Deliberately over-refuses ids at or below the floor |
| Replayed commit told "expired, try again" | E | Terminal status is checked **before** expiry, so a replay hears "already done" — never an instruction to duplicate the effect through a second approval | — |
| Agent keeps acting after an operator stops it | E | Kill switch delivered in the heartbeat reply, with every stop condition read fresh on every beat; the admission chain re-runs at commit, so a granted approval does not survive a revocation | An agent between heartbeats is not yet stopped; the reclaim window bounds this and is configurable |
| Agent floods the plane | D | Per-agent, per-operation rolling-window limits; a limiter that cannot count refuses rather than waves through | — |
| Persistent probing for permissions it lacks | E | A run of **misbehaviour** denials auto-contains until a human releases; our own infrastructure failures are excluded from the ledger the threshold reads | An agent under the threshold is refused every time but not contained — by design |
| Risk understated by the caller | T,E | The operator's rating on the tool grant floors whatever the agent declares; a declaration may raise a tier, never lower one | — |
| Padded field pushes content past a scan window | T | Every input bounded **before** anything is screened; oversized bodies refused whole rather than truncated | — |
| Spend hidden by retrying a report | R | Ingestion is exactly-once on the agent's idempotency key; a retry returns the original record instead of counting again | — |
| **Worker dies mid-commit; effect may have landed** | R | The action is marked `indeterminate` and **never** retried automatically; the operator is told to check the system of record | Resolution is manual by design — an automatic retry could issue a second payment |
| External activity invisible in the record | R | Everything lands in the one operating record, approval queue and audit chain under a principal marked external | Only covers what the agent asks *us* for; direct vendor-to-vendor calls remain outside any record here |

### Cross-cutting

| Threat | STRIDE | Mitigation | Residual |
| --- | --- | --- | --- |
| **In-flight work outruns the kill switch** | D | Containment re-checked before *every* step, not at instance start; tested by engaging a pause mid-instance | Compensation steps deliberately proceed under containment — leaving a half-completed irreversible sequence unrepaired is worse |
| Untrusted code execution | E | Sandbox defaults to `disabled`; `subprocess` is flagged as NOT a security boundary at startup and in the health check; `external` refuses if no isolation service is wired in (`guard/sandbox.ts`) | Real isolation is the deployment's responsibility — stated, not implied |
| Behaviour changed without review | T | Model and prompt resolution from configuration; role promotion requires recorded evaluation plus human approval; improvement loop cannot apply without an approval, with no configuration to disable the gate (ADR 0011, 0013) | — |
| Evaluation gamed by weakening its own tests | T | Golden sets protected: a proposal may add cases, never weaken, relabel, or delete one; enforced in code and tested against every mutation shape | — |
| Employee monitoring beyond disclosure | I | Structural exclusions in the type system plus a runtime validator; immutable blocklist floor; three independent gates; ships disabled (ADR 0012) | **Employment-law questions unanswered — feature must stay off** |
| Card data entering scope | I | No card fields; Luhn-checked PAN redaction; audit log refuses PAN-shaped content (ADR 0009) | — |

---

## 4. Attacker profiles

**External unauthenticated.** No path to the platform without a valid IdP
session. Primary surface is the untrusted-content boundary via owner messages
that reach the platform through MVW channels.

**Malicious or compromised MVW insider with console access.** The most
consequential profile, and the one the controls are shaped around: segregation
of duties on approvals, step-up re-authentication, per-action authorization,
scope-limited data access, and an audit trail they cannot edit through the
application. An insider *with database write access as well* is a residual (§5.1).

**Compromised model provider.** Treated as untrusted output: a model response
never authorises an action. Provider responses that drive consequential
decisions pass through the same chokepoint as anything else.

**Compromised dependency.** Dependency scanning with severity-based SLAs, SBOM
on every build, lockfile-pinned installs.

---

## 5. Accepted and partial mitigations

Stated plainly because these are what an assessor should probe.

### 5.1 The audit chain is tamper-*evident*, not tamper-*resistant*

An actor with write access to both the database and the application can rewrite
the chain consistently, and verification would pass. The chain defends against
targeted edits, deletions, and back-dating — the realistic insider actions — not
against a full rewrite by someone with total control.

*Fix, not built:* periodically publish the head hash to a location outside the
deployment's control (an append-only external store, or a countersignature from
a separate trust domain). Verification then anchors to a value the attacker
cannot rewrite. Recorded in the not-production-grade list.

### 5.2 Prompt-injection screening is heuristic

`guard/screen.ts` catches the well-known shapes and will miss novel phrasing and
determined obfuscation. It is one layer, and deliberately not the load-bearing
one. The architecture bounds the damage: untrusted text is never concatenated
into a system prompt, a model never holds tool authority its calling role lacks,
and every consequential action passes the chokepoint regardless of what any
model asked for. The screen reduces the rate; the architecture bounds the blast
radius. Neither alone is sufficient and neither is claimed to be.

### 5.3 Rate and reservation state is per-process

The model-call rate window and the ceiling reservations live in process memory.
A multi-instance deployment can exceed the intended rate by a factor of the
instance count. Spend ceilings still hold, because spend is summed from the
operating record, which is shared. Moving the rate window to shared storage is
required before horizontal scaling; recorded in the not-production-grade list.

### 5.4 Statutory rules are unverified

Every rescission rule ships `verified: false`. The engine is correct; the data
is placeholder. This is a correctness risk of the highest consequence and it is
mitigated only by refusing to be used until MVW's counsel verifies each entry.

### 5.5 Availability is deliberately traded for accountability

Fail-closed means a dependency outage stops work. This is the intended
behaviour (ADR 0003) and it must appear in the SLO conversation with MVW rather
than surprise anyone during an incident.

---

## 6. Review cadence

Reviewed on any change to a trust boundary, on any new integration or model
provider, on any change to the authorization or approval logic, and at minimum
every six months. The reviewer records the date and the diff reviewed at the top
of this document.
