# Triple-check — the full finding list

## Resolution log

Fixes are landing in waves; each finding keeps its number so this document
stays a stable index. Verified means an operator path was driven, not that a
test passed.

**Wave 1 — the false claims and the blockers. All six resolved and verified.**

- **T-01 / critic §1 — an approval could be rejected but never granted.** Real
  session age from the development identity provider; `requiresStepUp` declared
  per action by risk tier; a `pv approvals decide` verb. A human who has
  authenticated can now grant; one who has not still cannot. (commit: an
  approval can be granted)
- **critic §2 / R-07(b) — the demo narrated a step-up that never happened.** It
  now refuses the grant, records a real `identity.step_up_completed`, grants,
  and says the dev provider stood in for the IdP.
- **R-01 — secret scanning scanned zero bytes.** Full tree and history with a
  pinned, checksummed gitleaks; confirmed it flags a planted key.
- **T-04 — configuring an IdP broke every request.** A valid session is now
  honoured whatever minted it; a session-less request under a configured issuer
  is refused, not downgraded to the dev actor. Residual: the OIDC
  authorization-code callback still needs a real issuer to build against.
- **T-68..71 — AI attribution had no guard.** `tools/check-attribution.mjs`
  fails CI on an authorship claim in the tree or the commit range, and does not
  fire on the vendor/model names the product operates on. Both PR bodies were
  stripped by hand.
- **R-04 — two authorization chokepoints disagreed.** The external chokepoint
  refused an unrated tool grant, at enrollment and again in admission, with the
  same `authorization.risk_unclassified` the internal registry uses.

**Wave 2 — the external plane no longer misgoverns. Eight findings.**

- **R-08(b)** — a completed report under a high-rated tool now reaches the record instead of being refused for a before-the-fact approval it does not need.
- **R-09 / R-10** — the approver of a governed write now sees it labelled as an external agent's and sees the write's own fields (an amount, an owner id); free text is digested because the subject is chained. Lossless digest-matched preview is a bounded residual.
- **R-11** — releasing a contained agent now clears its denial ledger, so it does not re-contain on the next denial.
- **R-05** — the per-role containment switch now actually stops work under that role, instead of showing ENGAGED and halting nothing.
- **R-06** — an over-ceiling discovery retention value now refuses at startup, as its comment always claimed.
- **R-07(a,d)** — the demo genuinely selects an earlier rule version (effective-dating), and its entrypoint guard is exact so it cannot double-fire.
- **R-12** — revocation's inability to reach an in-flight run on vendor infrastructure is now stated honestly rather than overclaimed.

**Wave 3 — the console migration finished, the layer collision removed.**

- **T-25 / design lens** — six views (WorkQueue among them) plus ResourceView still used `src/components`, a duplicate of the design system. They are migrated; `src/components` is deleted — one component library. Where the design system's virtualised table could not carry a per-row guarantee, the view keeps a semantic table inlined, the earlier migration's own escape hatch.
- **The `.pv-panel` collision** — `.pv-panel` was defined in both `src/ui/surfaces/Panel.css` and `src/screens.css`, and the second forced its glass and padding onto every design-system Panel. The dead scaffolding rules are removed; `.pv-panel` is the design system's alone.
- **`src/screens.css` stays** — it is the shared view scaffolding (layout, honest-absence and denial-tone classes, semantic-table styling), not a component library, and no `src/ui` class replaces it. My "two libraries" framing was half-wrong; the real duplicate was `src/components`, now gone.

Console 1,389 tests, tsc/lint clean, accessibility 18/18, bundle within budget. Not re-verified: a live browser render of the migrated panels (servers were flaky in the fix environment); the collision removal is confirmed structurally — `.pv-panel` single-defined — and by the full suite.

**Wave 4 — the role factory is reachable. T-09, and critic §6.**

- **T-09 / critic §6 — the role factory was built and inert; `pv evaluate --ci` reported that nothing in the registry had ever been evaluated because nothing could be.** The factory is now composed at the root and exposed on `Platform`, the lifecycle actions are registered in the one chokepoint, and `pv roles` (list, show, draft, golden publish, propose, promote, revert, disable, enable) reaches the real services with no rule re-implemented. Driven by hand against a fresh Postgres store, author → propose → approve(by a different person, real session, step-up observed) → promote → evaluate works end to end; promotion refuses without evidence, without a granted approval, and without the promoter's re-authentication; disable/enable is instant through containment. `pv evaluate --ci` now evaluates the promoted role and the banner is gone; disabling it brings the banner back. Residual: the read API routes (GET /api/roles) and the bias caller (T-10) are out of this wave, and a promoted role can act only in shadow until a widen verb exists.

Platform 79 files / 2,007 tests, tsc/lint clean, no AI attribution, all Postgres contract suites active. Verified by driving the CLI and the eval gate against a real store, not by the suite alone.

**Wave 5 — the bias analysis is reachable. Part of T-10.**

- **T-10 (bias half) — `analyseFairness` was built and had no caller.** `pv roles fairness` now reads a recorded evaluation run and measures outcome-rate disparities across protected groups, flagging the ones past the four-fifths rule. Driven against Postgres: parity reported when cohorts match, a cohort flagged when its cases fail; a non-synthetic run is refused; the analysis measures and does not gate, and prints the caveats with the numbers. Four tests added to `roles.test.ts`. Residual (unchanged): no workflow sequences real consumers into it yet, provider terms and change-control artifacts and the max_tokens-truncation finding all still stand — see T-10.

**Wave 6 — the contact-compliance gate is reachable, and a permissive timezone read is closed. T-11 and L18.**

- **T-11 — the outbound contact gate was built and inert.** `buildPlatform` now composes `ContactGate` + `ConsentLedger` on one shared store and registers `CONTACT_ACTIONS`; `pv contact` (consent grant/revoke/state, dnc add, check, send) reaches the real services. Driven against Postgres by two independent parties on separate fresh DBs: no-consent blocks, consent unblocks, quiet hours block on the recipient's real clock, a do-not-call entry blocks even with consent, an allowed send records and an idempotent replay is recognised. **L18 closed:** `isKnownTimeZone` refuses the frozen-offset aliases (`EST`, `MST`, `HST`, `GMT`) and the `Etc/*` namespace, reproduced-first and fail-closed, with `Singapore`/`Japan`/`Iceland`/`UTC` still resolving. Residual: no real outbound channel, no contact API route or console surface yet — see T-11. Platform 80 files / 2,025 tests, tsc/lint clean, no existing test weakened.

**Wave 7 — the knowledge layer is reachable. T-08.**

- **T-08 — the knowledge layer was reachable only from the demo.** `buildPlatform` now composes the `KnowledgeStore` and the four services (`IngestionService`, `Retriever`, `GroundedAnswerService`, `FreshnessMonitor`) over one shared store and registers `KNOWLEDGE_ACTIONS`; `pv knowledge` (corpus create, ingest, ask, freshness, review) reaches the real services. Driven against Postgres by two independent parties on separate fresh DBs: an ingested document screens clean and chunks; a grounded question is answered with a citation carrying full provenance; an ungrounded question is refused `knowledge.no_grounding` with no answer; an actor without the corpus scope is refused; a stale corpus is refused `knowledge.stale_authority` and a step-up-attested review reopens it; a poisoned document is refused at the ingestion screen. Residual: no HTTP route or console surface yet — see T-08. Platform 81 files / 2,035 tests, tsc/lint clean, no existing test weakened.

**Wave 8 — the workflow engine runs a real flow, and Phase 2's restart gate is demonstrable. T-06.**

- **T-06 — no work ever entered the engine; the composition root shipped an empty catalogue.** The platform now ships one built-in flow, `rescission.intake` v1 (a `WorkflowDefinition` literal with a model_call, a **timer** (`statutory_rescission`), a **human_task** for a compliance reviewer with an SLA, and an automated_action). `buildPlatform` publishes it and registers its handlers; `pv workflow` (definitions, start, show, tasks, complete-task, signal) reaches the real engine. **Phase 2's gate — a multi-step workflow with a human task and a timer surviving a process restart — now reproduces in the product**, driven by hand and independently by the verification agent across ~8 separate one-shot OS processes coordinating only through the Postgres row: start → `pv worker` fires the timer and parks on the human task → a stranger role is refused → a compliance reviewer completes the task in a different process → `succeeded`, deadline computed. A vitest test proves it again at the composition root (a second engine over the same store finishes what the first parked). Residual: no HTTP route (`GET /api/workflows/:id`), no console instance view, no publish-from-file verb, `signal` unexercised by the shipped flow, and the statutory timer needs `PV_REQUIRE_VERIFIED_STATUTORY_RULES=false` (T-07) — see T-06. Platform 82 files / 2,041 tests, tsc/lint clean, no existing test weakened.

---


Audited at `c38da93`. **146 claims: 65 DONE, 79 PARTIAL or NOT_DONE.** 13 DONE verdicts did not survive adversarial refutation.

Six independent auditors, each told to assume nothing was done and to accept a claim only with a file:line plus the test that would fail if it stopped being true. Every high-stakes DONE was then handed to a separate agent whose job was to refute it, defaulting to refuted when uncertain. A completeness critic then asked what none of the six had covered.


---

## Not done, or done in part


### T-01  [PARTIAL] (brief)

**Claim.** §5.3 Human approvals with dual control — bound to a proposal digest, N-of-M, segregation of duties, single-use, expiring; §15 step-up re-authentication for high-consequence actions


**Gap.** Step-up cannot be satisfied over HTTP. api/server.ts:175 `secondsSinceAuthenticationFor` returns `undefined` unconditionally, and :557 passes that into `decide`, so approvals.ts:195 refuses every grant of an action whose descriptor sets requiresStepUp (defaulted to true at server.ts:540). The console's approvals queue can therefore reject but not grant a high-consequence action. The failing-closed choice is correct and deliberately commented, but the capability is not reachable until identity is wired (see §15). No test asserts the end-to-end HTTP grant, because it cannot succeed.


### T-02  [PARTIAL] (brief)

**Claim.** §5.4 Ceilings — spend, rate and time — enforced at consumption, not only at a pre-flight check


**Gap.** `consume()` — the at-consumption half — has exactly two callers: models/invoke.ts:393 (reachable only through `pv evaluate`) and engine/runner.ts:1332/:1409 (the engine is never started, see §6). No HTTP path consumes a ceiling, because no HTTP path spends money. Rate window and reservations are per-process, so a multi-instance deployment exceeds the intended rate by roughly the instance count (documented, not fixed: not-production-grade.md S5).


### T-03  [PARTIAL] (brief)

**Claim.** §5.6 A sandbox for code or command execution, containment boundary configurable, unsafe setting loudly flagged at startup and in the health check


**Gap.** Nothing is ever sandboxed. `sandbox.execute(...)` has no caller in production source — grep for `platform.sandbox` returns only health-reporting reads at api/server.ts:302,305 and cli/main.ts:467-469. The platform has no code-execution or command-execution feature, so the boundary guards an empty room.


### T-04  [NOT_DONE] (brief)

**Claim.** §15 Identity and access — SSO via OIDC/SAML against MVW's IdP, SCIM or directory-group provisioning, service accounts, step-up re-authentication


**Gap.** Worse than inert: api/server.ts:179-197 makes the whole API unusable the moment an IdP is configured — with PV_OIDC_ISSUER set, `actorFor` throws DeniedError 'Session verification against the configured identity provider is not wired into this route yet' on every request, and without it the server refuses outside development (:199-206). So the console has exactly one working identity: the hard-coded DEV_ACTOR holding all six roles (server.ts:71-82), in development only. No SCIM or directory-group sync of any kind. No step-up (see §5.3).


### T-05  [PARTIAL] (brief)

**Claim.** §15 Tenancy — single customer, no multi-tenancy, but a clean data-scoping seam kept


**Gap.** Inert on every console read: the /api/runs, /api/approvals and /api/audit handlers pass an action and an actor and no requiredScopes, so the check compares against nothing. Self-reported at not-production-grade.md S11. Not currently exploitable only because a Run carries no scope — which is exactly the condition that will change first.


### T-06  [RESOLVED via CLI (wave 8); no HTTP route / console instance view residual]

**Claim.** §6 The workflow engine — declarative versioned definitions, version-pinned instances, durable and resumable, idempotent steps, nine step types, compensation, SLAs and escalation, observable by non-engineers


**Gap.** No work ever enters it. `catalogue.publish` has exactly one caller (runner.ts:249, the engine's own publish method) and `engine.start`, `handlers.register`, `engine.completeHumanTask` and `engine.signalEvent` have no caller at all outside tests. No WorkflowDefinition literal exists anywhere in non-test source. The composition root deliberately starts with an empty catalogue and empty handler registry (platform.ts:134-138). The console cannot show an instance either: GET /api/workflows/:id is unimplemented — I got a live 404 — and it is on the ratchet list at api/console-contract.test.ts:55. So Phase 2's gate (a multi-step workflow with a human task and a timer surviving a process restart) is proven in engine.test.ts and cannot be demonstrated in the product.


**Resolution (wave 8, commit "pv workflow — the engine runs a real flow, and it survives a restart").** The platform now ships one built-in flow, `rescission.intake` v1 (`src/workflows/rescission-intake.ts`, authored with `defineWorkflow`, validated at module load): `screen_packet` (model_call) → `await_deadline` (timer, `kind: statutory_rescission`) → `compliance_confirm` (human_task for a `compliance_reviewer`, SLA + two escalations) → `record_outcome` (automated_action). It carries both Phase-2 primitives — a human task and a timer. `buildPlatform` publishes it into the catalogue and registers its two handlers (which invent no effect — the engine authorizes `model.invoke_draft` and `contract.flag_for_review` at the one chokepoint and records each step). `pv workflow` adds definitions, start, show, tasks, complete-task, signal, each through the real engine. **Phase 2's gate now reproduces in the product**, driven by hand and independently by the verification agent, each on a fresh Postgres DB with its own contract id and dates: across ~8 separate one-shot OS processes coordinating only through the Postgres row, an instance is started, `pv worker` fires the statutory timer and parks it on the human task, a stranger role is refused (`authorization.action_not_permitted`, exit 1), a `compliance_reviewer` completes the task in a different process, and the instance reaches `succeeded` with the deadline computed (FL, ten days). The same instance survived every process boundary with nothing in any heap — the restart gate. A vitest test proves it again at the composition root (a second engine over the same store finishes what the first parked). **Residual, stated plainly:** GET /api/workflows/:id is still unimplemented (the engine is reachable from the CLI and the sweep, not from HTTP); there is no console instance view; no CLI verb yet publishes an operator's own definition from a file; the shipped flow has no `wait_for_event` step, so the `signal` verb is present but unexercised by the flow; and the statutory timer computes a real date only under `PV_REQUIRE_VERIFIED_STATUTORY_RULES=false` (B1/T-07 — the rules corpus is still placeholder).


### T-07  [PARTIAL] (brief)

**Claim.** §6 The statutory time module — one tested module, per-state rules as data, timezone handling, business-day rules, tolling, never naive date arithmetic


**Gap.** Every rule is an unverified placeholder — rules.ts:1-38 says so in a banner, every row carries verified:false and a PLACEHOLDER citation, and the `placeholder()` constructor makes it structurally hard to mark one verified. With the default configuration a real deployment therefore refuses every deadline; the demo has to override the switch to show the engine at all (demo/run.ts:466). Separately, the declared `timeline.compute_deadline` action has no caller — the demo calls computeRescissionDeadline directly, so this computation does not pass the authorization chokepoint. Blocker B1 in docs/handover/not-production-grade.md.


### T-08  [RESOLVED via CLI (wave 7); no HTTP route / console surface residual]

**Claim.** §8 The knowledge layer — curated corpora with owners, provenance on every chunk, citations in output, effective-dating, governed screened ingestion, freshness/review, no answer without grounding


**Gap.** Reachable from exactly one place — the seeded demonstration (demo/run.ts:155-174 constructs IngestionService, Retriever and GroundedAnswerService itself). platform.ts composes none of them; there is no HTTP route and no CLI verb for ingesting a document, asking a regulated question, or reviewing a stale corpus. The `knowledge.retrieve` action is registered (actions.ts:80) with no caller. So an operator cannot use the knowledge layer in the product; a demo script can.


**Resolution (wave 7, commit "pv knowledge — the knowledge layer is reachable").** `buildPlatform` now composes the `KnowledgeStore` (Pg vs memory) and the four services — `IngestionService`, `Retriever`, `GroundedAnswerService`, `FreshnessMonitor` — over one shared store, registers `KNOWLEDGE_ACTIONS` in the one chokepoint, and exposes them on `Platform`. `pv knowledge` adds corpus create, ingest, ask, freshness, and review. Driven against Postgres by two independent parties on separate fresh DBs: a document ingested into a corpus screens clean and chunks; a question grounded in it is answered with a citation carrying the title, version, jurisdiction, effective window, source uri and chunk id; a question nothing grounds is refused `knowledge.no_grounding` with an empty answer (no confident ungrounded paragraph); an actor without the corpus's data scope is refused `authorization.data_scope_violation`; a corpus past its review cadence is refused `knowledge.stale_authority` rather than citing stale law, and a recorded review (with step-up re-authentication) reopens it; a poisoned document is refused at the ingestion screen. **Residual, stated plainly:** there is no HTTP route and no console surface for knowledge yet — the layer is reachable from a terminal, not from the browser; and GET /api/knowledge/* remains unbuilt.


### T-09  [RESOLVED via CLI — wave 4; API routes and bias wiring residual]

**Claim.** §7 Agent roles and the role factory — versioned artifact, plain-language authoring surface producing an inert draft, promotion only on recorded evaluation evidence plus human approval, diffable/attributable/revertible, instantly disableable


**Gap.** The factory half is inert. `draftRole` (roles/authoring.ts:149) and `RolePromotionService` (roles/promotion.ts:161) and `analyseFairness` (roles/bias.ts:144) have no caller outside tests — I grepped for constructors and call sites. There is no CLI verb and no API route to author, propose, promote, revert or disable a role; GET /api/roles and /api/roles/:id/versions are on the unimplemented ratchet (console-contract.test.ts:53-54) and I got live 404s for both. The consequence is visible in the product: `pv evaluate --ci` printed 'NOTHING IN THIS DEPLOYMENT'S ROLE REGISTRY WAS EVALUATED' because no role has ever been promoted and none could be.


**Resolution (wave 4, commit "wire the role factory to operator surfaces").** The factory is composed at the root and reachable from a terminal. `buildPlatform` now constructs `RoleRegistry`, `RolePromotionService`, the role and evaluation stores, the model inventory, and the prompt-template registry, and exposes them on `Platform`; the action registry carries the role lifecycle actions so the one chokepoint resolves rather than refuses them. `pv roles` adds list, show, draft, golden publish, propose, promote, revert, disable, enable — every verb through the real services, no rule re-implemented. Driven by hand against a fresh Postgres store: `draft` produced an inert draft that cannot act; `propose` evaluated it 100% and recorded the evidence; `promote` **refused** without recorded evidence (`record.unavailable`), without a granted approval (`approval.required`), and without the promoter's re-authentication (`authorization.step_up_required`), each exit 1; a **different** person (role `supervisor`, via a real session with step-up observed) granted through `pv approvals decide`; only then did `promote` succeed; `disable` engaged containment and `enable` released it with no fresh approval. After promotion `pv evaluate --ci` evaluates the role (2/2, PASS, exit 0) and the "NOTHING WAS EVALUATED" banner is gone; disabling the role brings it back. This closes critic §6.

**Residual.** Two halves are deliberately out of this wave. (1) The read API routes GET /api/roles and /api/roles/:id/versions are still on the unimplemented ratchet — the CLI is the operator surface wired here, not the console's role screen. (2) `analyseFairness` / bias.ts still has no caller (that is T-10, not T-09), and `draftRole` produces shadow-only roles with no verb to widen operating modes, so a promoted role can currently act only in shadow — which is the mode the gate exercises, so the gate is honest, but an assisted/supervised effect is not yet reachable from the CLI.


### T-10  [PARTIAL — bias analysis now reachable (wave 5); other residuals stand]

**Claim.** §14 Model governance — model inventory resolved from configuration never hard-coded, change control, bias/disparate-impact testing where consumer outcomes are affected, human-in-the-loop policy by risk tier, provider terms, graceful degradation, NIST AI RMF and EU AI Act mapping


**Gap.** Bias testing is built (roles/bias.ts, 328 lines) and has no caller — no workflow scores or sequences consumers, and the harness has only ever run on synthetic fixtures (not-production-grade.md L2). Provider zero-retention/no-training terms are not contractually confirmed (B2), and the config loader refuses PV_MODEL_PROVIDER=fake in staging/production (config.ts:303), so the platform cannot lawfully run in production at all today. Change control is the CI eval gate only — there is no recorded review artifact when a prompt or threshold changes. A model answer truncated at max_tokens is recorded as a successful complete answer (L19).


**Resolution of the bias half (wave 5, commit "pv roles fairness — the bias analysis is reachable").** `analyseFairness` and `describeFairness` now have a caller: `pv roles fairness --role <role> [--evaluation-run <id>]` reads a recorded evaluation run and measures the rate at which each protected group received a favourable outcome, flagging groups past the four-fifths rule or the rate-difference threshold. Driven against Postgres: a synthetic golden set carrying an invented cohort attribute, proposed, then analysed — parity reported when the cohorts match, a cohort flagged (impact ratio 0, below 0.8) when its cases fail. It runs on synthetic fixtures only (a non-synthetic run is refused `authorization.data_scope_violation`) and it does not gate — a flag is a finding for a person, printed with the four caveats that must travel with the numbers, exit zero either way. **Still open, unchanged:** no workflow yet sequences real consumers into it (bias remains a fixture-only signal, L2); provider zero-retention terms are not contractually confirmed (B2); change control has no recorded review artifact when a prompt or threshold changes; a max_tokens-truncated answer is still recorded as complete (L19); and the fake provider is still refused outside development (config.ts). The measure is also a proxy — favourable-outcome rate, not decision rate — as bias.ts documents; mapping output to a decision label needs MVW compliance.


### T-11  [RESOLVED via CLI (wave 6); no real channel / API / console residual]

**Claim.** §10 Contact compliance — one outbound gate verifying consent, DNC, quiet hours by jurisdiction, frequency caps and revocation, with the evidence stored alongside the message; consent and revocation first-class with provenance


**Gap.** `ContactGate` is constructed only in tests (contact.test.ts:260, pass4-contact-gate.test.ts:168, documents.test.ts:117). platform.ts composes nothing from contact/; there is no outbound channel, no API route, no CLI verb, and no consent-recording surface. The gate has never gated a message outside its own tests, so §10 exists as a proof rather than as a capability. Known residual defect inside it: `EST` and `Etc/GMT+5` are still accepted as recipient timezones and read an hour wrong in the permissive direction (not-production-grade.md L18).


**Resolution (wave 6, commit "pv contact — the contact-compliance gate is reachable…").** `buildPlatform` now composes the `ContactStore` (Pg vs memory), the `ConsentLedger`, and the `ContactGate` on one shared store — the gate reads the consent the ledger wrote — registers `CONTACT_ACTIONS` in the one chokepoint, and exposes all three on `Platform`. `pv contact` adds consent grant/revoke/state, dnc add, check (the safe dry run), and send (raise the approval, then clear — authorize, consume the approval, record the governed message). Driven against Postgres by two independent parties (the wiring workflow and this session, on separate fresh DBs): a check with no consent is not sendable; recording consent unblocks it; a message inside quiet hours in the recipient's real timezone is blocked; a do-not-call entry blocks even with consent; an allowed send records and a replay on the same idempotency key is recognised, not re-sent. The **L18 timezone defect is closed**: `isKnownTimeZone` now refuses the fixed-offset abbreviation aliases (`EST`, `MST`, `HST`, `GMT`) and the `Etc/*` namespace — reproduced first with failing tests, fixed as a deny-list that keeps `Singapore`/`Japan`/`Iceland`/`UTC` resolving, and `EST` now fails closed (quiet hours unavailable) rather than clearing an unlawful call. **Residual, stated plainly:** there is no real outbound channel — `contact send` records the governed message through the gate and says so; and there is no contact API route or console surface yet, so the gate is reachable from a terminal but not from HTTP or the browser.


### T-12  [NOT_DONE] (brief)

**Claim.** §9 Documents and correspondence — versioned templates with owners and approval history, generated documents recording template version, data, model and approver, bound to the operating record


**Gap.** No importer outside tests — `DocumentGenerator` is constructed only at documents.test.ts:136. platform.ts composes nothing from documents/; there is no route or CLI verb that generates a document, and the approval screen's artifact preview is explicitly left unwired (api/server.ts:60-67 says a deployment wires its document store there and 'unwired' is the state this repository ships in). Output formats are text and HTML only; PDF/DOCX are a commented seam because MVW's actual formats were never confirmed (L7).


### T-13  [NOT_DONE] (brief)

**Claim.** §11 Integrations — narrow versioned interfaces with realistic fakes and contract tests both sides satisfy, host allowlisting, credential scoping, rate limits, backoff, idempotency keys, explicit degradation, credentials in a secret manager and never logged


**Gap.** `EgressClient` (egress.ts:253) is exported by integrations/index.ts and constructed nowhere; `IntegrationRegistry` and `DegradationHandler` have no production caller (L17 says so explicitly). No system of record is ever called. PV_EGRESS_ALLOWLIST is read and warns when empty (I saw the warning on every startup) but bounds nothing, because nothing egresses through it — and the one component that DOES make outbound calls, identity/oidc.ts, bypasses the allowlist entirely (S10). Ports are admittedly designed against guesses (L4).


### T-14  [PARTIAL] (brief)

**Claim.** §18 The console — a web application, two themes only, one coherent design system, WCAG 2.2 AA with automated checks in CI, and the ten named surfaces


**Gap.** Four of eleven nav destinations and seven of seventeen routes are dead against a real server. I started `pv serve` and curled: /api/executive, /api/roles, /api/improvements/proposals, /api/discovery/candidates and /api/workflows/wfi_x all returned 404, while /api/health, /api/session, /api/runs, /api/actions, /api/containment and /api/audit returned 200. This is known and ratcheted rather than hidden — api/console-contract.test.ts:47-56 lists exactly these eight paths as KNOWN_UNIMPLEMENTED and fails if the list grows OR if a listed gap is quietly closed. So the Executive view, Agent roles, Role detail, Improvements queue, Improvement proposal, Work discovery and Workflow instance surfaces cannot load. Also: six views still import the legacy ../components set (WorkQueue, Health, RoleRegistry, ContainmentControls, ExternalAgents, ExternalAgentDetail) rather than ../ui, so the design-system migration is incomplete (L4b); filter state is not in the URL, which design-spec §3.1 requires (L4c); and five of six performance budgets are unmeasured, with the shipped table not virtualising (L4d). No SSO means Phase 4's gate — an MVW operator completing a task unaided — cannot be met outside development.


### T-15  [PARTIAL] (brief)

**Claim.** §13 The improvement loop — harvest, cluster, propose, evaluate against the golden set, human approval, versioned reversible apply, watch; no autonomous application, no self-modifying code, evaluation sets protected against weakening


**Gap.** Stages 2-7 are a closed clique nothing outside improve/ imports. cluster.ts, propose.ts, evaluate.ts, approve.ts, apply.ts and watch.ts have no production caller — platform.ts composes only the harvester and says so at :84-94. /api/improvements/clusters, /api/improvements/proposals and /api/improvements/proposals/:id are unimplemented (I got live 404s), so the console's Improvements surfaces cannot load. Phase 5's gate — an observation becoming a proposal, evaluated, approved, applied and reverted, all visible in the audit log — is proven inside improve.test.ts and cannot be walked in the product.


### T-16  [PARTIAL] (brief)

**Claim.** §16 Assurance artifacts in docs/assurance/, current and written for an outside reader


**Gap.** The brief requires the subject-rights runbook to come with WORKING TOOLING, and it does not: no subject-rights or consent CLI verb exists, `owner.export_data` and `owner.delete_data` are registered actions with no caller, and `subject_rights.request_recorded`/`subject_rights.fulfilled` are declared audit event types nothing emits (blocker B7). Retention: twelve of fourteen documented rules are policy only; two are enforced, and only when `pv worker` runs (S8). The SBOM lists inventory but not the dependency graph or per-package hashes (S3a). No penetration test (S2), no signed builds with provenance (S3), no container scanning (S4).


### T-17  [PARTIAL] (brief)

**Claim.** §17 Operations — SLOs with error budgets, backups with a tested restore, DR with exercised failover, load testing at real volume, observability with dashboards and alerts each carrying a runbook, incident process, cost per unit of work


**Gap.** Most of §17 is documentation of intent. Not executed: restore drill on real infrastructure (B3 — only a laptop pg_dump/pg_restore), DR failover (B4), load test so the capacity ceiling is unknown (B5). Not built: infrastructure as code, separate environments, one-command rollback (S6); any metric at all — sixteen are specified and zero are emitted, and there is no metrics client in the dependency tree (S9a); any HTTP request log, which leaves SLO indicators S1 and S3 underivable (S9). Cost accounting is mechanically correct but the numbers come from the fake provider, so 'what does a resolved case cost' has no real answer yet (L8).


### T-18  [PARTIAL] (brief)

**Claim.** §21 Working practice — a feature is not done until something calls it; the whole suite run before claiming it passes; no aspirational documentation


**Gap.** The §21 rule itself is where delivery falls down: seven whole subsystems named in the brief — identity, the workflow engine's entry points, knowledge, contact, documents, integrations, and improvement stages 2-7 — are tested, typechecked, migration-registered and unreachable from any entry point. Two smaller aspirational-comment defects survive. api/server.ts:168 points a reader at SessionService as though resolution were pending wiring, when nothing constructs it. And `pv serve --seed` cannot be moved off port 8080: demo/run.ts:131 calls loadConfig with a literal object, which kernel/config.ts:239 treats as the entire environment, so PV_HTTP_PORT is discarded and cli/main.ts:590 then prints the port it did not use — I hit EADDRINUSE on 8080 with PV_HTTP_PORT=8099 set.


### T-19  [PARTIAL] (external)

**Claim.** ONE RECORD — same runs table, same approval queue, same audit chain, marked external


**Gap.** The "one cost report … one figure in the executive summary" half of the claim (ADR 0016:104-108, docs/external-agents/README.md:44-47) has no working screen: the console calls GET /api/executive (packages/console/src/api/client.ts:526) and the server registers no such route — it is listed in the ratchet at packages/platform/src/api/console-contract.test.ts:48 as KNOWN_UNIMPLEMENTED. External spend is genuinely on the record and rolls up per run; there is simply no executive figure, external or native, to count it into.


### T-20  [PARTIAL] (external)

**Claim.** OPERATOR SURFACES — HTTP, CLI, console, OpenAPI, samples all exist and are wired


**Gap.** The console surface is read-only — there is no contain/release/revoke/mint control in ExternalAgentDetail.tsx (no button, no mutation on the client). Every operator write action on this plane is CLI-only. The brief's "reachable by an operator in seconds without a deploy" is met by `pv agents contain`, but an operator working in the console cannot stop an agent from the screen that shows it misbehaving. The samples are explicitly provisional (README.md:13-30) because no MVW agent platform has been confirmed.


### T-21  [PARTIAL] (external)

**Claim.** GOVERNED EXECUTION is available in a real deployment


**Gap.** No production composition path passes any connector: the only callers of buildPlatform outside tests are cli/main.ts:607 and demo/run.ts:136, neither of which supplies `connectors`. So in a deployed platform the connector registry is empty and POST /api/external/execute refuses every operation as unregistered. This is disclosed honestly (docs/external-agents/README.md:355-358, ADR 0016:118-122) and is arguably the right default, but the capability is proven only against a connector defined inside the tests.


### T-22  [NOT_DONE] (external)

**Claim.** Per-agent wall-clock ceiling (wallClockCeilingMs) is a ceiling


**Gap.** docs/external-agents/README.md:65 tells the vendor it is "How long one episode may take" and ADR 0016:48 lists it among the ceilings the registry entry carries. Neither is true: a live run is only ever closed by the global PV_EXTERNAL_RUN_RECLAIM_AFTER_SECONDS sweep (runs.ts:63-64, maintenance.ts:134), and a report describing a ten-hour episode against a ten-minute ceiling is ingested without complaint. This is a documented behaviour the code does not have, and it is not on any known-limits list (grep of docs/ finds no mention).


### T-23  [NOT_DONE] (external)

**Claim.** PV_EXTERNAL_JWKS_PATH configures JWT verification for the plane


**Gap.** Inert configuration plus a false warning. The startup message says "no PV_EXTERNAL_JWKS_PATH is configured, so platform-native JWT assertions cannot be verified and agents can only hold bearer, HMAC, or pinned-key credentials" — JWT credentials verify fine without it (credentials.test.ts:330, :388). An operator reading the warning will either believe a working capability is unavailable or set a variable that does nothing.


### T-24  [PARTIAL] (external)

**Claim.** The suites are green


**Gap.** Console: `pnpm --filter @pv/console test` → 1 failed | 1388 passed, exit 1. The failure is packages/console/src/views/DesignGallery.test.tsx:313 "has no accessibility violations with every component on the page" — a 60s timeout, not an assertion failure, on a machine where the whole console suite took 255s. Unrelated to the external plane (every ExternalAgents/ExternalAgentDetail test passed), but the console suite does not currently pass end to end here. Note also that HEAD is 7a5c1e5, two commits past the c19c678 named in the brief for this audit.


### T-25  [NOT_DONE] (design)

**Claim.** §1.5 Glass on chrome and overlays only — never behind a table, a chart, a form, or long-form reading


**Gap.** Glass must be removed from `.pv-dt-scroll`, `.pv-toolbar`, `.pv-panel`, `.pv-callout`, `.pv-metric`, `.pv-step`, `.pv-citation`, `.pv-artifact` and confined to the rail, top bar, context panel, popovers, sheets, modals, toasts and summary cards.


### T-26  [PARTIAL] (design)

**Claim.** §1.5 rule 3 — cap concurrent blurred surfaces at three


**Gap.** On the shipped work queue the blurred surfaces are the rail, the top bar, the context panel, `.pv-toolbar`, up to two `.pv-callout`s and `.pv-dt-scroll` — at least seven. Worse, screens.css re-blurs `.pv-panel`, the very element the budget was written to govern, so a Panel the budget denied a lease to is blurred anyway.


### T-27  [PARTIAL] (design)

**Claim.** §1.6 Motion — five tokens, exit ×0.7, reduced-motion becomes opacity-only at 80ms; never animate text, sorting, or the typing path


**Gap.** originMotion is used only by ui/surfaces (Modal/Sheet/Popover) and the gallery. No shipped route transition uses it: routing.tsx has no `page` (280ms) transition, and no shipped list passes an origin element, so §1.6's "motion preserves identity" is unshipped on every one of the seventeen screens.


### T-28  [NOT_DONE] (design)

**Claim.** §3.1 Work queue — the default landing, built to spec


**Gap.** Missing against §3.1: no saved-view pills (All open · Mine · Breaching · High value · Unassigned — the contract already has them at api/contract.ts:140 and the server implements them, per platform hero-screens.test.ts:561); no filter-builder; no density toggle on the bar; no sticky 56px filter bar; no URL encoding of filter state (filters are useState at WorkQueue.tsx:175-177); no row selection, no bulk bar, no `Preview changes`; no virtualization; no infinite scroll; no 40/52px row heights or 2px selected-row accent bar; empty-state copy does not match the spec's block and offers neither `Change my digest` nor `See all cases`.


### T-29  [NOT_DONE] (design)

**Claim.** §3.1 Behaviour — J/K move, Space previews in the panel, Enter opens, X toggles, Shift+J/K range-selects


**Gap.** Every list verb in §3.1 works only on the /design gallery. On the shipped queues J, K, Space, X, Shift+J/K and Enter do nothing.


### T-30  [NOT_DONE] (design)

**Claim.** §3.2 The approval — the hero screen, two columns 60/40, decision possible without scrolling at 1440×900


**Gap.** Needs the 60/40 split and the sticky bottom decision bar.


### T-31  [NOT_DONE] (design)

**Claim.** §3.2 Left column content in the specified order — the ask, provenance chips with a type badge, "If you approve" callout with the exact artifact, "If you reject", why this needs you (named rule), blast radius strip, expandable evidence, prior similar decisions


**Gap.** The most consequential screen in the product shows a definition list of proposal fields where the spec requires the ask, the concrete effects, the artifact preview, the named rule, the four-cell blast radius, inline evidence and the last five similar decisions. The data and the component both exist; nothing joins them.


### T-32  [NOT_DONE] (design)

**Claim.** §3.2 Reject expands an inline reason selector, never a modal


**Gap.** Replace the modal with an inline reason selector offering a short reason list plus free text.


### T-33  [PARTIAL] (design)

**Claim.** §3.2 Decision bar sticky, bottom, glass, 72px, Reject and Approve the same size and weight


**Gap.** The bar is not sticky, not bottom-docked, and not glass on the shipped screen.


### T-34  [NOT_DONE] (design)

**Claim.** §3.2 Keyboard: A approve, R reject, E evidence focus, J/K previous/next approval, Esc back; after deciding advance automatically with a 2-second undo toast


**Gap.** 8 of the 16 declared verbs — J, K, Enter, Space, X, A, R and ⌘Enter — have no command bound anywhere and are inert on every shipped screen. `E` is unspecified.


### T-35  [NOT_DONE] (design)

**Claim.** §3.2 Bulk approval offered only when items provably share a shape


**Gap.** 


### T-36  [PARTIAL] (design)

**Claim.** §3.3 Case / run detail — sticky 64px header, vertical timeline spine with icon by type, expandable steps, model steps distinguishing retrieved/asserted/computed, Correct this, human step attribution, failure and retry


**Gap.** No sticky 64px header (tokens.css:399 --pv-shell-detail-header-height has no consumer). No timeline spine — ui/domain/Timeline.tsx is used only by DesignGallery. **"Correct this" is entirely absent**: `client.correctStep` (api/client.ts) has no caller outside its own test, and DesignGallery.tsx:3204 admits the gallery's own button "is drawn and does nothing". No right panel with record context.


### T-37  [PARTIAL] (design)

**Claim.** §3.4 Evidence and audit browser — 240px filter rail, dense results table, row opens a full-height sheet with the complete chain, CSV and print-ready PDF export


**Gap.** No 240px left filter rail (filters are inline in a "Find entries" Panel at :473). Selecting a row does not open a full-height Sheet — ui/surfaces/Sheet is used only by ContextPanel and the gallery. No CSV export and no print-ready PDF with a cover sheet; DesignGallery.tsx:3204 says the "Export as CSV" control it draws does nothing, and the client has no export method.


### T-38  [NOT_DONE] (design)

**Claim.** §3.5 Performance and executive views — one question per chart written as the title, every tile carries value + trend + comparison basis + sparkline, always show the denominator, chart rules


**Gap.** §3.5's chart rules (question titles, max 6 series, direct labels, zero-based bars, intervention annotations) govern zero shipped charts. The screen's honesty work — separating MVW's reported figures from platform-measured ones, refusing to colour a direction it was not told about (:51-56), forcing a source line on every tile (:124-127) — is genuinely excellent and is the strongest thing on the screen, but it is not what §3.5 asks for.


### T-39  [NOT_DONE] (design)

**Claim.** §3.6 The copilot — in the context panel on every route, C focuses it, context chip row, citations with retrieved/asserted/computed, cost and elapsed footer, "I don't know" as a designed response, proposed actions as cards that park in the real approval queue


**Gap.** There is no copilot in the product. The shipped empty-state copy — "The copilot answers from whatever this panel can see, so it always knows where you are" (ContextPanel.tsx:60-63) — promises a surface that does not exist, which is the present-tense-aspirational pattern this codebase has been caught on before.


### T-40  [NOT_DONE] (design)

**Claim.** §3.7 Low-code configuration — every config surface follows Current → Draft → Diff → Impact → Publish, with a mandatory Diff tab, a golden-set Impact tab, governed Publish, one-click revert and a Test run button


**Gap.** The entire §3.7 pattern is unbuilt.


### T-41  [PARTIAL] (design)

**Claim.** §4 Read-only is a designed state, not a greyed-out accident


**Gap.** Not plumbed to content. `session.readOnly` reaches AppShell (App.tsx:83) and stops at the top bar, avatar menu, command palette and context panel (AppShell.tsx:442,474,483). No view receives it. A read-only auditor sees enabled "Approve this action" / "Reject" buttons on ApprovalDetail and enabled containment controls, with the only signal being a chip inside the avatar menu.


### T-42  [PARTIAL] (design)

**Claim.** §5 Keyboard model — the eleven-row table implemented consistently everywhere


**Gap.** Bound to nothing: J, K, Enter, Space, X (list), A, R (approval), ⌘Enter (submit). `/` is bound but its only handler opens the command palette (AppShell.tsx id `shell.search`, marked as the fallback for a screen with no search) — no screen registers a real search focus. §3.1's Shift+J/K and §3.2's `E` are not in the table.


### T-43  [PARTIAL] (design)

**Claim.** §5 The command palette is primary navigation — searches actions, records and saved views in one list, shows shortcuts, learns frequency, and every action reachable by mouse is reachable here


**Gap.** Only AppShell contributes commands, and only of kinds `navigate` and `action`. No record and no saved view is ever registered, so the palette cannot find a case, a run, an approval or a saved view. "Every action reachable by mouse is reachable here" is false — approve, reject, sort, filter, correct-this and export are not commands.


### T-44  [PARTIAL] (design)

**Claim.** §6 Copy — errors name what happened, what it means, what to do, with a reference; permission denied names a human who can help; destructive confirmation states consequence and reversibility; never "Oops"/"Something went wrong"/"Invalid input"


**Gap.** §6's permission-denied example requires naming a human who can help ("Dana Ruiz or Marc Webb administer this queue"). Denial.tsx:52 says only "ask an administrator to check your roles and data scopes" — no named person, and the DenialView carries no field for one. §6's error example also requires a `Reference 8f2a41` code; ResourceView.tsx:40-54 renders the raw exception message with no reference.


### T-45  [NOT_DONE] (design)

**Claim.** §7 Route change from cache ≤100ms to first paint, with prefetch on hover, focus and keyboard selection — enforced in CI


**Gap.** Not implemented and not measured.


### T-46  [NOT_DONE] (design)

**Claim.** §7 Interaction to next paint <200ms at p95 — enforced in CI


**Gap.** 


### T-47  [NOT_DONE] (design)

**Claim.** §7 Cumulative layout shift 0 on the hot paths; reserve space for everything that will load; skeletons only past 300ms


**Gap.** Every route load shifts layout. The 300ms rule is inverted: something is shown immediately and it is not a skeleton.


### T-48  [NOT_DONE] (design)

**Claim.** §7 Table renders 10,000 rows without jank via virtualization


**Gap.** docs/handover/not-production-grade.md L4d states this honestly ("it is not met — it is not close").


### T-49  [NOT_DONE] (design)

**Claim.** §7 overall: "Enforced in CI on the queue, approval, and detail routes"


**Gap.** Zero of the six §7 budgets are enforced. One proxy metric is. The tool is honest about this and docs/handover/not-production-grade.md L4d repeats it; the spec's claim is simply not met.


### T-50  [PARTIAL] (design)

**Claim.** §8.1 Purpose obvious in five seconds; primary action obvious without hunting


**Gap.** On the approval — the screen where it matters most — the primary action sits at the bottom of the fifth stacked panel (ApprovalDetail.tsx:392) and is off-screen at 1440×900. That is hunting.


### T-51  [NOT_DONE] (design)

**Claim.** §8.2 Every number carries a comparison or trend; every chart's title is a question; denominators shown


**Gap.** 


### T-52  [PARTIAL] (design)

**Claim.** §8.3 Empty, loading, error, permission-denied AND read-only states designed


**Gap.** **Loading is not designed** — one line of text (ResourceView.tsx:29-33), no skeleton, no reserved space, on all seventeen views. **Read-only is not designed on any view** — session.readOnly reaches the top bar and the palette and never reaches content, so the read-only auditor the spec names as the primary user of this state sees fully enabled Approve, Reject and containment controls. §8.3 fails on 2 of its 5 required states, on every screen.


### T-53  [PARTIAL] (design)

**Claim.** §8.4 Legible and correct in both themes and with transparency off


**Gap.** Screen-level appearance is unproven and there is a concrete defect. `.pv-panel` is defined twice — ui/surfaces/Panel.css:9 and screens.css:118 — and in the built bundle (dist/assets/index-C3tNHDla.css, ui at byte 41931, screens at 130014 and the glass rule at 143957) screens.css wins at equal specificity. Every design-system `<Panel>` on the ten migrated views therefore gets 20px of extra padding and a 12px gap layered over its own header/body padding, and gets forced into glass regardless of its lease. No test can see this: jsdom applies no CSS, and there are no visual-regression snapshots. This is exactly the failure mode components/DataTable.tsx:46-53 was renamed to avoid, recurring on a different class.


### T-54  [PARTIAL] (design)

**Claim.** §8.5 Fully keyboard operable; focus visible and designed; shortcuts documented


**Gap.** Not fully operable. The list verbs and the decide verbs are inert (see §5), so an approver cannot work a queue or decide an approval from the keyboard — they can only navigate between screens and open the palette.


### T-55  [PARTIAL] (design)

**Claim.** §8.6 WCAG 2.2 AA verified — automated in CI plus a manual keyboard and screen-reader pass


**Gap.** The manual keyboard and screen-reader pass is not evidenced anywhere in the repo; docs/handover/not-production-grade.md L5 concedes automation covers about half of WCAG.


### T-56  [NOT_DONE] (design)

**Claim.** §8.7 Meets the performance budgets in §7


**Gap.** 


### T-57  [NOT_DONE] (design)

**Claim.** §8.8 An operator can change what governs it without an engineer


**Gap.** Fails for all seventeen screens. Two of the three writes are reachable; changing what governs a screen is not one of them.


### T-58  [PARTIAL] (design)

**Claim.** Which layer the SHIPPED screens use, and whether that meets the spec


**Gap.** Plainly: the migration is roughly two-thirds done and the third that remains includes the default landing screen. Three problems follow. (1) **The work queue, §3.1's screen and the console's front door, is entirely on the legacy layer** with a non-virtualised table. (2) **The half-migration made the collision worse, not better**: screens.css still defines `.pv-panel` (screens.css:118) and still forces glass onto it (screens.css:939), and because screens.css loads last it overrides the design-system Panel that ten views now render. Migrating a view onto `ui` currently does not get it the design system's appearance. (3) **The layers' own documentation is now false in both directions**: screens.css:1-30 and docs/handover/not-production-grade.md L4b both say "The seventeen screens an operator actually reaches do not use it" and "[migration] removes src/components and src/screens.css entirely" — ten views did migrate, and screens.css is still authoritative over them. Removing components/ and screens.css is still the right end state and is still the largest single item of work.


### T-59  [PARTIAL] (design)

**Claim.** Overall verdict against §8's own framing: correct vs finished


**Gap.** No screen is finished, and no screen is yet correct. The most defensible honest report is: the **foundations are finished** — the token system (§1.1–1.4) is exemplary and CI-verified against real contrast composites, the accessibility gate is real and provably able to fail, the copy discipline holds, and the design system at /design is a genuine, complete, well-tested implementation of §4. The **screens are not**. The gap is not craft — the components, the keyboard table, the virtualised table, the ApprovalCard, the charts, the Timeline, the DiffView, the CopilotMessage and the platform data behind all of them exist and are tested. They are not wired to the seventeen surfaces an operator opens. Three fixes would move this furthest: (1) render ApprovalDetail from ApprovalDetailView through ApprovalCard, which turns the hero screen from a field dump into §3.2 and costs no new data; (2) move WorkQueue onto ui/surfaces/Table and wire activeKey/select/preview/open, which delivers §3.1's behaviour, the keyboard model and virtualization at once; (3) delete the `.pv-panel` rules from screens.css, which is what currently prevents the finished migrations from looking finished.


### T-60  [NOT_DONE] (verification)

**Claim.** 'Fifty-five findings across passes 2-10' (findings.md:717)


**Gap.** The number is 53, not 55. The sub-count is also wrong: findings.md:717 says 'nineteen from the honesty audit' and honesty-audit.md:23 says 'Nineteen findings, all fixed', but that document contains 17.


### T-61  [NOT_DONE] (verification)

**Claim.** '...all fixed' (findings.md:717)


**Gap.** Six of the 36 are explicitly not fixed in the same document that claims all are, ~280 lines later. honesty-audit.md:488 additionally carries a whole '## Not fixed — for the owner' section listing four more, and honesty-audit.md:494-498 records that F-34/F-35 were already fixed in commit fb9f18b while findings.md still read 'Asking first' — a drift the auditor spotted and deliberately left. The verdict then rolled all of it up as 'all fixed'.


### T-62  [PARTIAL] (verification)

**Claim.** Suite state: 180 test files, 3,320 tests, all passing (findings.md:649)


**Gap.** 'All passing' is true — I confirmed zero failures across both packages. The counts are stale by +1 file / +10 tests. Platform's 1,937 was correct at the documented commit; the +4 came from packages/platform/src/demo/demo.test.ts, committed as a853772 *during this audit*. Console's 104/1,383 is wrong at any commit since a1f290f, which added packages/console/src/routes.contract.test.ts.


### T-63  [PARTIAL] (verification)

**Claim.** The reproductions under packages/platform/src/review/ are real reproductions, not assertions written after the fix


**Gap.** packages/platform/src/review/pass6-time-based-work.test.ts is the weak one, and it guards the CRITICAL finding F-01. All three cases are grep-over-source reachability checks, not behavioural. Case 3 (:88-94) asserts only `expect(platformSource).toMatch(/engine/i)` — satisfied by the word 'engine' appearing in a comment, and platform.ts:121-134 is exactly such a comment. Cases 1-2 use a regex `\.\s*name\s*\(` over all non-test sources, which would pass if the caller were itself unreachable. The F-01 fix is genuinely real (I verified it independently), but this test would not fail if it regressed in any realistic way — 'assert presence rather than content', the class the method warns about.


### T-64  [NOT_DONE] (verification)

**Claim.** State-of-the-build: 'The console screens are not on the design system... the seventeen screens an operator reaches use an older component set' (findings.md:735-742)


**Gap.** The verdict overstates the problem in one direction and understates it in another. It is no longer true that the screens are on an older component set — most are migrated. But the specific hazard it named ('two implementations of the same widgets, in one CSS namespace') is now concentrated in 3 view files that import both libraries at once, which the document does not describe because it predates the change. packages/console/src/components/ still exists with no importer outside those 6 views.


### T-65  [PARTIAL] (verification)

**Claim.** State-of-the-build 'What is not' is a complete account of what blocks a buyer


**Gap.** The highest-ranked Pass-0 gap — the entire operator console is unreachable outside a developer laptop — never became an F- finding and appears nowhere in the state-of-the-build's 'What is not'. It survives only as a parenthetical inside F-08's reachability note at findings.md:114. review-method.md:337 requires every Pass-0 gap closed or documented with a reason; this one is neither, at the level a buyer would read.


### T-66  [NOT_DONE] (verification)

**Claim.** docs/review/inventory.md is current


**Gap.** A reader consulting inventory.md to learn what is outstanding is told at least four things that are no longer true. honesty-audit.md:522-524 anticipated exactly this class ('the code moved and the sentence about the code did not') and even flagged inventory.md item 3 as knowingly left to another owner — but the document was never brought forward.


### T-67  [NOT_DONE] (verification)

**Claim.** The repo is at merged commit c19c678 with a clean working tree (audit premise)


**Gap.** Three commits (a1f290f, 7a5c1e5, a853772) post-date the review documents, and another agent is committing to this branch right now. Every number in findings.md's Verification section was therefore stale before this audit began, and honesty-audit.md's closing note already records the same hazard — commits a659971 and fb9f18b sweeping another pass's working tree into themselves. The attribution problem it flagged has recurred.


### T-68  [NOT_DONE] (redlines)

**Claim.** RED LINE 1 — No AI attribution in commits


**Gap.** Two merge-commit subjects and one branch name carry "claude". This is on the merged record and cannot be removed without a history rewrite. MVW receives this source code including its git history.


### T-69  [NOT_DONE] (redlines)

**Claim.** RED LINE 1 — No AI attribution in PR titles or bodies


**Gap.** Two PR bodies carry an explicit AI-generation trailer, one of them merged. The trailer also leaks a claude.ai session URL. The self-report at inventory.md:551 identifies the defect but nothing fixed it, and PR #3 reintroduced it after the report was written.


### T-70  [PARTIAL] (redlines)

**Claim.** RED LINE 6 — Fail closed everywhere


**Gap.** The CI fail-closed guard is silenceable by a comment: architecture.test.ts:403 exempts any catch block carrying `// allow-swallow:`. There are 20 such markers across 9 files (api/server.ts×3, cli/main.ts×3, contact/gate.ts×2, engine/runner.ts×4, external/admission.ts×2, external/enrollment.ts×1, external/runs.ts×3, guard/authorize.ts×1, guard/screen.ts×1). I read the two most sensitive — guard/authorize.ts:302 and contact/gate.ts:792 — and both are correct conversions with the refusal preserved, not swallows. But the gate is heuristic with an opt-out, so this is a caveat rather than a clean pass. I did not read all 20 sites.


### T-71  [NOT_DONE] (redlines)

**Claim.** Separate from the red lines: the glass widening deviates from the design authority


**Gap.** An ADR was amended to override the design specification. The task brief states the design spec is the design authority and wins on anything visual, so an ADR cannot amend it. Out of scope for the red-line audit but flagged for whoever audits the design authority.


### T-72  [PARTIAL] (glass)

**Claim.** "Text on glass sits on a scrim" (design-spec.md:159-161) — the scrim is the container text belongs in (glass.css:33-38, :234-239).


**Gap.** The spec's hard rule 1 is satisfied numerically but not structurally: text sits on raw glass on eleven of the twelve glass surfaces. The glass.css comment at :34-36 asserting the scrim "is the container text belongs in" does not describe screens.css.


### T-73  [NOT_DONE] (glass)

**Claim.** "No blurred backdrop is ever attached to a row, a cell, or a badge" — the stated performance rule (screens.css:933-936, glass.css:6-11).


**Gap.** Move .pv-step/.pv-citation under a container in AuditEvidence, or drop the filter from them unconditionally; add .pv-panel .pv-toolbar (and the .pv-dialog descendants) to the nesting-drop list at screens.css:1041.


### T-74  [NOT_DONE] (glass)

**Claim.** The test at screens.test.ts:55-86 guards the per-row rule — it "is the noticing" (screens.test.ts:7-10).


**Gap.** The test enforces a list of names the current file was written to satisfy, not the rule. It cannot fail on any new per-row class, which is the only way this realistically regresses.


### T-75  [NOT_DONE] (glass)

**Claim.** The blur cap of three concurrent surfaces (design-spec.md:166, and the lease mechanism built for it) still holds.


**Gap.** The mechanism the codebase built to enforce the spec rule is routed around by the CSS that was added for this request. No test compares the number of raw backdrop-filter selectors against GLASS_BUDGET_CAPACITY.


### T-76  [NOT_DONE] (glass)

**Claim.** "The status callouts keep their tone. ... the tinted fill wins over the glass fill and only the lens is shared" (screens.css:1054-1056).


**Gap.** Either move screens.css:1057-1066 to restore background-color/border-inline-start-color, or raise its specificity. As shipped, every callout tone renders the same.


### T-77  [NOT_DONE] (glass)

**Claim.** The refusal surface keeps its denied tone (screens.css:1063 lists .pv-denial among the surfaces that "keep their tone").


**Gap.** The permission-denied state and the stale-citation warning — both explicitly designed states under design-spec.md:500-503 — lost their surface-level tone channel in this pass.


### T-78  [NOT_DONE] (glass)

**Claim.** screens.css "is separate from src/ui/, which is the component library the gallery at /design demonstrates" (screens.css:6-9).


**Gap.** No test checks for class-name collisions between screens.css and src/ui/*.css. The stated separation is not enforced anywhere.


### T-79  [PARTIAL] (glass)

**Claim.** The @supports fallback removes glass where the browser cannot blur, because "a tint with no blur behind it is less legible than the solid surface" (screens.css:1095-1096).


**Gap.** Three of twelve glass surfaces get the un-blurred tint in a browser without backdrop-filter. screens.test.ts:108-113 only asserts the @supports string is present, not what is inside it.


---

## DONE verdicts that did not survive refutation


### R-01

**Claimed.** Phase 0 — repo, justified stack, CI running tests, lint, secret scanning, dependency scanning, SBOM and accessibility checks; clone-to-running in under 15 minutes on the README alone


**Actually.** Five of the six CI controls are real and I confirmed each by running it. The sixth — secret scanning — is a green check that has scanned zero bytes on the default branch, and it has never scanned full history despite three documents (including the customer-facing security questionnaire) stating that it does.

THE DEFECT — secret scanning is not doing what the repo says it does

The workflow (.github/workflows/ci.yml:30-40) pins `fetch-depth: 0` under the comment at :32-34 "Full history: a secret removed in the most recent commit is still a secret, and scanning only the tip would miss it." `gitleaks/gitleaks-action@v2` does not scan full history on `push` or `pull_request` events regardless of fetch depth — it scans the event's commit range. The action's own CI logs show the exact command:

  git -C . log -p -U0 --no-merges --first-parent a1f290f3^..a8537721
  3 commits scanned. scanned ~89471 bytes (89.47 KB)
  (run 31222486153, job 93009811754 — pull_request event)

`fetch-depth: 0` only makes those objects present; it does not widen the scan. Full-history scanning requires a different invocation (schedule/workflow_dispatch mode, or `gitleaks detect` without --log-opts). So the comment at ci.yml:32-34 describes behaviour the configuration does not have — the fourth instance of that pattern in this codebase.

Worse, on the default branch the scan covers nothing at all:

- Run 31203610964, job 92949237301 — push to Main at c19c678, the exact commit the auditor's evidence names:
    "0 commits scanned." / "scanned ~0 bytes (0) in 142ms" / "no leaks found" / "✅ No leaks detected" — conclusion: success.
- Run 31223136677, job 93011789221 — push at the current tip c38da93:
    "event type: push" / "No commits to scan" — step ran in under one second, conclusion: success.

Both merges onto Main produced a green "Secret scanning ✅" having read zero bytes. `--no-merges` additionally excludes merge commits, which is how content reaches Main. A credential merged to Main is scanned by this gate on precisely no run.

The docs assert the false behaviour in the places a buyer will read:
- docs/assurance/vulnerability-policy.md:45 — "Secret scanning runs as its own job, first, over full history — a credential removed in a later commit is still a credential."
- docs/assurance/security-questionnaire.md:223 — "secret scanning over full history"
- docs/assurance/security-questionnaire.md:240-241 — "D.5 Is secret scanning performed? Yes, over full history — a secret removed in the most recent commit is still a secret."

The control is not entirely dead: a push to a feature branch does scan that push's commits (89KB across 3 commits in the run above). What does not exist is the full-history property that is claimed three times, and there is no scan at all on the branch that matters.

TWO SMALLER THINGS THE AUDITOR DID NOT CHECK

1. README.md:28 tells a new engineer `cp .env.example .env`. Nothing loads .env. There is no dotenv dependency in any package.json or the lockfile, no `--env-file` anywhere in the repo, and no `process.loadEnvFile`. `loadConfig` (packages/platform/src/kernel/config.ts:239) reads `process.env` only. The console's Vite would read VITE_-prefixed vars, and there are none. A reader who follows the README and then edits .env gets silently ignored configuration. Clone-to-running still works because the schema defaults match .env.example.

2. tools/check-accessibility-coverage.mjs:77-83 matches a view as covered when ANY test file contains the view's basename as a substring AND an axe pattern somewhere in that same file. I proved the hole in a throwaway clone: dropping `packages/console/src/views/Card.tsx` with no test whatsoever reports "19/19 console views carry an automated accessibility assertion" and exits 0, because ApprovalCard.test.tsx contains "Card" and an axe call. Card, Table, Panel, Health and similar names bypass the gate. It does bite correctly for an ordinary name (BrandNewView.tsx → "18/19", exit 1).

Also stale: security-questionnaire.md D.4 warns "Do not send the sbom.json committed at the repository root." No sbom.json is committed — it is gitignored, and `git ls-files | grep sbom` returns only tools/generate-sbom.mjs.

WHAT I CONFIRMED IS GENUINELY TRUE

- Clone-to-running: fresh `git clone` to scratchpad, `pnpm install --frozen-lockfile` 2.4s, `cp .env.example .env`, `pnpm demo` exit 0 in 2.0s, `pnpm test` exit 0 (platform 76 files / 1774 passed + 158 skipped; console 105 files / 1389 passed) in about 4 minutes. Well inside fifteen minutes. The skip banner is honest and the "158" figure in README:48 is exactly right.
- Determinism: two cold `pnpm demo` runs byte-identical, and identical to a third run.
- Tests with Postgres: `PV_TEST_DATABASE_URL` set → 76 files / 1941 tests pass (auditor said 1937; immaterial). `npx tsc --noEmit -p packages/platform/tsconfig.json` clean.
- Lint: `pnpm lint` exit 0 with `--max-warnings 0`; eslint.config.mjs bans `any`, bare console, `var`.
- Dependency scanning: `pnpm audit --audit-level high` → "No known vulnerabilities found", exit 0.
- SBOM: `node tools/generate-sbom.mjs` → 332 components, valid CycloneDX 1.5, deterministic serial number, exit 0.
- Accessibility: the gate reports 18/18, and unlike a presence check it is backed by real content — every one of the 18 views has 2-6 axe assertions in its own colocated test file, and packages/console/src/test/axe.test.tsx meta-tests the helper by planting known violations (image-alt, button-name, label, heading-order) and asserting it rejects.
- 17 ADRs in docs/adr/, including 0002-technology-stack.md.
- CI genuinely runs: 37 workflow runs; all 6 jobs green on the tip commit c38da93 (run 31223136677), including build + transfer-size budget (JS 160.4KB/190, CSS 17.7KB/24, reproduced locally) and the golden-set gate (`evaluate --ci` exit 0, 8/8, 100% vs 100% threshold).


### R-02

**Claimed.** §5.2 A tamper-evident audit log — append-only, hash-chained, verifiable after the fact, records decisions and input fingerprints not payloads, a verify command that fails loudly, defined retention


**Actually.** The chain machinery is genuinely good — hash-linked, append-only enforced by database triggers, head-truncation detectable via a monotonic watermark, single write path enforced by an architecture test, and the whole 1941-test suite passes. But the claim's "records decisions and input fingerprints not payloads, never secrets" is false as shipped.

`AuditLog.assertNoRawPayloads` (packages/platform/src/audit/log.ts:118-257) screens only `inputDigests`, `subject` and `decision`. It never inspects `correlationId` or `actor`. I confirmed by execution that a `correlationId` of "jane.doe@example.com +1-555-0142 sk_live_(a Stripe-shaped key)" is accepted and written verbatim into the chain, while the byte-identical string placed in `subject` is refused — the secret detector exists and is simply not applied to that field. `actorId`/`roles` are likewise unscreened.

`correlationId` is attacker-reachable, not internal: it comes from the `x-correlation-id` header on every route (packages/platform/src/api/server.ts:126-131) and from an optional body field on the external plane (packages/platform/src/api/external.ts:198, 238), bounded only by length (`boundedText`, packages/platform/src/external/enrollment.ts:168-186), and flows straight into audit entries at packages/platform/src/external/runs.ts:254 and packages/platform/src/external/admission.ts:389 and :492. Line 492 is the authorization.denied path — the one an unauthorized agent can always reach — where `subject` one line below it IS scrubbed and `correlationId` is not.

Because `correlationId` is inside `computeEntryHash`, the table is append-only by trigger, and packages/platform/src/retention.ts:128-135 refuses any retention rule that touches the chain, anything written there is permanent and unscrubbable. That makes docs/assurance/retention-and-deletion.md §4 — "the audit chain does not need to be modified to honour a deletion request, because it holds digests and opaque references, not owner data" — false, and that is the artifact MVW legal would rely on for a subject-rights erasure.

The cited guard test does not cover this: packages/platform/src/review/pass3-audit-pii.test.ts exercises `subject` only and never sets a `correlationId`. No test in the repo asserts anything about correlationId content.

Separately, packages/platform/src/audit/log.ts:296 claims `AuditLog.verify` "is the method the CLI, the API and the tests use." It is not — cli/main.ts:260-261, api/server.ts:644 and demo/run.ts:219 all call `verifyChain` directly. That divergence is a live bug: unlike `AuditLog.verify`, the CLI passes the watermark on a bounded read, so `pv audit verify --to 3` on a perfectly intact 6-entry chain prints "Audit chain BROKEN ... [chain_truncated] ... 3 entries have been deleted from the end" and exits 1 (confirmed by running the CLI's exact code path). `--to` is documented at cli/main.ts:40 and has no test. It fails safe, but docs/ops/runbooks.md:82-95 tells the operator to treat `chain_truncated` as the highest-priority break and notify MVW security, and its false-positive caveat covers only `--from`.


### R-03

**Claimed.** §5.5 A boundary screen — untrusted text secret-redacted and screened for prompt injection before reaching a model or instruction surface; a screen that errors denies


**Actually.** A working heuristic boundary screen exists and is genuinely wired into six live paths, with behavioural tests that would fail if it stopped refusing injections. Two parts of the claim do not hold. (1) "A screen that errors denies" is asserted by exactly one test — guard.test.ts:988 — and that test's subject, `screenSafely` (screen.ts:250), has zero callers anywhere outside the test; no test in the repo asserts `screen.unavailable` on any reachable path, so the fail-closed clause is verified only against dead code. (2) `POST /api/external/execute` accepts a 32 KB free-form untrusted payload that never touches `screen()` or `redactText()` — external/execute.ts contains neither — and renders it verbatim through `previewOf` into the human-approval preview and into the `parked_actions.preview` column. Proven by running the built module: text the screen scores 13 and refuses, and an AWS key the redactor blanks, both pass through untouched, while the sibling `/runs` route thirty lines away screens its equivalent field for exactly this reason (api/external.ts:583-585). not-production-grade.md L1 records only that the detector is heuristic; it does not record an unscreened entry point or an untested fail-closed path.


### R-04

**Claimed.** §5.7 Per-action authorization — one chokepoint every tool call passes through, each action's risk classified explicitly rather than defaulting


**Actually.** There are two authorization chokepoints, not one, and they disagree.

DONE, and genuinely well built — the internal path. `packages/platform/src/guard/authorize.ts` is a single ordered chokepoint with correct cheap-checks-first ordering that protects approvals from being burned. It is reached by every internal effect I could find: `engine/runner.ts:1231` (every workflow step, with `step.action` mandatory), `documents/generate.ts:245`, `documents/templates.ts:119,232,320`, `contact/gate.ts:532`, `contact/consent.ts:114,211`, `knowledge/ingest.ts:157`, `knowledge/freshness.ts:155`, `improve/{harvest,propose,evaluate,apply}.ts`, `roles/{registry,promotion,evaluation}.ts`, `external/enrollment.ts:584-817`. `guard/guard.test.ts` (76 tests, passing) covers unclassified-action refusal, irreversible-without-human, involvement-weaker-than-tier, duplicate registration, prohibited tier, shadow-mode effects, wrong role, missing scope, missing digest, missing approval, approval-raised-for-a-different-action, chain intactness across grants and denials, and non-consumption of an approval when a cheaper check fails.

NOT DONE — the external-agent path, which is where the claim breaks:
1. `external/execute.ts` (774 lines) and `external/admission.ts` never call `Authorizer.authorize` and never import `ActionRegistry`. Confirmed by grep across all of `src`.
2. `external/admission.ts:265-267`: with no operator rating on the tool grant, effective risk is the caller's own `declaredRisk`. `external/types.ts:46` makes `operatorRisk` optional; `api/external.ts:233,275` default `declaredRisk` to `"routine"`. Risk therefore defaults, twice over, on the one surface where the caller is a third party.
3. Empirically verified: an agent granted an unrated `crm.issue_refund` is admitted with `effectiveRisk: routine` and no approval. That action name is absent from `src/actions.ts`, so the internal chokepoint would have refused it outright as `authorization.risk_unclassified`.
4. No test covers an unrated grant; all eight admission-touching test files set `operatorRisk` explicitly.

Two smaller overstatements in the evidence, worth correcting even though they are not the main defect:
- "Every HTTP read goes through it" is not quite right. `GET /api/session` (`api/server.ts:329-353`) does not call `authorized()`; it returns the actor and the full list of action names their roles permit.
- `POST /api/approvals/:approvalId/decisions` (`api/server.ts:522`) — recording a human approval decision, the most governance-critical write in the console — does not pass the chokepoint either. It relies on `ApprovalService.decide`'s own self-approval, eligibility and step-up checks (`guard/approvals.ts:130-210`), and there is no `approval.decide` action in `actions.ts`. That is arguably correct design (approving cannot itself require approval), but it is a third authorization implementation, so "every tool call" is not literally true even inside the console.

Smallest honest fix that would make the claim true: have the external admission chain resolve `request.tool` through `ActionRegistry` (or require `operatorRisk` on every `ToolGrant` at enrollment, refusing an unrated grant the way `registry.require` refuses an unregistered action), and add a test asserting that an unrated tool grant is denied rather than admitted at the caller's word.


### R-05

**Claimed.** §5.8 Containment controls — global pause, per-workflow, per-role, per-integration, reachable in seconds without a deploy, and they stop in-flight work


**Actually.** Three of the four switches are real, wired, and tested. Global pause, per-workflow and per-integration are checked inside the authorization chokepoint (authorize.ts:73) and re-checked by the workflow engine before every step (runner.ts:1104), so they genuinely stop in-flight work — I confirmed guard.test.ts:832/:857/:880 pass, plus review/pass6-correlation-and-containment.test.ts:152 and engine/engine.test.ts:838/:854. Fail-closed on an unreadable store (containment.ts:57-67, test at guard.test.ts:905) and the compensation exemption (containment.ts:90, test at :924) are both real. Reason is mandatory on both operator paths (cli/main.ts:378, server.ts:672-675) and both engage/release are audited (containment.ts:129-138, :151-160).

What is not true:

1. The per-role switch is inert. `assertClear` only checks it when `roleId` is supplied (containment.ts:107); the sole production-code setter is promotion.ts:652 in `PromotionService.authorizeRoleAction`, which has no caller outside roles/roles.test.ts, and `PromotionService` is never constructed outside tests and is not a field on `Platform`. The workflow engine never passes roleId (runner.ts:1104, :1231-1245). Verified live: with role switches engaged on every plausible target, `authorizer.authorize("contract.check_rescission")` was granted. Engaging `--scope role` shows ENGAGED in `pv containment list` and stops nothing.

2. The global pause cannot be released through the API or console, and blanks the containment screen. Verified live over HTTP: POST engage → 200; POST release → 409 containment.global_pause; GET /api/containment → 409 containment.global_pause. Both routes pass through the chokepoint (server.ts:653, :679) where containment is check #3 with no self-exemption (authorize.ts:73). The console page loads that GET (ContainmentControls.tsx:555), so it shows a denial with no release control. Only `pv containment release` works, and only because cli/main.ts:342-393 bypasses the authorizer entirely on a hardcoded `platform_admin` actor (cli/main.ts:150-153).

3. No test asserts either behaviour. The only role-scoped test in guard.test.ts (:936) counts audit rows rather than checking a refusal, and roles.test.ts:1716 exercises the unreachable method. Nothing tests release-under-pause.

4. Four documents and one console string claim the four-scope behaviour in the present tense: ContainmentControls.tsx:51, docs/handover/admin-guide.md:49, docs/ops/incident-process.md:28, docs/assurance/security-questionnaire.md:268-270, docs/assurance/soc2-control-mapping.md:89. The related "disable the role" procedure (promotion.disable) has no caller either.

The honest claim would be: "global, per-workflow and per-integration containment work and stop in-flight work; per-role is implemented and unit-tested but not wired to any caller; and the global pause currently locks the API and console out of releasing it."


### R-06

**Claimed.** §12 Work discovery — shipped disabled, three independent gates, immutable blocklist floor, structural exclusions enforced in code and tested, short retention, no egress, observed person in control, proposals inert


**Actually.** The privacy engineering in packages/platform/src/discovery/ is real and unusually strong, and the "ships disabled" half of the claim is fully verified in code, in the CLI, and in tests. But the module is a library plus one purge job, not a shipped capability: DiscoveryCollector is constructed at platform.ts:310 solely to feed buildRetentionRules and is not exposed on the Platform object; EnrollmentService and mine.ts have no production callers at all; there is no HTTP route, CLI verb, or console control anywhere under discovery. Two sub-claims therefore fail the reachability bar — "the observed person is in control" (pause/stop/revoke/erase have no invocable surface) and "proposals are inert" (nothing computes a proposal; /api/discovery/candidates is listed as unimplemented at api/console-contract.test.ts:48). Three documents assert otherwise in the present tense: ADR 0012's "enabling this is a configuration change plus an enrollment, not a build" is false (there is no enrollment path, so enabling it is a build); DiscoveryBacklog.tsx:302 promises the observed person controls the product does not have; and discovery/retention.ts:18 claims an over-ceiling retention value is refused at startup, when running `PV_DISCOVERY_RETENTION_DAYS=9999 pv health` returns status ok and silently clamps to 30 — the exact behaviour the comment says is prevented. The retention ceiling, structural exclusions, blocklist floor, egress ban, and the three gates all hold as claimed.


### R-07

**Claimed.** Phase 6 — a seeded deterministic demo telling the earnings story from §2, running twice in a row identically from a cold start


**Actually.** The demo is genuinely seeded, hermetic, and byte-identical across cold starts (verified: two runs diffed clean, exit 0, plus stable under hostile PV_ env vars and two extreme timezones), and its Q2 figures match the cited 8-K summary in docs/context/mvw-priorities.md:167-170. But: (a) demo/corpus.ts:369-370 tells the audience contract ctr_fl_0004 demonstrates effective-dated rule selection, and it does not — a 2024 contract resolves to FL@2 (effective 2020-01-01 → null), the same current version as the 2026 contracts (timeline/rules.ts:99-130, verified by running computeRescissionDeadline directly); only a pre-2020 contract selects FL@1, and no test asserts the version. (b) run.ts:230-232 prints "The chain verifies from the entries alone, so an auditor given an export can check it without access to this system", contradicting run.ts:216-219 and audit/chain.ts:93-106, where the demo deliberately verifies with the watermark because entries alone cannot detect a truncated or emptied chain. (c) The knowledge layer behind demo sections 1 and 2 (IngestionService, Retriever, GroundedAnswerService, run.ts:166-183) has no non-test caller other than the demo — platform.ts wires no knowledge, there is no API route, CLI verb, or console screen for corpora or grounded answers, and api/approval-context.ts:283 states "No corpus is connected to this deployment's approval path." (d) run.ts:713-716 guards module-level execution with `process.argv[1].includes("demo")`; in any checkout path containing "demo" this fires a second concurrent runDemo() — reproduced via symlink: 310 lines, two banners, interleaved duplicate lines — and because the duplication is itself byte-stable, the CI twice-and-diff gate stays green on the corrupt output.


### R-08

**Claimed.** BEHAVIOUR 2: the operator's risk rating floors the agent's declared risk — evidenced by acceptance.test.ts:266 and admission.ts:262-289, with "a declaration can raise but never lower".


**Actually.** The floor itself is real, reachable from every inbound path, persisted correctly, and tested on the screen path at both service and HTTP level — that much of the evidence checks out. But the claim as written is not DONE. (a) The "can raise but never lower" half has zero test coverage: every declaredRisk in every test in the repo is "routine", so the cited test cannot tell `maxRisk(declared, operatorRisk)` apart from `operatorRisk ?? declared`, and a regression to the latter — which would silently downgrade an honestly-declared high_consequence action on a routine-rated tool past the approval gate — passes the whole suite. (b) The floor actively misfires on /report: api/external.ts:528 admits reports with a hardcoded declaredRisk "routine", the operator's rating raises it to high_consequence, and line 534 refuses the report with approval.required while parking a useless `external.report` approval — verified by running admission directly. Completed work under the operator's highest-rated tools can therefore never reach the operating record, contradicting both the "one record" behaviour and admission.ts:234-242's own stated principle, and no test covers it. (c) The rating is dropped at api/external-roster.ts:85 and so is invisible in the console, which nonetheless tells operators (ExternalAgentDetail.tsx:629-632) that the rating overrides the agent's declaration; operators also cannot see that an unrated grant leaves the agent's own word as the only rating (confirmed: unrated tool + declaredRisk routine → allowed/routine).


### R-09

**Claimed.** BEHAVIOUR 3: above the threshold it parks a real approval in the one queue, labelled as an external agent's


**Actually.** Only one of the two above-threshold paths is labelled in the record. The admission-chain screen path (POST /api/external/screen, admission.ts:406) parks a correctly labelled approval and is well tested — that half is DONE.

The governed-execution write path (POST /api/external/execute, execute.ts:272) parks a second, differently-shaped approval whose subject omits `principal: "external"`, `agentName` and `hostPlatform`. Verified by running it: provenanceOf returns kind "workflow", label = the raw `eag_...` id, origin undefined, basis "Raised against the operating record by a platform caller." — indistinguishable from a native workflow approval, and identical to the impostor case hero-screens.test.ts:155 exists to catch. The `[external agent]` prefix is then stripped from the ask on the grounds that the badge carries it, which on this path it does not. No test anywhere asserts the subject or provenance of an `external.execute_write` approval; that string appears exactly once in the repo, at the line that writes it.

Separately, the "Console rendering" evidence does not exist. hero-screens.test.ts is a platform API test. Neither ApprovalsQueue.tsx nor ApprovalDetail.tsx consumes `approval.provenance`; the only component rendering the Workflow / External agent / System change badge required by design-spec.md:277-279 is ApprovalCard.tsx, called only from DesignGallery.tsx:1204. An operator in the real console never sees the external-agent badge on any approval, correctly labelled or not.

Files: packages/platform/src/external/execute.ts:272-289 (the divergent park), packages/platform/src/external/admission.ts:406-464 (the correct one), packages/platform/src/api/approval-context.ts:303-345 (the classifier that reads only subject.principal), packages/console/src/views/ApprovalDetail.tsx, packages/console/src/views/ApprovalsQueue.tsx (no provenance), packages/console/src/ui/domain/ApprovalCard.tsx (gallery-only).


### R-10

**Claimed.** BEHAVIOUR 6: governed read runs immediately; governed write waits for a human and is bound to the exact request — marked DONE by the auditor.


**Actually.** THE PREVIEW NEVER REACHES A HUMAN. `previewOf` (execute.ts:747) is computed, stored on the parked action, and returned to the *external agent* in the 202 body (api/external.ts:753). No operator surface renders it. I drove the real approver path — `approvalDetail(approval, SUPERVISOR, platform)` from packages/platform/src/api/approval-context.ts, which is what `GET /api/approvals/:id` serves (server.ts:518) and what packages/console/src/views/ApprovalDetail.tsx renders — for a parked `owner_records.issue_goodwill_credit` of $250,000 against owner own_4821. The supervisor is served:
  summary: "[external agent] crm-owner-assistant on vendor CRM requests owner_records.issue_goodwill_credit"
  proposal: [externalAgentId, integration, operation, parkedActionId]   ← four ids, no payload
  artifact: (none)
  artifactUnknown: "This deployment holds a digest of the proposal, not its content, so there is nothing to preview inline."
  JSON.stringify(detail).includes("250000") === false; .includes("own_4821") === false
`resolveArtifact` (approval-context.ts:549) only shows content when `digestValue(approval.subject)` equals the proposal digest; the external write's digest is over `{agentId, integration, operation, request}`, so it never matches, and no `decisionContext.artifact` resolver is wired (server.ts:60-67 says so: "Unwired... which is the state this repository ships in"). `api/external-roster.ts:238` — the console's external-agent detail view — maps parked actions and drops `preview` from the projection. Only `pv agents show --json` / `pv agents parked --json` dump it, and the human-readable CLI table omits it. So a supervisor approves a $250k credit having been shown the *name* of the operation and an id, while being told the platform has no content to show — which is false; it holds a rendering of exactly that payload and hands it to the vendor instead. The acceptance test at acceptance.test.ts:581-582 asserts the preview on the value returned *to the caller* (`parked.preview`), i.e. presence on the agent's side, not that any human surface shows it.
Three docs state the opposite in the present tense: docs/external-agents/README.md:226 "a `preview` — the human-readable rendering of your request that an approver will actually read"; docs/adr/0016:71 "parks an approval carrying a preview a human can read"; docs/ops/runbooks.md:437 "the preview a human approved". Against brief §5.3 (park for a human decision) and §18 (an approvals queue showing exactly what is being authorized), the write parks and is digest-bound, but the human cannot see what they are authorizing.

AND THE PREVIEW IS LOSSY EVEN IF SHOWN. `previewOf` slices to 32 top-level entries and truncates each value to 240 chars with no ellipsis, while the API admits 128 keys and 8192-char strings (api/external.ts:135-138). Probed: a 43-key payload produced 35 preview rows and the key `amountUsdTopLevel` was silently absent; a nested object was cut mid-string. The agent controls key order, so it chooses what falls off the end. The digest still binds the whole payload, so what a human never saw is exactly what commits.

THE READ HALF PERFORMS NOTHING IN ANY SHIPPED DEPLOYMENT. `buildExternalPlane` builds `new ConnectorRouter(input.connectors ?? [])` (plane.ts:206). No `Connector` is defined anywhere in the shipped source — only in tests and src/review/harness.ts. `pv serve` calls `buildPlatform(config)` with no connectors (cli/main.ts:612, 670). I built the platform exactly as the CLI does: `platform.external.connectors.describe()` → `[]`. So on a running deployment every governed read returns "No governed operation ... is registered" and every governed write parks an approval that can never commit. "Governed read runs immediately" is demonstrable only in a harness that injects a connector.

TWO SMALLER DEFECTS FOUND WHILE PROBING. (1) When the router refuses a read for mode mismatch, `executeRead` has no catch, so the run it opened is left `external.execute_read` / status `pending` with no `endedAt` — the operating record shows in-flight work that will never finish (probe output: `external.execute_read/pending/ended=-`). The commit path handles this carefully; the read path does not. (2) A write to an integration no connector registers still parks a real approval in the shared queue and spends a supervisor's decision; the commit then fails with `containment.integration_revoked` and the message "Integration \"ghost\" has been disabled since this action was approved", which is untrue — it never existed. The accurate branch (execute.ts:493, "is no longer a governed operation") is unreachable for an unknown integration because `isEnabled` returns false for unknown integrations and is checked first (execute.ts:478).


### R-11

**Claimed.** BEHAVIOUR 7: repeated denials contain the agent automatically; a human releases it; our own failures never count


**Actually.** Automatic containment on repeated misbehaviour denials is real, reachable from the live admission chain, and properly tested. Infrastructure-class denials genuinely never reach the ledger, so our own outages never contain a well-behaved agent — that limb is solid. But "a human releases it" is not true as a durable outcome: `EnrollmentService.release` (enrollment.ts:739-793) flips the status without resetting the denial ledger, and the ledger keeps growing while the agent is contained because contain()'s compare-and-set on `expectedStatus: "active"` returns early (ratelimit.ts:273) before the clearDenials at :277. Reproduced: after a release, a single further denial re-contains instantly on 4 denials, 3 of which were made while already contained; and after a manual contain/release with only 2 prior denials, one post-release denial re-contains on 3. The fix — RateLimiter.clearDenials — exists but has no production caller anywhere, and its docstring at ratelimit.ts:232-238 falsely states that the operator surface calls it after a release. The cited acceptance test papers over this by calling clearDenials itself at acceptance.test.ts:690, a step no API route, CLI verb, or console control performs.


### R-12

**Claimed.** BEHAVIOUR 8: revocation stops the agent instantly, including work in flight


**Actually.** Revocation is durable, terminal, correctly dual-controlled, returns the seat exactly once, and is re-checked on every admission call and every heartbeat — so a revoked agent is refused everything it asks for through the admission chain, and a run whose agent keeps heartbeating is stopped on its next beat with both halves closed.

But revocation does not stop work in flight; it only causes the next voluntary contact to be refused. Concretely, verified by running the real platform through the real approval path:

- revoke() cannot touch runs — EnrollmentService holds no run store (enrollment.ts:493-505, 804-865). Immediately after revocation the external run and the operating-record run are both still "running".
- If the revoked agent never beats again — the normal case — those runs stay open until the external.reclaim_stale_runs maintenance pass (maintenance.ts:136) closes them, ~120s of silence plus up to a 60s loop interval, and only if a separate `pv worker` process is deployed. `pv serve` alone never reclaims them (cli/main.ts:675).
- Revocation does not revoke credentials, and credentials.verify never consults enrollment status (credentials.ts:295/316). POST /api/external/runs/:id/finish (api/external.ts:665-700) runs no admission check, so a revoked agent can still authenticate and close its still-open run as "succeeded" with a self-declared cost, moving the spend meter after revocation.
- The approval guidance shown to the human approving the revocation (enrollment.ts:125-146, rendered by api/approval-context.ts:403) asserts the opposite on two of three effects: runs in flight are NOT reclaimed rather than left open, and credentials do NOT stop verifying.

Honest wording would be: "revocation is terminal and takes effect at the agent's next contact; an in-flight run is stopped on its next heartbeat, or reclaimed by the worker after the heartbeat window if it never beats again. Finishing an already-open run and polling its own approvals remain open to a revoked agent by design."


### R-13

**Claimed.** Enrollment is the basis of admission: dual-controlled, seat-capped, and re-enrollment never resets a meter or lifts a containment


**Actually.** Three of the four properties hold. The fourth — "re-enrollment never resets a meter" — is false in effect, and I proved it by running the real service against the real stores.

WHAT HOLDS (verified, not assumed):
- Dual control on enroll. packages/platform/src/external/enrollment.ts:559-613 authorises through the real Authorizer with `proposalDigest: enrollmentProposalDigest(request)`; ENROLL_ACTION is `high_consequence, approvalsRequired: 1` (enrollment.ts:80-100). The test at enrollment.test.ts:364 uses a real ApprovalService/Authorizer (not a fake) and gets `approval.required` with no approval and `approval.digest_mismatch` for an approval bound to a $5 ceiling when a $250 one is submitted. Self-approval is separately refused at packages/platform/src/guard/approvals.ts:165 (`approval.self_approval`). 31/31 tests pass.
- Seat cap, atomic in both adapters. store.pg.ts:450-469 is a single conditional upsert with a `WHERE external_seat.claimed < $1` guard and a `WHERE $1 >= 1` guard for the first-ever claim; store.memory.ts:282-294 does read-and-increment inside `db.withLock`. store.contract.test.ts:523-556 runs against BOTH adapters (I ran it with PV_TEST_DATABASE_URL set — the banner confirms "both adapters", 145/145 pass) and includes the concurrency races at :547 and :553. Seats are handed back on failure (enrollment.ts:605-612, tested at enrollment.test.ts:~348).
- Re-enrollment never lifts a containment or revives a revoked agent. Whitelist at enrollment.ts:452-489 plus the post-write invariant check at enrollment.ts:655-661; revoked is refused up front at :631-637. Tests at :498, :511, :546 pass, and the fake store is deliberately permissive (`updateAgent` spreads whatever it is handed), so the whitelist really is what is under test.

WHAT IS FALSE — the meter reset:
`budgetPeriod` is in UPDATABLE_FIELDS (enrollment.ts:452-464), and the meter key is DERIVED from it, not stored on the meter: `budgetPeriodKey` returns "lifetime" or "YYYY-MM" (enrollment.ts:365-367, and a duplicate at admission.ts:520-523). Admission reads the meter at that derived key (admission.ts:307-332). So flipping budgetPeriod switches which bucket is consulted, and the new bucket is empty. Nothing guards this: normaliseUpdate (enrollment.ts:1038-1040) validates the value and accepts it unconditionally.

I ran this against MemoryEnrollmentStore, MemorySpendStore, the real Authorizer, ApprovalService and AdmissionService (script at /tmp/claude-0/-home-user-Project-Vacation/6facd511-27fd-5664-b01b-eeee368748e0/scratchpad/probe.mts, no repo file touched):

  enrolled eag_... lifetime ceiling 250
  meter[lifetime] = 250
  BEFORE re-enrollment: budgetPeriod=lifetime meterKey=lifetime spent=250 -> denied ceiling.spend_exceeded
  re-enrolled; status still active ; stored lifetime meter still 250
  AFTER re-enrollment: budgetPeriod=monthly meterKey=2026-08 spent=0 -> allowed

One `sensitive` action, one operator, no approval, no second signature, no step-up (the CLI update path calls `operatorContext(args, context)` with no stepUp argument, cli/external.ts:958) turns a hard `ceiling.spend_exceeded` denial into `allowed` with the full $250 of headroom restored. It works in both directions (lifetime→monthly and monthly→lifetime).

IT IS REACHABLE FROM THE SHIPPED OPERATOR PATH. `pv agents update <agent> --budget-period <monthly|lifetime>` is read at packages/platform/src/cli/external.ts:929-930 and advertised in the usage text at :176. It is NOT in REFUSED_UPDATE_FLAGS (cli/external.ts:889-898), which blocks --spend, --reset-spend, --meter and --status but not --budget-period.

THE DOCUMENTATION IS WRONG IN THE PRESENT TENSE, in six places, and one test asserts the wrong text is present rather than that the behaviour holds:
- cli/external.ts:895-897 "There is no operation anywhere in this platform that clears a spend meter."
- cli/external.ts:975 prints "Its spend meter and its status are unchanged." after the very update that resets it. Literally true of the stored row (the lifetime meter still reads 250), operationally false of the meter that gates admission.
- cli/external.ts:619 "Nothing here clears a meter."
- packages/console/src/views/ExternalAgentDetail.tsx:89 and :585, ExternalAgents.tsx:350 — same sentence to the operator.
- docs/adr/0016-external-agents-governed-not-orchestrated.md:49 and docs/external-agents/README.md:75.
- packages/console/src/views/ExternalAgentDetail.test.tsx:160 asserts the SENTENCE is on screen (`expect(screen.getByText(/no operation anywhere.../))`) — a presence assertion protecting a claim the code does not honour.

SECOND-ORDER EFFECT: after the flip, the orphaned bucket is never read again. health.ts:197-210 and api/external-roster.ts:61-84 both derive the key from the agent's CURRENT budgetPeriod, so the roster, the health page and the console all report the agent as having spent $0 of its ceiling. The over-budget signal disappears from every operator surface, not just from admission.

TEST GAP: no test anywhere changes budgetPeriod through reEnroll. The "NEVER resets a spend meter" test (enrollment.test.ts:484-496) only raises spendCeilingUsd and asserts the stored meter row is still 180 — it asserts the row is intact, never that the agent is still refused. grep for `budgetPeriod` across enrollment.test.ts and cli/external.test.ts returns only fixture values and the pure `budgetPeriodKey` unit test at :697.


---

## What nobody checked — the completeness critic


Cleanup done, working tree untouched, HEAD `c38da93`. Here is what I found.

---

# What nobody checked

Audited at **HEAD `c38da93`** — three commits past the `c19c678` the brief names. All findings below were produced by running things, not reading them. No file was edited.

---

## 1. The approval queue can reject but never grant — every action, every deployment

The brief lens found step-up unwired at `api/server.ts:175`. Nobody followed it to its conclusion. I walked the real operator path and it dead-ends.

**Live proof** (real server, real Postgres, fresh schema):

```
POST /api/approvals/apr_x9xt.../decisions {"decision":"granted"}
  -> HTTP 409  authorization.step_up_required
POST /api/approvals/apr_x9xt.../decisions {"decision":"rejected"}
  -> HTTP 200
```

Three facts compound:

- **No action ever sets `requiresStepUp`.** `grep requiresStepUp` across the platform returns three hits: `api/server.ts:540` (`descriptor?.requiresStepUp ?? true`), `guard/approvals.ts:137` (the optional field), `:195` (the check). `actions.ts` sets it **zero** times — so `?? true` applies to all 35 registered actions, regardless of risk tier.
- **`secondsSinceAuthenticationFor` returns `undefined` unconditionally** (`api/server.ts:175`), so `approvals.ts:195` refuses every grant.
- **There is no CLI verb to decide an approval.** `approvals.decide` has exactly four non-test callers: `improve/approve.ts:226` (inside the dead stage-2-7 clique), `api/server.ts:535` (always refuses), and `demo/run.ts:602,615`.

**The ten actions this locks out are the platform's entire governed surface** — every action with `approvals >= 1`, confirmed from `pv actions list`:

`contact.send_owner_message` · `document.generate_owner_facing` · `external_agent.enroll` · `external_agent.revoke` · `identity.issue_service_credential` · `improvement.apply` · `owner.delete_data` · `owner.export_data` · `role.promote` · `discovery.enroll_device`

I confirmed the operator dead-end end to end. `pv agents enroll ... --raise-approval` succeeds and prints:

> Approval apr_… raised. Somebody other than cli:unknown-operator must grant it

There is no surface on which anybody can. The CLI has no decide verb; the HTTP route refuses.

**This reframes four other lenses.** The external plane is not blocked by an empty connector registry — it is blocked one step earlier, at enrollment. The improvement loop is not only missing stages 2-7 — `improvement.apply` could not be approved if they were wired. The role factory has no promotion surface *and* `role.promote` is un-grantable. Subject rights are blocked twice over. The single fix — wiring session resolution so `secondsSinceAuthenticationFor` returns a real number — unblocks more of the brief than any other change in the repo.

## 2. The demo grants approvals by inventing the observation the product cannot make

`demo/run.ts:615-621` is the only thing in the repository that successfully grants an approval, and it does so by hard-coding the value:

```ts
requiresStepUp: true,
secondsSinceAuthentication: 30,
```

The demo then prints (line 123 of its output, which I ran):

> `approved by   demo:dana (after step-up re-authentication)`

No re-authentication occurred; `30` is a literal. The flagship demonstration — the artifact shown to MVW to prove the governance story — demonstrates the one capability the shipped product cannot perform. The failing-closed choice at `server.ts:535-557` is correct and well-commented; the demo silently routes around it.

## 3. The README maps a directory that has never existed

`README.md` "What is here" lists:

```
  workflows/     the shipped workflow definitions
```

`packages/platform/src/workflows/` **does not exist**, and `git log --all` shows it never has. I verified all 21 listed directories: 20 exist, `workflows/` is the only miss, and both listed files (`maintenance.ts`, `retention.ts`) are present. There is also no `WorkflowDefinition` literal anywhere outside `engine/` and tests.

This is the fourth instance of the pattern the brief warns about, and it is the worst-placed one: it sits in the file a new engineer reads first, and the thing it invents is precisely the largest capability gap in the product (§6, the engine no work ever enters).

## 4. One reported defect is already fixed — the brief lens is stale here

The brief lens's §21 finding that `pv serve --seed` discards `PV_HTTP_PORT` and prints a port it did not use is **no longer true**. Commit `a853772` ("fix: two defects in the seeded server, both found by running it", 22:04, landed *during* the audits) fixed it. Verified clean:

```
PV_HTTP_PORT=8099 pv serve --seed
  prints: "API listening on port 8099, serving the seeded demonstration."
  8099 -> 200      8080 -> 000
```

The same commit also fixed the "record is gone — nothing left on disk" narration under `--seed`. Worth deleting from the owner's list before planning around it.

## 5. "Verifiable from an export" is promised four times with no export verb and no published algorithm

`dpa-support.md:72`, `retention-and-deletion.md:122`, `security-questionnaire.md:429` and `data-inventory.md:51` all tell a buyer the chain is independently verifiable from an export. There is no `pv audit export` verb (`grep export packages/platform/src/cli/main.ts` returns nothing).

`pv audit query --json` does emit `previousHash` and `entryHash` per entry, so the links are genuinely there. But two things stop a third party using it: the canonicalisation is never specified — every doc reference points at `kernel/canonical.ts` rather than describing the algorithm, so MVW's auditor must read TypeScript and reimplement it byte-exactly; and the watermark is not in the export, so truncation, the one attack the chain design exists to catch, is undetectable from entries alone. That is the same gap the refuted lens found the demo contradicting itself about.

## 6. `evaluate --ci` will report "NOTHING WAS EVALUATED" in every deployment, permanently

Run against real Postgres with the full schema applied:

```
NOTHING IN THIS DEPLOYMENT'S ROLE REGISTRY WAS EVALUATED.
The registry holds no promoted role... Promote a role and this gate starts covering it.
```

The remedy it offers is impossible twice over: there is no promotion surface (`RolePromotionService` has no caller outside tests), and `role.promote` is one of the ten un-grantable actions from finding 1. The banner is honest about the state; its instruction cannot be followed.

**Resolved (wave 4, with finding 1 already fixed in wave 1).** The promotion surface exists — `pv roles` reaches the composed `RolePromotionService` — and `role.promote` is grantable now that step-up and the `pv approvals decide` verb are wired. Driven by hand: a role authored, evaluated, approved by a second person, and promoted, after which `pv evaluate --ci` prints the promoted role's result (PASS) and the banner is absent. The instruction the banner gives can now be followed end to end. See T-09's resolution note above.

---

# What passed cleanly

Under the assume-nothing stance, these are worth recording as genuinely verified:

- **Migration registry into an empty database — clean.** Created a fresh DB, `pv db migrate` applied 18 migrations, exit 0. Re-ran: "No pending migrations", exit 0. `pv db status` reports `18 applied, 0 pending, 0 unrecognised, 0 changed`. The missing `0004`/`0005` and the duplicate `0018_audit_watermark` / `0018_external_parked_committing` are both deliberate and explained at `store/registry.ts:22-42` — ids are allocated in blocks, the whole id is the identity, and `orderMigrations` sorts deterministically. Correct call, not a defect.
- **`.env.example` — zero drift, both directions.** Every `PV_` key read anywhere in `packages/`, `tools/` and `.github/` is documented, and every documented key is read. The only other env reads in the entire codebase are `USER` and `PV_TEST_DATABASE_URL`.
- **Every CLI verb the usage text advertises exists and runs.** I executed all of them: `db migrate|status`, `audit verify|head|query`, `containment list|engage|release`, `actions list`, `approvals list`, `cost report`, `models degradation`, `engine timers`, `evaluate --ci`, `config show`, `health`, `serve`, `worker --once`, `demo run`, and the full `agents` sub-tree (`list show health enroll update contain release revoke credential runs parked`). The `agents` usage reachable via `pv agents` documents `--spend-ceiling` and `--budget-period`, which the top-level summary elides — the summary correctly says to run `agents` alone for the full form. Empty-state copy is unusually disciplined throughout ("An empty chain is what a deployment that has recorded nothing looks like. It is not evidence that anything is intact.").
- **OpenAPI matches the server exactly.** All 7 declared paths are served, and the served route set is exactly those 7 — no undocumented route, no documented ghost. The unusual 409-instead-of-403 choice is deliberate and explained in the `Denied` component.
- **Demo is deterministic and still tells the earnings story.** Two cold runs byte-identical at HEAD; figures (+22% / $545M, 112,721 tours, $4,477 VPG) match the cited 8-K.
- **Console builds clean** (`vite build`, exit 0, 164 KB gzip JS / 18 KB CSS).
- **Ops docs reference only four API paths** (`/api/runs`, `/api/approvals`, `/api/audit`, `/api/session`) — all live. No runbook points an operator at one of the seven 404 routes.
- **The subject-rights gap is disclosed, not hidden.** `subject-rights-runbook.md:12-13` carries a banner saying none of the five `pv subject-rights` / `pv consent revoke` verbs exist. The only remaining doc-to-nonexistent-command references are inside `buyers-gauntlet.md`, where they are quoted *as* failures.

---

# What this changes about the plan

The repo's own self-assessment is that seven subsystems are built-but-unreachable, and that identity is the blocker. That is right, but it understates the blast radius by one step: **identity is not just gating the console's login — it is gating every human approval in the product.** Until `secondsSinceAuthenticationFor` returns a real number, the governance spine that the brief calls the whole point of the platform is a queue that can only say no. That single fix is worth more than the six other subsystem wirings combined, because all of them terminate in an approval.

Second: the repo is being committed to underneath its own review documents. `a853772` fixed a defect *while it was being audited*, and another session had a vite server running throughout mine. Any list the owner works from should be re-verified against HEAD, not against `c19c678` — I found one item already dead on arrival.