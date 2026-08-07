# Pass 0 — Inventory: what actually exists

**Date:** 2026-08-07
**Method:** `docs/review-method.md`, Pass 0.
**Authorities:** `docs/program-brief.md`, `docs/design/design-spec.md`,
`docs/architecture.md`. Where a claim in any other document disagrees with
those three, those three win.

---

## 0. How to read this document

This is written for someone who has never opened this repository. It answers one
question for every capability the project claims, anywhere: **what does a person
or an agent actually do to reach it, and where in the source is that?**

The distinction this pass turns on, from the program brief §21:

> A feature is not done until something calls it. A module with tests and no
> caller is inert.

So "it is implemented in `documents/generate.ts`" is not an answer. "The console
POSTs `/api/documents`, which calls it, at `api/server.ts:412`" would be. Where
there is no such path, the entry says **INERT** and the gap table at the end
carries it.

Three vocabulary notes:

- **Entry point** — a place a request or a command originates. This repository
  has exactly one process entry point (`packages/platform/src/cli/main.ts`) and
  one browser entry point (`packages/console/src/main.tsx`).
- **Reachable** — there is an unbroken import-and-call path from an entry point.
  A composition root (`platform.ts`), a registry (`store/registry.ts`,
  `guard/registry.ts`) and a barrel file (`*/index.ts`) are legitimate links in
  such a path, and are treated as such below. A barrel file that nothing imports
  is not.
- **Claimed** — asserted in the README, any document under `docs/`, any ADR, or
  the merged pull request #1.

### What was actually run to produce this

Everything below was executed on this working tree, not read off a document.

| Command | Result |
| --- | --- |
| `packages/platform` → `vitest run` with `PV_TEST_DATABASE_URL` set | **46 files, 1,737 tests, all passing**, 90.8s |
| Postgres contract suites, verified by name | 62 in-memory suites **and** 62 Postgres suites ran — the Postgres branch is genuinely exercised, not silently skipped |
| `packages/platform` → `tsc --noEmit` | clean |
| `packages/console` → `tsc -p tsconfig.json --noEmit` | clean |
| `packages/console` → `vitest run` | **103 files, 1,362 tests, 14 failing in 4 files** (`WorkQueue`, `ApprovalsQueue`, `ApprovalDetail`, `RunDetail`) — these are the views being rebuilt by other agents and are **out of scope for this pass** |
| `node tools/check-accessibility-coverage.mjs` | 18/18 console views carry an automated assertion |
| `pv demo run` | exit 0, chain intact |
| `pv evaluate --ci` | exit 0, baseline golden set 8/8 |
| Fastify route table, dumped at runtime with the plane enabled | 19 distinct method+path routes (37 including auto-registered `HEAD`) |

The suite being green is the premise of this pass, not a defence against it.
Almost everything below was invisible to it.

---

## 1. The entry points — the only ways in

| # | Entry point | File | What it is |
| --- | --- | --- | --- |
| E1 | `pv` command line | `packages/platform/src/cli/main.ts:351` (`main`) | The only process entry point. `pnpm demo`, `pnpm api`, `pnpm db:migrate`, `pnpm audit:verify` are all thin aliases for it (`packages/platform/package.json:14-19`). |
| E2 | HTTP API | `packages/platform/src/api/server.ts:93` (`createServer`), started from `cli/main.ts:442` (`serve`) | Session-authenticated console surface plus the third-party agent plane. |
| E3 | External-agent plane | `packages/platform/src/api/external.ts:321` (`registerExternalRoutes`), mounted at `api/server.ts:663` | Separate authentication, separate error handler, separate bounds. Published as `docs/external-agents/openapi.yaml`. |
| E4 | Operator console | `packages/console/src/main.tsx` → `App.tsx` → `routes.tsx` | A browser client of E2 only. It has no other data source. |
| E5 | Seeded demonstration | `packages/platform/src/demo/run.ts:108` (`runDemo`), reached from `cli/main.ts:374` | A scripted narrative, not a product surface. |

There is no scheduler, no worker process, no queue consumer, and no message
listener. Nothing in this repository runs unless E1 is invoked or E2 receives a
request.

---

## 2. Every HTTP route, exhaustively

Dumped from Fastify's `onRoute` hook at runtime with
`PV_EXTERNAL_AGENTS_ENABLED=true`, so this is the registry itself and not a
reading of the source.

### 2.1 Console-facing surface (session authentication)

| Method | Path | Registered at | Authorized action | Console client caller |
| --- | --- | --- | --- | --- |
| GET | `/health` | `api/server.ts:248` | none — deliberately unauthenticated | — (infrastructure probe) |
| GET | `/api/health` | `api/server.ts:249` | none | `client.ts:380` |
| GET | `/api/session` | `api/server.ts:255` | none; resolves the actor | `client.ts:379` |
| GET | `/api/runs` | `api/server.ts:285` | `record.read_run` | `client.ts:383` |
| GET | `/api/runs/:runId` | `api/server.ts:294` | `record.read_run` | `client.ts:418` |
| POST | `/api/runs/:runId/steps/:stepId/corrections` | `api/server.ts:347` | `improvement.observe` (inside `ObservationHarvester`) | `client.ts:421` |
| GET | `/api/approvals` | `api/server.ts:403` | `record.read_run` | `client.ts:401` |
| GET | `/api/approvals/:approvalId` | `api/server.ts:425` | `record.read_run` | `client.ts:407` |
| POST | `/api/approvals/:approvalId/decisions` | `api/server.ts:437` | approval service enforces step-up + SoD | `client.ts:410` |
| GET | `/api/audit` | `api/server.ts:490` | `audit.read` | `client.ts:468` |
| GET | `/api/audit/verification` | `api/server.ts:540` | `audit.read` | `client.ts:486` |
| GET | `/api/containment` | `api/server.ts:552` | `record.read_run` | `client.ts:488` |
| POST | `/api/containment` | `api/server.ts:559` | `containment.engage` / `containment.release` | `client.ts:491` |
| GET | `/api/actions` | `api/server.ts:601` | `record.read_run` | **none** — see §7 |
| GET | `/api/external-agents` | `api/server.ts:622` | `record.read_run` | `client.ts:510` |
| GET | `/api/external-agents/:agentId` | `api/server.ts:639` | `record.read_run` | `client.ts:521` |

### 2.2 External-agent plane (agent credential authentication)

Prefix `/api/external`, registered as an encapsulated Fastify plugin so its
content-type parser, bounds, and error handler apply only here.

| Method | Path | Registered at | Admission chain | OpenAPI |
| --- | --- | --- | --- | --- |
| POST | `/api/external/screen` | `api/external.ts:437` | full chain, `operation: "screen"` | `openapi.yaml:87` |
| GET | `/api/external/approvals/:approvalId` | `api/external.ts:470` | authentication + ownership only | `openapi.yaml:142` |
| POST | `/api/external/report` | `api/external.ts:508` | full chain, `operation: "report"`, no cost estimate charged | `openapi.yaml:170` |
| POST | `/api/external/runs` | `api/external.ts:569` | full chain, `operation: "run.start"` | `openapi.yaml:237` |
| POST | `/api/external/runs/:externalRunId/heartbeat` | `api/external.ts:639` | rate limit only; `LiveRunService.heartbeat` is the authority (this reply **is** the kill switch) | `openapi.yaml:278` |
| POST | `/api/external/runs/:externalRunId/finish` | `api/external.ts:670` | rate limit only, by design | `openapi.yaml:340` |
| POST | `/api/external/execute` | `api/external.ts:722` | chain runs inside `ExecutionService`, not here | `openapi.yaml:378` |

### 2.3 Duplicates and shadowing

Checked exhaustively against the runtime table.

- **No duplicate registrations.** No path is registered twice with the same
  method.
- **One deliberate double-serve:** `/health` and `/api/health` share a single
  handler closure (`api/server.ts:211`), so they cannot disagree. Correct.
- **No shadowing.** `/api/external-agents` (console, hyphenated) and
  `/api/external/...` (agent plane) do not collide — Fastify's radix tree
  separates them on the literal segment, and the runtime dump confirms both
  answer. `/api/approvals/:approvalId` and `/api/external/approvals/:approvalId`
  are distinct prefixes with distinct authentication.
- The 18 `HEAD` entries are Fastify's automatic companions to the `GET` routes
  and carry no separate handler.
- The OpenAPI contract in `docs/external-agents/openapi.yaml` lists exactly the
  seven plane routes and nothing else. **The published contract matches the
  implementation exactly.** This is the one surface in the repository where the
  document and the code were verified to agree line for line.

---

## 3. Every CLI verb, exhaustively

`USAGE` is the block at `cli/main.ts:24-66`. Dispatch is the switch at
`cli/main.ts:397`. Every row below was executed or traced to its handler.

### 3.1 Top level

| Verb | In `USAGE`? | Handler | Status |
| --- | --- | --- | --- |
| `db migrate` | yes | `cli/main.ts:137` | works (Postgres only; refuses on memory store, `platform.ts:280`) |
| `db status` | **yes, line 28** | **none** | **BROKEN — documented, not implemented.** `commandDb` (`cli/main.ts:134`) handles only `migrate`. Verified by running: prints `Unknown db subcommand: status`, exit 2. |
| `audit verify [--from --to]` | yes | `cli/main.ts:156` | works; exits 1 on a broken chain |
| `audit head` | yes | `cli/main.ts:192` | works |
| `audit query [filters]` | yes | `cli/main.ts:208` | works |
| `containment list` | yes | `cli/main.ts:242` | works |
| `containment engage` | yes | `cli/main.ts:261` | works |
| `containment release` | yes | `cli/main.ts:261` | works |
| `agents <verb>` | yes | `cli/main.ts:406` → `cli/external.ts:412` | works; exits 78 when the plane is off |
| `actions list` | yes | `cli/main.ts:292` | works |
| `evaluate [--ci]` | yes | `cli/main.ts:433` → `cli/evaluate.ts:754` | works; verified exit 0 with an honest omission banner |
| `config show` | yes | `cli/main.ts:386` | works |
| `health` | yes | `cli/main.ts:440` | works |
| `serve` | yes | `cli/main.ts:442` | works |
| `demo run` | yes | `cli/main.ts:374` | works |
| `subject-rights record\|export\|delete\|correct` | **no — but documented in `docs/assurance/subject-rights-runbook.md:25,42,79,102`** | **none** | **BROKEN — see gap 3.** |

### 3.2 `pv agents` sub-verbs

Dispatch at `cli/external.ts:412`. Every verb in `AGENTS_USAGE`
(`cli/external.ts:162`) has a handler, and every handler is in the usage text.
**This is the only command surface in the repository with no drift.**

`list` · `show` · `health` · `enroll` · `update` · `contain` · `release` ·
`revoke` · `credential mint|list|revoke` · `runs` · `parked`

### 3.3 Shadowing

No CLI verb shadows another. `agents health` and top-level `health` are
distinguished by position, not by collision. `credential revoke`
(`cli/external.ts:1062`) and `agents revoke` (`cli/external.ts:430`) are
different verbs at different depths and both dispatch correctly.

---

## 4. Console surfaces, and whether they can load

18 view components exist (`packages/console/src/views/`), 17 are wired into
`ROUTES` (`packages/console/src/routes.tsx:293+`), and 11 appear in the
navigation rail (`routes.tsx:114`). The `Denial` view is a shared error surface
rather than a route.

| Console surface | Route | Client call | Server route exists? |
| --- | --- | --- | --- |
| Work queue | `/work` | `client.ts:383` → `/api/runs` | yes |
| Approvals queue | `/approvals` | `client.ts:401` | yes |
| Approval detail | `/approvals/:id` | `client.ts:407`, `:410` | yes |
| Run detail | `/runs/:id` | `client.ts:418` | yes |
| Audit and evidence | `/audit` | `client.ts:468`, `:486` | yes |
| Containment | `/containment` | `client.ts:488`, `:491` | yes |
| External agents | `/external-agents` | `client.ts:510` | yes |
| External agent detail | `/external-agents/:id` | `client.ts:521` | yes |
| Platform health | `/health` | `client.ts:380` | yes |
| Design gallery | `/design` | none (static) | n/a |
| **Workflow instance** | `/workflows/:id` | `client.ts:435` | **NO** |
| **Role registry** | `/roles` | `client.ts:441` | **NO** |
| **Role detail** | `/roles/:id` | `client.ts:447` | **NO** |
| **Improvement queue** | `/improvements` | `client.ts:450`, `:456` | **NO** |
| **Improvement proposal** | `/improvements/proposals/:id` | `client.ts:462` | **NO** |
| **Discovery backlog** | `/discovery` | `client.ts:504` | **NO** |
| **Executive view** | `/executive` | `client.ts:526` | **NO** |

**Credit where due:** the eight unserved endpoints are *not* hidden. They are
enumerated as an exact, ratcheted allowlist in
`packages/platform/src/api/console-contract.test.ts:47-56`, and that test fails
if a ninth is added or an existing one is quietly served. That is a genuinely
good control and it is why this pass could confirm the list rather than discover
it. What is missing is that no *user-facing* document says these seven screens
cannot load — the operator guide describes two of them as working (§8 below).

### 4.1 The navigation rail cannot draw itself

`isNavigationItemVisible` (`packages/console/src/routes.tsx:240`) matches a
navigation item's `capability` string against `SessionView.capabilities`.

`/api/session` fills `capabilities` from the action registry
(`api/server.ts:266`), so the values it sends are action names —
`record.read_run`, `audit.read`, `containment.engage`, and so on.

The rail asks for a different vocabulary. Compared directly:

```
nav capabilities:  work.read  approvals.read  audit.read  containment.read
                   executive.read  improvements.read  discovery.read
                   roles.read  external_agents.read  health.read

registry actions:  record.read_run  record.read_cost  audit.read
                   knowledge.retrieve  timeline.compute_deadline  ... (27 total)

NOT IN REGISTRY:   work.read  approvals.read  containment.read  executive.read
                   improvements.read  discovery.read  roles.read
                   external_agents.read  health.read       (9 of 10)
```

Only `audit.read` matches. Because the guard clause at `routes.tsx:247` shows
everything **only when the capability list is empty**, a real session — which
always returns a non-empty list — hides nine of the eleven rail items. An
operator who signs in sees "Audit and evidence" and "Design system".

This is invisible to both suites: the console tests supply a fake session, and
the platform tests never read `routes.tsx`.

### 4.2 The copilot

`docs/design/design-spec.md` names the copilot as one of **three hero
surfaces** (§0) and requires it on every route (§3.6) with a context chip row,
a conversation, a composer, inline citations, and action cards.

What exists: a `CopilotMessage` presentational component
(`packages/console/src/ui/domain/CopilotMessage.tsx`), rendered only in the
design gallery; a `C` shortcut in the keyboard registry
(`packages/console/src/keyboard/shortcuts.ts`); and four comments in
`ContextPanel.tsx` describing where it *will* live. There is no conversation, no
composer, no client method, and no server route. **INERT — claimed, not built.**

---

## 5. Modules with no caller

Computed as a transitive closure over the real import graph from the single
process entry point `cli/main.ts` (dynamic `import()` included, so the lazily
loaded `agents`, `evaluate`, `serve`, and `demo` commands are counted as
reachable). **108 source files are reachable. 77 are not.**

Barrel files (`*/index.ts`) and the migration registry (`store/registry.ts`) were
treated as legitimate callers where something imports *them*; where nothing
imports the barrel either, the module is genuinely dark.

### 5.1 Whole modules that no entry point reaches

| Module | Claimed by | Only non-test importer | Verdict |
| --- | --- | --- | --- |
| `engine/` — the workflow engine | Brief §6 (a whole section); README:91; architecture.md layer 5 | `store/registry.ts` (migrations only) | **INERT.** `engine/runner.ts` has no importer at all. No entry point, no console route, no CLI verb, and not the demo, ever constructs a workflow instance. |
| `identity/` — OIDC, sessions, roles, step-up, service accounts | Brief §15; README:87; admin-guide §9 | `store/registry.ts` (migrations only) | **INERT.** `oidc.ts`, `session.ts`, `service-accounts.ts`, `dev-provider.ts` have no importers. See §5.2 — this one is worse than inert. |
| `contact/` — consent ledger and the outbound gate | Brief §10 ("the highest-liability surface in the product"); README:89 | `documents/generate.ts` (itself inert) + migrations | **INERT.** No outbound path exists to gate. |
| `documents/` — versioned templates, governed generation | Brief §9; README:90 | `store/registry.ts` (migrations only) | **INERT.** `documents/generate.ts` has no importer. |
| `integrations/` — narrow ports, fakes, egress allowlist, degradation | Brief §11; README:88 | `store/registry.ts` (migrations only) | **INERT.** `egress.ts`, `fakes.ts`, `degrade.ts`, `contract-tests.ts` all have no importer. |
| `discovery/` — work discovery | Brief §12; README:94; ADR 0012 | `store/registry.ts` (migrations only) | **INERT — and this is the intended state.** ADR 0012 ships it disabled. Recorded here for completeness, not as a defect. |
| `improve/` stages 2–7 | Brief §13; README:93; ADR 0011 | see below | **PARTIALLY INERT.** Stage 1 (harvest) is composed at `platform.ts:199` and reached by `POST /api/runs/:runId/steps/:stepId/corrections`. `cluster.ts`, `propose.ts`, `evaluate.ts`, `approve.ts`, `apply.ts`, `watch.ts` form a closed clique that nothing outside `improve/` imports. |
| `roles/` authoring, promotion, bias | Brief §7, §14 | `roles/registry.ts` and `roles/evaluation.ts` are reached by `pv evaluate`; `authoring.ts`, `promotion.ts`, `bias.ts` have no importer | **PARTIALLY INERT.** Roles can be *evaluated* from the CLI. They cannot be authored or promoted by any caller. |

`knowledge/` and `timeline/` are reachable, but only through E5 (the demo) —
`demo/run.ts:11-15`. No product surface reaches either. `knowledge/store.pg.ts`
has no importer at all, so the Postgres knowledge adapter is never constructed
outside its contract test.

### 5.2 The consequence that matters most: the console API is unusable wherever it is allowed to run

This is the single most important finding of the pass, and it follows directly
from `identity/` being inert.

`actorFor` (`api/server.ts:155`) is the actor resolution every session route
uses. Its structure is:

- if `config.oidcIssuer` is set → **always throw `DeniedError`**, whether or not
  a session cookie is present (`api/server.ts:156-173`; the second branch says
  "Session verification against the configured identity provider is not wired
  into this route yet");
- else if environment is not `development` → throw;
- else → return a hard-coded `DEV_ACTOR` (`api/server.ts:71`) holding six roles.

And `loadConfig` **requires** `PV_OIDC_ISSUER` in staging and production
(`kernel/config.ts:246-270`). So the two branches close on each other:

- **In staging or production**, OIDC is mandatory, therefore `actorFor` always
  throws, therefore every session route returns 409.
- **In development**, OIDC is absent, therefore every request is attributed to
  a single fictional superuser with all six roles.

There is no third state. Reproduced against the real server with exactly the
identity configuration `loadConfig` demands:

```
GET /api/session                          -> 409  "No authenticated session."
GET /api/session  (cookie: pv_session=…)  -> 409  "Session verification … is not wired into this route yet."
GET /api/runs                             -> 409
GET /api/approvals                        -> 409
GET /api/audit                            -> 409
GET /api/health                           -> 200   (does not call actorFor)
```

There is also **no login route**: `/auth/callback` — the value `.env.example:35`
tells the operator to configure as `PV_OIDC_REDIRECT_URI` — is not in the route
table, and neither is any other `/auth/*` path.

Consequences for claims made elsewhere:

- Brief §15 "SSO against MVW's identity provider" — not reachable.
- Brief §15 "step-up re-authentication for high-consequence actions" — the
  plumbing exists (`guard/authorize.ts` takes `secondsSinceAuthentication`), but
  the API hard-codes `secondsSinceAuthentication: 0` at `api/server.ts:264` and
  `:456`, so step-up is neither measured nor enforced over HTTP.
- Brief §15 "an auditor role that sees everything and changes nothing" — the
  `readOnly` flag is computed at `api/server.ts:257`, but no actor can ever hold
  the auditor role, because `DEV_ACTOR` is a fixed list and there is no other
  source of actors.
- Brief §15 "SCIM or directory-group provisioning" — not built anywhere.
- The console's exit gate (brief Phase 4: "an MVW operator completes a real task
  unaided") cannot be attempted in any environment the platform will start in
  outside a developer's laptop.

### 5.3 Registered actions with no caller

`guard/registry.ts` refuses any action not in `actions.ts`, so the registry is
the platform's declared capability surface. 27 actions are registered
(`actions.ts:61-398`). Grepping each name outside `actions.ts` and outside test
files:

| Action | Caller | Note |
| --- | --- | --- |
| `record.read_run` | `api/server.ts` | reachable |
| `audit.read` | `api/server.ts` | reachable |
| `containment.engage` / `containment.release` | `api/server.ts:578` | reachable (also CLI, which calls the controller directly) |
| `contract.check_rescission` | `demo/run.ts:391`, `cli/evaluate.ts` | reachable via demo and evaluate only |
| `contract.flag_for_review` | `cli/evaluate.ts` | reachable via evaluate only |
| `contact.send_owner_message` | `contact/actions.ts`, `demo/run.ts:489` | the demo requests, decides, and consumes an approval for it — but **no message is ever sent**, because no outbound channel exists and `contact/gate.ts` has no reachable caller |
| `improvement.observe` | `improve/harvest.ts` | reachable via the corrections route |
| `improvement.apply` / `improvement.revert` / `improvement.apply_without_approval` | `improve/actions.ts`, `improve/approve.ts` | callers are themselves inert (§5.1) |
| `role.promote` | `roles/actions.ts`, `roles/promotion.ts` | caller is inert |
| `knowledge.ingest_document` | `knowledge/ingest.ts` | reachable via demo only |
| `document.generate_internal` / `document.generate_owner_facing` | `documents/actions.ts` | callers are inert |
| `consent.record` | `contact/actions.ts` | caller is inert |
| `identity.issue_service_credential` | `identity/service-accounts.ts` | caller is inert |
| `record.read_cost` | **none** | INERT |
| `knowledge.retrieve` | **none** | INERT — `knowledge/answer.ts` explains at its head that it deliberately does not authorize, leaving it "for the caller — the workflow engine does it before the retrieval step". The workflow engine has no caller (§5.1), so nobody ever does. |
| `timeline.compute_deadline` | **none** | INERT — `computeRescissionDeadline` is called directly at `demo/run.ts:398` without passing this action through the chokepoint |
| `model.invoke_draft` | **none** | INERT |
| `association.read_records` | **none** | INERT |
| `owner.export_data` | **none** | INERT — see gap 3 |
| `owner.delete_data` | **none** | INERT — see gap 3 |
| `discovery.enroll_device` | **none** | INERT — `discovery/enrollment.ts` raises `DeniedError` directly and never names this action |
| `model.train_on_owner_data`, `payment.capture_card`, `audit.modify_entry` | **none, by design** | Tier `prohibited`. Having no caller is the point; **not a defect.** |

### 5.4 Declared audit event types with no writer

`audit/types.ts:73-74` declares `subject_rights.request_recorded` and
`subject_rights.fulfilled`. Neither string appears anywhere else in the source.
No code path can produce either event.

---

## 6. Configuration keys

38 keys are declared in `kernel/config.ts` (schema at `:87`, environment mapping
at `:166`). Checked three ways: declared, read somewhere outside `config.ts`, and
documented in `.env.example`.

### 6.1 Declared but never read — dead keys

| Key | Declared | Read outside `config.ts`? | Consequence |
| --- | --- | --- | --- |
| `PV_OIDC_CLIENT_ID` | `config.ts:172` | **no** | Validated as mandatory in staging/production, then unused. |
| `PV_OIDC_CLIENT_SECRET` | `config.ts:174` | **no** | As above. A secret an operator must supply and nothing consumes. |
| `PV_OIDC_REDIRECT_URI` | `config.ts:175` | **no** | As above; `.env.example:35` points it at a route that does not exist. |
| `PV_EGRESS_ALLOWLIST` | `config.ts:182` | **no** | `EgressClient` (`integrations/egress.ts:235`) takes an `allowlist` in its constructor, but nothing constructs `EgressClient` outside tests. The startup warning at `config.ts:334` — "every outbound integration call will be refused" — is true only because there are no outbound integration calls. |
| `PV_EXTERNAL_JWKS_PATH` | `config.ts:202` | **no** | JWT verification reads a **per-credential** `jwksPath` (`external/credentials.ts:375`), set with `agents credential mint --jwks`. The config key reaches nothing. The warning at `config.ts:344` — "no `PV_EXTERNAL_JWKS_PATH` is configured, so platform-native JWT assertions cannot be verified" — is therefore **false**: JWT credentials verify fine without it. |
| `PV_AUDIT_RETENTION_DAYS` | `config.ts:203` | **no** | Consistent with `not-production-grade.md` S7 ("audit archival is specified but not built"), but the key gives an operator no way to know that. |
| `PV_SESSION_SECRET` | `config.ts:178` | only by `identity/session.ts`, which has no importer | Effectively dead until identity is wired. |

`PV_STEP_UP_MAX_AGE_SECONDS` is read (`api/server.ts:457`) but the value it is
compared against is a hard-coded `0`, so it never fires over HTTP.

### 6.2 Read but never documented

Every one of the eleven external-plane keys is absent from `.env.example`:

```
PV_EXTERNAL_AGENTS_ENABLED              PV_EXTERNAL_DENIAL_WINDOW_SECONDS
PV_EXTERNAL_AGENT_SEAT_CAP              PV_EXTERNAL_RUN_RECLAIM_AFTER_SECONDS
PV_EXTERNAL_AGENT_MAX_ENROLLMENT_DAYS   PV_EXTERNAL_AGENT_MAX_SPEND_CEILING_USD
PV_EXTERNAL_APPROVAL_THRESHOLD          PV_EXTERNAL_REFUSE_BEARER_WHEN_STRONG
PV_EXTERNAL_REQUESTS_PER_MINUTE         PV_EXTERNAL_JWKS_PATH
PV_EXTERNAL_DENIALS_BEFORE_CONTAINMENT
```

Nine of the eleven are genuinely load-bearing (`external/plane.ts` reads them
all). The first is the master switch for the entire capability that pull request
#1 was written to deliver. `.env.example:1-5` tells an operator it is the file
that describes configuration; an operator following it cannot discover that the
external-agent plane exists, let alone turn it on.

No duplicate keys. No key read from `process.env` outside `loadConfig` except
`PV_TEST_DATABASE_URL` (test harnesses only) and `process.env.USER` at
`cli/main.ts:128` for CLI actor attribution, which is documented in place.

---

## 7. Built but not claimed

Undocumented surface area is capability nobody reviewed, secured, or supported.

| Thing | Where | Why it matters |
| --- | --- | --- |
| `GET /api/actions` | `api/server.ts:601` | Returns the entire action registry — every action name, risk tier, human-involvement policy, reversibility, and approval count. Not in any document, not in the OpenAPI file, and not called by the console. It is authorized with `record.read_run`, the same read every operator holds, so any signed-in user can enumerate the platform's complete governance policy. Probably harmless; nobody decided that. |
| `DEV_ACTOR` holding six roles | `api/server.ts:71` | A hard-coded superuser with `platform_admin`, `compliance_reviewer`, `finance`, and three more. Documented nowhere. It is the *only* actor the API can ever produce (§5.2). |
| `/health` served unauthenticated at the unprefixed path | `api/server.ts:248` | The comment explains why, and the payload includes `warnings`, `environment`, `store`, `sandboxMode`, `discoveryEnabled`, `modelProvider`, and the containment list. That is a reasonable operational disclosure, but it is a public endpoint whose contents are not described in any assurance document. |
| `packages/platform/package.json` `main`/`exports` → `dist/index.js` | `package.json:8-12` | `src/index.ts` does not exist and `dist/index.d.ts` does not exist. Importing `@pv/platform` fails. Harmless today (nothing imports it), and a trap for the next person. |
| Console `Denial` view | `packages/console/src/views/Denial.tsx` | Real, tested, accessible, and absent from the operator guide's list of screens. |

---

## 8. Claims checked against reality, by source

### 8.1 README

| Claim | Where | Reality |
| --- | --- | --- |
| Clone to running in under 15 minutes | README:19-42 | Holds. `pnpm test` and `pnpm demo` both work from a clean environment. |
| "`pnpm demo` runs a complete governed workflow — intake, retrieval …, **a model call**, a human approval, a governed action, and the audit record" | README:33-35 | **False in two places.** There is no model call: `demo/run.ts` imports nothing from `models/`, and `GroundedAnswerService` (`knowledge/answer.ts`) never invokes a provider — by design, it returns an evidence set rather than prose. And there is no *workflow*: no workflow instance is created, because `engine/` is inert (§5.1). Everything else in the sentence is accurate. |
| "Then verify the audit chain the demo just wrote: `pnpm audit:verify`" | README:38-42 | **False.** The demo runs with `PV_STORE=memory`, hard-coded at `demo/run.ts:109`. The chain dies with the process. Verified by running both in sequence: `Audit chain is empty. Nothing to verify.` — **exit code 0.** A verification command reporting success over an empty chain, in a product whose thesis is that the record is true, is the sharpest instance of gap 2 below. |
| `packages/platform/src/workflows/  the shipped workflow definitions` | README:95 | **The directory does not exist.** Neither does any `WorkflowDefinition` value outside `engine/` and its tests. Repeated by `architecture.md` (layer 5, and §5 "Add a workflow → `workflows/`") and by `architecture.test.ts:65`, which assigns layer 5 to a directory with no files — so the layering rule for it is vacuously true. |
| The eight ideas (fail closed, one chokepoint, fingerprints not payloads, digest-bound approvals, containment at every step, deadlines from data, human-gated improvement, autonomy ladder) | README:110-149 | Each is implemented in the module named, and each has substantial tests. Reachability varies — see the gap table. Idea 8's four modes are enforced in `guard/authorize.ts`, but only `supervised` is ever passed from any entry point. |
| Deliberate absences, each with an ADR | README:153-165 | True. Each of the six has a matching ADR, and none of the absent things is present. |
| Common commands table | README:187-196 | Every `pnpm` alias resolves and runs. |

### 8.2 Program brief — the capability sections

| § | Capability | Reachable path | Verdict |
| --- | --- | --- | --- |
| 5.1 | Operating record | `record/store.{memory,pg}.ts` via `platform.ts:152/161`; read by `GET /api/runs` | **Reachable** |
| 5.2 | Tamper-evident audit log + verify command | `audit/log.ts` via `platform.ts:154`; `pv audit verify` (`cli/main.ts:156`); `GET /api/audit/verification` | **Reachable** |
| 5.3 | Approvals: digest-bound, single-use, N-of-M, SoD, expiry | `guard/approvals.ts` via `platform.ts:155`; `POST /api/approvals/:id/decisions` | **Reachable.** Step-up is not (§5.2). |
| 5.4 | Ceilings at consumption | `guard/ceilings.ts` via `platform.ts:168` | **Reachable** |
| 5.5 | Boundary screen, erroring screen denies | `guard/screen.ts`, called by `knowledge/ingest.ts`, `models/invoke.ts`, `external/admission.ts` | **Reachable** on the external plane and in the demo; not on any console path |
| 5.6 | Sandbox, unsafe mode flagged | `guard/sandbox.ts` via `platform.ts:191`; surfaced in `/health` and `pv health` | **Reachable** |
| 5.7 | Per-action authorization chokepoint | `guard/authorize.ts` via `platform.ts:181` | **Reachable** |
| 5.8 | Containment: global, workflow, role, integration | `pv containment engage`; `POST /api/containment` | **Reachable.** Note: "per-workflow" and "per-role" switches can be engaged but nothing consults them for native work, because no workflow or role executes. |
| 6 | Workflow engine — declarative, durable, resumable, nine step types, compensation, SLAs | `engine/` | **INERT.** Built and heavily tested; no caller. |
| 7 | Role factory: authoring, promotion with evidence, versioning | `roles/` | **PARTIAL.** `pv evaluate` measures promoted roles. Nothing can author or promote one. |
| 8 | Knowledge layer: corpora, provenance, citations, effective dating, governed ingestion, freshness, no-grounding-no-answer | `knowledge/` via `demo/run.ts` only | **Demo-only.** No console or API surface reads a corpus. |
| 9 | Documents: versioned templates, governed generation, bound to the record | `documents/` | **INERT.** |
| 10 | One outbound contact gate, consent as first-class data | `contact/` | **INERT.** Correctly built *before* the first channel, as the brief demands — but no channel exists, so the gate has never gated anything outside its tests. |
| 11 | Integrations: narrow ports, fakes, contract tests, egress allowlist, explicit degradation | `integrations/` | **INERT.** |
| 12 | Work discovery, privacy-first, off by default | `discovery/` | **INERT by design** (ADR 0012). Correct. |
| 13 | Improvement loop, seven stages, human-gated | `improve/` | **PARTIAL.** Stage 1 reachable via the corrections route. Stages 2–7 inert. |
| 14 | Model governance: inventory, eval harness, change control, bias testing, degradation | `models/`, `roles/evaluation.ts` | **PARTIAL.** `pv evaluate --ci` is a real, honest gate — it prints exactly what it did and did not measure. Bias testing (`roles/bias.ts`) has no caller. |
| 15 | Identity: SSO, SCIM, roles, step-up, service accounts | `identity/` | **INERT — and blocking.** See §5.2. |
| 16 | Assurance artifacts | `docs/assurance/` — 12 documents | **Present.** One (`subject-rights-runbook.md`) documents tooling that does not exist. |
| 17 | Reliability, ops, cost | `docs/ops/` — 5 documents; `/health`; `pv health` | **Documents present; drills not run**, honestly recorded in `not-production-grade.md` B3–B5. |
| 18 | Console | `packages/console/` | **PARTIAL.** 9 of 17 routed screens have a server route; the rail cannot draw itself (§4.1); the copilot does not exist (§4.2). |
| 19 | Autonomy ladder as four real modes | `guard/authorize.ts` | **PARTIAL.** Enforced where called; only `supervised` is ever passed. |
| 20 | What not to build | — | **Honoured.** No marketplace, no self-modification, no dreaming, no plugins, no multi-tenancy, no card data. |

### 8.3 Architecture

| Claim | Reality |
| --- | --- |
| One chokepoint every action passes | True for every action that is called. `architecture.test.ts` enforces the import layering, and the layering holds. |
| Layer 5 = `workflows` | The directory does not exist (§8.1). |
| "Nothing reads the wall clock" outside `kernel/clock.ts`, enforced by a test | Verified — `architecture.test.ts` asserts it and passes. |
| Ports with two adapters and one contract suite, including concurrency | Verified by running it: 62 suites against memory **and** 62 against Postgres. Genuine. |
| `MemoryDb` has a real mutex | True (`store/db.ts`), and the concurrency tests exercise it. |
| §5 "Add a workflow → `workflows/`" | Points at a directory that does not exist. |
| §5 "Stop something right now → Containment CLI" | True, verified. |
| §5 "Add a console view → `packages/console/src/views/` and an accessibility assertion, or CI fails" | True; `tools/check-accessibility-coverage.mjs` reports 18/18 and is wired into CI at `.github/workflows/ci.yml`. |

### 8.4 Design specification

Foundations (tokens, spacing, radius, elevation, colour, glass, motion) are
implemented in `packages/console/src/theme/tokens.ts` and
`src/ui/surfaces/glassSurface.tsx`, with tests. The component list in §4 is
complete: every primitive, composite, and chart wrapper named there exists under
`src/ui/`, each with an axe assertion.

The apparent contradiction between design-spec §1.5 (glass is the signature) and
program-brief §18 ("no glass or blur experiments") is **not** an inconsistency in
the build: ADR 0017 records the reversal explicitly and marks ADR 0014
superseded in part. Nothing to do here.

Not built: the copilot (§4.2), the low-code configuration screens of §3.7
(Current → Draft → Diff → Impact → Publish — a `DiffView` component exists, no
screen uses it), and the §7 performance budgets, which are not measured anywhere
in CI.

### 8.5 Handover and assurance documents

| Document | Claim | Reality |
| --- | --- | --- |
| `handover/operator-guide.md:101` | "Workflow instance — for supervisors. Where a piece of multi-step work is…" | No server route; no workflow ever exists (§5.1). |
| `handover/operator-guide.md:164` | "Executive view — the metrics MVW management named publicly" | No server route. |
| `handover/operator-guide.md:150` | "**Two buttons you will actually use.** *Contain* … *Revoke* …" on the external-agents screen | Neither exists. The console client has no contain/revoke method and no route serves one. Both actions are **CLI-only** (`pv agents contain|revoke`). |
| `handover/admin-guide.md:95-113` | An administrator describes a job in plain language, the platform drafts a role, promotion requires evidence | `roles/authoring.ts` and `roles/promotion.ts` have no caller and no surface. |
| `handover/admin-guide.md:123` | "Approving an improvement" | Stages 2–7 inert (§5.1). |
| `handover/admin-guide.md:221` | "Roles come from directory groups, so access follows the HR lifecycle" | Nothing reads a directory group. Roles come from a hard-coded array (`api/server.ts:71`). |
| `assurance/subject-rights-runbook.md:25,42,79,102` | Four `pv subject-rights` verbs | **None exists** (§3.1). The two audit events the runbook says are written are declared and never emitted (§5.4). The two registered actions behind it, `owner.export_data` and `owner.delete_data`, have no caller. |
| `assurance/security-questionnaire.md:103` | "Yes" to working subject-rights handling, citing the runbook | The citation is to a document describing tooling that does not exist. |
| `handover/not-production-grade.md` | 6 blockers, 8 significant gaps, 16 known limits | **Genuinely excellent and largely accurate** — B1–B6 and S1–S7 are all confirmed. It is silent on every gap in the table below except the discovery one. |

### 8.6 Merged pull request #1

The PR's own verification table is accurate for what it measured: 1,680 platform
tests (now 1,737), Postgres contract tests genuinely run, typecheck and lint
clean, 17/17 accessibility (now 18/18), demo determinism, SBOM. Its "what is
honestly not finished" section (L11–L16) is confirmed correct.

Two things it says that this pass could not confirm as stated:

- "**Operator surfaces.** Console roster and detail …, `agents` CLI verbs so a
  headless install is fully operable" — the CLI half is true and complete. The
  console half is read-only: no contain, no release, no revoke, no credential
  action. "Fully operable" is true of the CLI and of nothing else.
- The PR body carries the trailer `_Generated by [Claude Code](…)_`. The program
  brief §1 forbids AI attribution in commits, PR titles or bodies, code
  comments, and docs. This is on the merged record.

---

## 9. The gap list

Ranked by consequence to MVW, not by effort. This table is what the rest of the
review is prioritised against.

| # | Gap | Where | Consequence | Class |
| --- | --- | --- | --- | --- |
| **1** | **The console API refuses every request in any environment the platform is permitted to run in.** With `PV_OIDC_ISSUER` set — mandatory in staging and production — `actorFor` always throws; without it, staging and production will not start. There is no login route. `identity/` is inert. | `api/server.ts:155-185`; `kernel/config.ts:246-270`; `identity/*` | The entire operator console is unreachable outside a developer laptop. Phase 4's exit gate cannot be attempted. Every access-control claim in brief §15 — SSO, SCIM, the auditor role, step-up — rests on this. | Claimed, not built |
| **2** | **`pnpm audit:verify` after `pnpm demo` reports success over an empty chain, exit 0**, exactly as the README instructs. | `README.md:38-42`; `demo/run.ts:109` | In a governance product the record's truthfulness is the product. A verifier that says "nothing to verify" and exits 0 where a document promised it would check something is the most dangerous shape of defect this codebase can have. | False claim |
| **3** | **Subject-rights handling does not exist.** Four documented CLI verbs, two declared audit events, and two registered actions, with no implementation and no caller. | `assurance/subject-rights-runbook.md`; `audit/types.ts:73-74`; `actions.ts:202,223` | Brief §4 lists "working subject-rights handling" in the definition of done, and `security-questionnaire.md` answers "yes" citing this runbook. A buyer's privacy reviewer will ask for a demonstration on the first call. | Claimed, not built |
| **4** | **The workflow engine has no caller.** No entry point, console route, CLI verb, or the demo constructs a workflow instance. `workflows/` does not exist despite three documents naming it. | `engine/*`; `README.md:95`; `architecture.md` layer 5 and §5 | Brief §6 is a whole section of the charter. Every claim about durable, resumable, compensating, SLA-bearing multi-step work is untested against a real caller. The console's Workflow-instance screen can never have data. | Claimed, not built |
| **5** | **The outbound contact-compliance gate has no caller**, and neither does document generation. | `contact/*`; `documents/*` | Brief §10 calls this "the highest-liability surface in the product". Building it before the first channel was right; the risk is that nobody notices the wiring is absent when a channel is added. | Inert |
| **6** | **Improvement-loop stages 2–7 have no caller.** Harvest is reachable; cluster, propose, evaluate, approve, apply, watch are a closed clique. | `improve/{cluster,propose,evaluate,approve,apply,watch}.ts` | Brief §13 and Phase 5's exit gate (observation → proposal → evaluated → approved → applied → reverted, all in the audit log) cannot be walked. | Inert |
| **7** | **The navigation rail hides nine of eleven items for any real session.** Console capability strings and registry action names are different vocabularies. | `packages/console/src/routes.tsx:114-249` vs `api/server.ts:266` | An operator signs in and sees two links. Invisible to both suites — the console tests use a fake session and the platform tests never read `routes.tsx`. | Built wrong |
| **8** | **Seven routed console screens have no server route** — workflow instance, roles, role detail, improvements, improvement proposal, discovery, executive. | `console-contract.test.ts:47-56` (the ratchet that tracks them) | Honestly ratcheted in the test, but two of them are described as working in `operator-guide.md`, and the executive view is a named brief §18 surface tied to the earnings story. | Claimed, not built |
| **9** | **The identity module is not the only inert one: `integrations/` and `roles/` authoring+promotion+bias have no caller either.** | `integrations/*`; `roles/{authoring,promotion,bias}.ts` | Brief §7 ("MVW must be able to add capability without an engineering cycle") and §11 have no reachable path. Bias testing — brief §14, and a regulator-facing claim — has never run outside its own test. | Inert |
| **10** | **Eleven configuration keys are undocumented**, including `PV_EXTERNAL_AGENTS_ENABLED`, the master switch for the whole external-agent capability. | `kernel/config.ts:192-202` vs `.env.example` | An operator reading the file the repository points them at cannot discover the capability exists, let alone enable it. | Undocumented surface |
| **11** | **Six configuration keys are declared and never read** — `PV_OIDC_CLIENT_ID`, `PV_OIDC_CLIENT_SECRET`, `PV_OIDC_REDIRECT_URI`, `PV_EGRESS_ALLOWLIST`, `PV_EXTERNAL_JWKS_PATH`, `PV_AUDIT_RETENTION_DAYS`. | `kernel/config.ts` | Two of them produce **misleading startup warnings**: the egress warning implies a control is active, and the JWKS warning states JWT assertions cannot be verified when in fact they can (verification uses a per-credential path). A warning that is wrong is worse than no warning. | Dead config |
| **12** | **The operator guide describes Contain and Revoke buttons on the external-agents screen that do not exist.** | `handover/operator-guide.md:150-158` | The one capability MVW was told is fully operable is read-only in the console. Both actions work from the CLI, which the guide does not say. | False claim |
| **13** | **README says the demo makes a model call and runs a workflow.** It does neither. | `README.md:33-35` | Overstates what a prospective buyer sees in the first five minutes. | False claim |
| **14** | **Nine registered actions have no caller** (excluding the three `prohibited` ones, whose absence is correct): `record.read_cost`, `knowledge.retrieve`, `timeline.compute_deadline`, `model.invoke_draft`, `association.read_records`, `owner.export_data`, `owner.delete_data`, `discovery.enroll_device`, plus `contact.send_owner_message` which is approved in the demo and never consumed. | `actions.ts` | `knowledge.retrieve` and `timeline.compute_deadline` are the notable ones: the two highest-consequence reads in the product are never passed through the chokepoint by any caller, so an operator's containment switch has no reach over either. | Inert |
| **15** | **Step-up re-authentication is never enforced over HTTP.** `secondsSinceAuthentication` is hard-coded to `0` at both call sites. | `api/server.ts:264,456` | Brief §15 requires step-up for approving a role promotion or improvement proposal, issuing credentials, and exporting owner data. `PV_STEP_UP_MAX_AGE_SECONDS` is read and compared against a constant. | Built wrong |
| **16** | **`@pv/platform` cannot be imported.** `main` and `exports` point at `dist/index.js`; no `src/index.ts` exists. | `packages/platform/package.json:7-11` | Harmless today; a trap for the next engineer, and a broken claim in the package manifest handed to MVW. | Built wrong |
| **17** | **`pv db status` is documented in the CLI's own help and not implemented.** | `cli/main.ts:28` vs `:134` | Small, certain, and exactly the kind of drift a command-surface listing exists to catch. | Claimed, not built |
| **18** | **`GET /api/actions` is undocumented.** It returns the full governance policy — every action, risk tier, and approval requirement — to any signed-in reader. | `api/server.ts:601` | Probably acceptable; nobody decided it, it is in no document, and it is not in the OpenAPI contract. | Undocumented surface |
| **19** | **The merged PR body carries an AI-attribution trailer.** | PR #1, final line | Direct breach of the program brief's one hard rule (§1), on the permanent record MVW receives. | Process |
| **20** | **Design-spec §7 performance budgets are not measured anywhere.** No CI job, no harness, no recorded number. | `.github/workflows/ci.yml` | Definition-of-done item 7 for every screen. Currently unfalsifiable. | Claimed, not measured |

### What is genuinely, verifiably reachable and correct

Stated plainly, because the table above is long and the picture is not uniformly
bad. These were each traced to an entry point and exercised:

- The governance spine — record, audit chain and its verifier, digest-bound
  single-use N-of-M approvals with segregation of duties, consumption-time
  ceilings, containment at every action boundary, the action registry and the
  chokepoint.
- **The entire external-agent plane.** Enrollment, four credential kinds, the
  admission chain, screen/report/live-run/execute, the heartbeat kill switch,
  per-agent rate limiting and denial-driven containment, the console roster and
  detail read paths, eleven CLI verbs with no drift from their usage text, and a
  published OpenAPI contract that **matches the implementation exactly**. This
  is the most complete capability in the repository by a wide margin.
- Ports and adapters with one contract suite run against both, concurrency
  included, verified running on real Postgres.
- The seeded demonstration, deterministic and honest about its refusals.
- `pv evaluate --ci`, which states on every run precisely what it did and did
  not measure.
- The design system: tokens, every component named in design-spec §4, both
  themes, three preferences, and 18/18 accessibility assertions enforced in CI.
- `docs/handover/not-production-grade.md`, which is a better honest-limits
  document than most shipped products have.

---

## 10. Questions for the owner

Per rule of engagement 4, these are not decided here.

1. **Gap 1 is architectural.** Wiring `identity/` into `api/server.ts` means
   choosing a session strategy (cookie contents, storage, revocation on role
   change, logout) and adding `/auth/login` and `/auth/callback` routes. Is that
   in scope for this review pass, or does it belong to whoever is rebuilding the
   console?
2. **Gap 7 is a vocabulary decision.** Either the console adopts registry action
   names (`record.read_run` in place of `work.read`), or `/api/session` emits a
   coarser capability vocabulary the rail can use. The second is probably right —
   `work.read` is a *surface*, not an action — but it changes the API contract,
   and `packages/console/src/routes.tsx` is in a package other agents are
   actively rebuilding. Which side should move, and may this pass touch
   `routes.tsx`?
3. **Gaps 4, 5, 6, 9 are the same question asked four times:** is the intent that
   these modules ship inert against a future caller, or is a caller missing? If
   the former, `not-production-grade.md` should say so for each — it currently
   says it only for discovery. If the latter, that is a build task, not a review
   task.
4. **Gap 3 touches a compliance rule.** Should the subject-rights runbook be
   corrected to describe a manual procedure, or should the four CLI verbs be
   built? A privacy commitment documented but not implemented is worse than one
   not yet documented, so something must change before this is shown to a buyer.
5. **Gap 11's two misleading warnings** (egress, JWKS) are small and certain, and
   I would correct the JWKS warning text and delete or wire the egress key. Both
   touch operator-facing safety messaging — confirm before I edit.
6. **Gap 19** is on GitHub, not in the tree. Amending a merged PR body is a
   decision for the repository owner, not something this pass should do.

---

## 11. Method, so this can be re-run

- **Import graph and reachability**: parsed every `from "…"` and dynamic
  `import("…")` in `packages/platform/src`, resolved `.js` specifiers to `.ts`,
  and took the transitive closure from `cli/main.ts`. Dynamic imports are
  included, which is why `agents`, `evaluate`, `serve`, and `demo` count as
  reachable.
- **Route table**: built the real server with the plane enabled and read
  Fastify's `onRoute` registry, rather than reading the source. The dump agreed
  with the source; recording it here means a future run can diff.
- **Action callers**: grepped each registered action name across all `.ts` files,
  excluding `actions.ts` itself and every `*.test.ts`.
- **Config keys**: cross-referenced the `ENV_KEYS` map in `kernel/config.ts`
  against `.env.example` and against `config.<field>` reads outside `config.ts`.
- **Claims**: read the README, all 17 ADRs, all 12 assurance documents, all 5 ops
  documents, all 5 handover documents, the design specification, the program
  brief, the external-agent documentation set, and the merged pull request #1.
- **Reproductions**: gaps 1, 2, 7, 10, 11, and 17 were each confirmed by running
  the real code, not by reading it. Gaps 4, 5, 6, 9, and 14 rest on the import
  graph and on grep, both re-runnable.

### What this pass deliberately did not do

- It did not touch `packages/console/src/views/**`, `src/ui/**`, `src/shell/**`,
  or `src/theme/**`.
- It made no code changes at all. Pass 0 establishes reality; the fixes belong to
  the passes that follow, and four of the top six gaps need an owner's decision
  first.
- It did not judge whether any reachable thing is *correct*. A capability can be
  reachable and still wrong; that is Pass 2 onward.
