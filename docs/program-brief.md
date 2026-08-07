# Project Vacation — program brief

You are starting **Project Vacation**, a purpose-built AI operations platform for
**Marriott Vacations Worldwide** (NYSE: VAC). This is a custom build for one
customer, in its own repository, written from scratch. There is no existing
codebase to port and none to read.

The target is not a demo and not a pilot. The target is **a platform MVW's risk
committee, security team, and IT operations will approve, deploy, and run** —
that their staff use daily, that their engineers can extend after handover, and
that gets measurably better over time without ever changing its own behavior
behind a human's back.

Read this whole brief before writing code. Part V lists what to confirm with the
owner — ask those before you build, not after.

---

# PART I — CHARTER

## 1. The one hard rule

**MVW will receive this source code.** Everything here must be independently
written for this project.

- Do **not** copy, port, paraphrase, or reference any other codebase, product,
  internal platform, or prior art the owner may have. If the owner mentions
  another system, treat it as background only — never as a source to transcribe.
- Do **not** reuse another product's module names, package names, config keys,
  event names, CLI verbs, or file layouts. Pick names that fit *this* product.
- Every design choice must be justifiable from MVW's requirements and standard
  public engineering practice alone. If you cannot explain it that way, it does
  not belong here.
- No AI-attribution footers or trailers anywhere — commits, PR titles or bodies,
  code comments, docs.

## 2. First task, before any code

MVW released **Q2 2026 earnings on the morning of 6 August 2026**. Fetch the
release, the presentation, and the call transcript if available. Write
`docs/context/mvw-priorities.md` containing:

- Management's stated near-term priorities, in their own words, with citations.
- The stated pressure points — where revenue, margin, or cost is moving the
  wrong way, and what they said they will do about it.
- Operational metrics they highlighted (contract sales, VPG, tour flow,
  delinquency and default rates, provision for loan loss, maintenance-fee
  collections, occupancy, membership counts, cost-savings programs).
- Any technology, digital, or efficiency initiative they named.

Then map each priority to where an AI operations platform could plausibly move
that number, and rank candidate workflows by (impact on a metric management
named) × (feasibility without deep systems integration). Show your reasoning —
the owner needs to be able to disagree with it.

Do not invent numbers. Quote and cite. If a document is unavailable, say so and
note what is missing rather than filling the gap from memory.

**Then stop and bring the ranked list to the owner** before writing application
code.

## 3. The business you are building for

MVW is vacation ownership at scale — Marriott Vacation Club, Sheraton and Westin
Vacation Clubs, Hyatt Residence Club, and the Interval International exchange
network. Revenue comes from selling vacation ownership interests, financing
those sales as consumer loans, managing resorts and their homeowners'
associations, renting unsold inventory, and running an exchange membership
business.

Entities that matter: **ownership** (points and weeks, banking and borrowing
across use years, usage rules, trust and deeded structures); **reservations and
inventory**; **consumer finance** (origination at point of sale, servicing,
delinquency, provision for loan loss, securitization); **maintenance fees and
HOA** (annual billing, collections, association budgets, reserve studies, board
reporting across many associations); **sales and marketing** (tour generation,
presentations, VPG, rescission); **exchange**; and **owner services**, the
contact-center surface across all of it.

Learn this domain properly before designing anything, and have the owner check
your understanding before you build on it.

### The regulatory reality — this is the product thesis

Vacation ownership is one of the most heavily regulated consumer businesses that
is not a bank. Each of these is where an ungoverned agent creates real liability
and a governed one is defensible:

- **Statutory rescission.** Cancellation windows are set by state law and vary by
  state. The clock, its trigger event, tolling, and proof of compliance are the
  whole ballgame — get it wrong and the contract is void.
- **Consumer lending disclosure** — TILA / Regulation Z at point of sale.
- **Fair lending and collections conduct** — ECOA and UDAAP exposure, plus FDCPA
  patterns where third parties are involved. Anything that prioritizes, scores,
  or sequences consumers is a disparate-impact question (§14).
- **Outbound contact** — TCPA, state do-not-call rules, consent capture, proof,
  and revocation handling.
- **Sales presentation conduct** — FTC and state attorney-general scrutiny.
- **Owner data** — CCPA/CPRA and other state privacy laws, GDPR for European
  owners, PCI for card payments.

The pitch is **not "we automate." It is "we automate with a record that survives
an audit."**

## 4. What "enterprise deployable" means here

The definition of done for the program. Nothing reaches production without all
of it.

**Security.** SSO, least privilege, encryption in transit and at rest with
managed keys, no secrets in source or logs, dependency and container scanning
with a remediation SLA, a written threat model, signed builds with provenance.

**Privacy.** A data inventory, documented retention and deletion, working
subject-rights handling, data minimization enforced in code, deliberate
avoidance of card data.

**Reliability.** Stated SLOs, health checks, graceful degradation when a
dependency or model provider fails, backups with a **tested restore**, a
documented RTO/RPO.

**Operability.** Structured logs, metrics, traces, alerts that page a human,
runbooks for every alert, an incident process with postmortems.

**Change safety.** Infrastructure as code, separate environments, zero-downtime
migrations, one-command rollback, feature flags for anything risky.

**Model governance.** A model inventory, evaluation gates on quality, change
control when a model or prompt changes, bias testing where consumer outcomes are
affected, a documented human-in-the-loop policy by risk tier.

**Assurance artifacts.** The documents procurement and risk will ask for,
written and kept current in the repo (§16).

**Handover.** MVW's engineers can clone, run, understand, extend, and operate
this without you.

---

# PART II — PLATFORM CAPABILITIES

This is a platform, not a script. MVW must be able to add work without calling
you, and the platform must get better over time — with a human in every path
that changes behavior.

## 5. The spine

Small, boring, correct. All of this exists before any workflow ships.

1. **An operating record.** Durable storage for units of work: what was
   requested, who or what owned it, every step, what it cost, how it ended.
   Everything else reads from this. Treat released migrations as immutable; make
   schema changes additive and zero-downtime.
2. **A tamper-evident audit log.** Append-only, hash-chained, verifiable after
   the fact, recording decisions and the fingerprints of their inputs — never raw
   payloads, never secrets. Ship a verify command that fails loudly on a broken
   chain, and define retention.
3. **Human approvals with dual control.** High-consequence actions park for a
   human decision bound to a digest of exactly what was proposed, so nothing can
   be swapped after approval. Support N-of-M and segregation of duties (a
   requester cannot approve their own request). Approvals are single-use and
   expire.
4. **Ceilings enforced at consumption** — spend, rate, and time — not only at a
   pre-flight check.
5. **A boundary screen.** Untrusted text (owner messages, uploaded documents,
   third-party data) is secret-redacted and screened for prompt injection before
   reaching a model or an instruction surface. A screen that errors **denies** —
   a screen that cannot answer is not an answer of "clean."
6. **A sandbox** for any code or command execution, with the containment boundary
   configurable and the unsafe setting loudly flagged at startup and in the
   health check.
7. **Per-action authorization** — one chokepoint every tool call passes through,
   with each action's risk classified explicitly rather than defaulting.
8. **Containment controls.** A global pause, per-workflow disable, per-role
   disable, and per-integration revocation, all reachable by an operator in
   seconds without a deploy. Test that they actually stop in-flight work.

Design principle throughout: **fail closed**. Missing config, unreadable store,
broken screen, unavailable receipt — each refuses the action rather than
proceeding unrecorded.

## 6. The workflow engine

Enterprise work is multi-step, long-running, and full of human beings. Build a
real engine; do not chain function calls and hope.

**Requirements:**

- **Declarative definitions**, versioned in source control. A running instance
  pins the version it started under, so a mid-flight definition change cannot
  alter its behavior.
- **Durable and resumable.** A process restart, a deploy, or a crash must not
  lose an in-flight instance. Steps are idempotent and each has an idempotency
  key; retries never duplicate an external effect.
- **Explicit step types**: automated action, model call, human task, approval
  gate, wait-for-event, timer, branch, parallel fan-out, and compensation.
- **Compensation for anything irreversible.** If a step cannot be undone, it
  requires an approval gate before it, and the definition declares the
  compensating action for everything after it.
- **SLAs and escalation** per step — a human task that ages past its target
  escalates by a rule, and the breach is visible on a queue, not buried.
- **Observable by non-engineers.** A supervisor can see where an instance is,
  why it is stuck, what it has cost, and what it is waiting for.
- **Time is a first-class input.** Statutory clocks (§3) are workflow timers with
  explicit timezone handling, business-day rules, and tolling. Never compute a
  legal deadline with naive date arithmetic; centralize it in one tested module
  with per-state rules as data, not code.

## 7. Agent roles and the role factory

MVW must be able to add new capability without an engineering cycle — but a new
agent role is a **change to the system's behavior** and gets treated like one.

- **A role is a versioned artifact**: name, purpose, the tools it may call, its
  risk ceiling, its data scope, its model assignment, its prompt, its evaluation
  set, and its human-in-the-loop tier.
- **Authoring surface.** An admin describes the job in plain language; the
  platform drafts the role definition. That draft is a *proposal*, never a live
  role.
- **Promotion requires evidence**: the role runs against its evaluation set, the
  results are recorded, and a human with authority approves it. Only then can it
  act, and only within its declared ceilings.
- **Every role change is versioned, diffable, attributable, and revertible.**
- **Roles are few and purposeful.** Do not build a marketplace or a catalog of
  hundreds. If two roles differ only in prompt wording, they are one role.
- **A role can always be disabled instantly** (§5.8) without a deploy.

## 8. The knowledge layer

The compliance workflows are unbuildable without governed retrieval. This is not
optional infrastructure.

- **Curated corpora** with explicit ownership: state statutes and rescission
  rules, HOA governing documents and budgets, disclosure and contract templates,
  contact and consent policy, internal SOPs, product and usage rules.
- **Provenance on every chunk** — source document, version, effective date,
  jurisdiction, who ingested it, when. A retrieved passage without provenance is
  unusable in a regulated answer.
- **Citations in output.** Any model answer that relies on retrieved material
  cites the source and version. A compliance reviewer must be able to click
  through to the passage.
- **Effective-dating.** Statutes and policies change. The system must be able to
  answer "what did the rule say on the date of that contract," not only what it
  says today.
- **Ingestion is governed**: documents are screened (§5.5), classified, and
  access-scoped. A poisoned or unauthorized document must not enter the corpus
  silently.
- **Freshness and review.** Each corpus has an owner and a review cadence; stale
  authority is flagged in the console, not silently trusted.
- **No answer without grounding** for regulated questions — if retrieval finds
  nothing adequate, the system says so and routes to a human. It never
  improvises a legal deadline.

## 9. Documents and correspondence

Vacation ownership runs on documents. Treat generation as a governed action.

- **Templates are versioned artifacts** with owners and approval history.
- **Generated documents record** which template version, which data, which model
  (if any), and who approved — bound to the operating record.
- Support the formats MVW actually uses for owner letters, disclosures, board
  packs, and association reporting. Ask before assuming.
- **Anything sent to a consumer** passes the contact-compliance gate (§10) and,
  above the risk threshold, a human approval.

## 10. Channels and contact compliance

If the platform ever contacts an owner, this is the highest-liability surface in
the product.

- **One outbound gate.** Every outbound message, call, or text passes a single
  chokepoint that verifies consent on record, do-not-call status, quiet hours by
  jurisdiction, frequency caps, and revocation — and records the evidence of
  that check with the message.
- **Consent and revocation are first-class data** with provenance and timestamps,
  not a boolean someone set once.
- **Inbound is untrusted** (§5.5) and screened before it reaches a model.
- Build the gate before the first outbound channel, not after.

## 11. Integrations

- Every system of record sits behind a **narrow, versioned interface** with a
  realistic fake behind it and contract tests both sides must satisfy.
- Outbound calls are **allowlisted by host**, credential-scoped, rate-limited,
  retried with backoff and idempotency keys, and recorded.
- A failing integration **degrades explicitly** — queue, park for a human, or
  refuse. It never silently produces a worse answer.
- Credentials live in a secret manager, are individually revocable, and are never
  logged or placed in an audit record.

## 12. Work discovery — evidence instead of opinion

The hardest question in a program like this is *what to automate next*. Opinion
and anecdote pick badly. This capability answers it with evidence: observe how
repetitive work actually flows, detect sequences that recur, and propose
candidates for the backlog.

It is also **the most legally sensitive component in the product**, because it
observes employees. Build it privacy-first or do not build it.

**What it may observe:** normalized application transitions and their timing —
enough to reconstruct that a person moved between allowlisted applications in a
recurring order.

**What it must never capture:** screen contents or pixels, window titles,
keystrokes, clipboard, URLs or query strings, document contents, form values,
message or email bodies, or customer records. These are not configuration
options. They are structural exclusions, enforced in code and covered by tests
that fail if the boundary moves.

**Required controls:**

- **Off until explicitly enrolled.** Three independent gates: the feature
  enabled, a named owner and device enrolled with a positive application
  allowlist, and a collector started deliberately. An empty allowlist observes
  nothing.
- **An immutable blocklist floor** covering communication tools and systems of
  record, which always beats the allowlist and cannot be weakened by enrollment
  policy.
- **Short retention** — days, not months, with a hard ceiling. Candidate
  opportunities are computed on demand rather than accumulated in a second
  store.
- **No egress.** Observations stay inside the deployment's data boundary and are
  never sent to a model provider or third party.
- **The observed person is in control**: pause, stop, revoke, and erase are
  available to them at any time, without an administrator and without provider
  access.
- **Proposals are inert.** Discovery may produce a draft workflow and a draft
  role. It may never execute, save, schedule, or activate either. A human
  promotes a draft through the normal role and workflow governance (§7, §13).

**Before this ships, resolve with the owner and MVW's employment counsel:**

- Employee notice and consent, and whether it is opt-in per person.
- **State electronic-monitoring notice laws** — several states require advance
  written notice; requirements vary and some carry penalties.
- **Any European or non-US staff** — works-council consultation and GDPR
  obligations attach, and in several jurisdictions monitoring without
  consultation is unlawful regardless of consent.
- Union or collective-agreement constraints.
- Whether contact-center staff, whose work is already recorded for QA, are
  treated differently from corporate staff.

If the answer to any of these is unresolved, build the rest of the platform and
leave this switched off. The backlog can be chosen from interviews and metrics
in the meantime; a privacy incident here would cost far more than the
prioritization it buys.

## 13. The improvement loop — human-gated, never autonomous

The platform gets measurably better over time. It does this **without ever
changing its own behavior on its own authority.** Build exactly this and no more:

**What it does:**

1. **Harvest signal.** Every human correction, rejected proposal, approval
   override, escalation, and shadow-mode disagreement (§19) is captured as a
   structured observation tied to the run that produced it.
2. **Cluster and surface.** Recurring failure patterns are grouped and ranked by
   frequency and cost, and shown to an operator — "this role misreads X in 12% of
   cases" — with the evidence attached.
3. **Propose.** The system drafts a candidate change: a prompt revision, a new
   evaluation case, a rule adjustment, a routing change, a knowledge-corpus gap
   to fill. A proposal is inert data.
4. **Evaluate.** Every proposal is scored against the affected role's golden set
   before a human sees a recommendation. A change that does not improve measured
   quality is not offered.
5. **Approve.** A human with authority approves or rejects, seeing the before and
   after, the evaluation delta, and the blast radius.
6. **Apply, versioned and reversible.** Applying takes a snapshot, records the
   change in the audit log, and can be reverted to the prior state in one action.
7. **Watch.** Post-change quality is tracked against the pre-change baseline; a
   regression alerts and offers the revert.

**Hard boundaries — state these in the code and the docs:**

- **No autonomous application.** Nothing in this loop may change behavior without
  a recorded human decision. There is no configuration that disables the gate.
- **No self-modifying code.** The loop proposes changes to *declarative
  artifacts* — prompts, rules, routing, evaluation sets, corpora — never to the
  platform's source.
- **The evaluation sets are protected.** A proposal may *add* cases; it may never
  weaken, relabel, or delete an existing expected outcome. Otherwise the system
  learns to move the goalposts instead of improving. Enforce this in code and
  test it.
- **Golden sets are curated by humans** and treated as the ground truth of record.

This is the honest, defensible version of continuous improvement: everything a
"self-improving system" claims, with a person in the one place that matters.

---

# PART III — ENTERPRISE READINESS

## 14. Model governance

Where MVW's risk committee will spend its time. Build it; do not document it
aspirationally.

- **Model inventory.** Which model serves which task, at which version, with what
  fallback. Never hard-code a model in business logic — resolve from
  configuration.
- **Evaluation harness with golden sets.** Every role and workflow ships with a
  curated set of real-shaped cases and expected outcomes. Quality is measured,
  not asserted; a regression below threshold fails CI.
- **Change control.** A model version change, prompt change, or threshold change
  is a reviewable change that re-runs evaluation and is recorded. Prompts live in
  version control, never hand-edited in a database.
- **Bias and fairness testing where consumer outcomes are affected.** If the
  platform prioritizes, scores, sequences, or targets consumers — collections
  ordering, contact strategy, anything credit-adjacent — test for disparate
  impact across protected classes and record the result. Engage MVW compliance
  before such a workflow goes live. Where an outcome could be adverse to a
  consumer, the human is the decision-maker and the system is the
  evidence-gatherer.
- **Human-in-the-loop policy by risk tier**, written down: what is automatic,
  what is proposed-then-approved, what is human-only.
- **Provider terms.** Confirm zero data retention and no training on MVW data, in
  writing, and record it.
- **Graceful degradation** when a provider is slow, rate-limited, or down.
- **Framework mapping.** Maintain a document mapping your controls to **NIST AI
  RMF**, and assess **EU AI Act** applicability given European owners.

## 15. Identity, access, and tenancy

- **SSO** against MVW's identity provider (assume Okta or Microsoft Entra;
  confirm) via OIDC or SAML. No local password store.
- **SCIM or directory-group provisioning** so access follows the HR lifecycle and
  a departing employee loses access automatically.
- **Roles that match how MVW works** — owner-services agent, supervisor,
  compliance reviewer, HOA/association manager, finance, platform admin, and an
  auditor role that sees everything and changes nothing.
- **Step-up re-authentication** for high-consequence actions: approving a role
  promotion or an improvement proposal, issuing credentials, exporting owner
  data.
- **Service accounts** for machine callers, scoped and individually revocable.
- Single customer — **do not build multi-tenancy** unless the owner says
  otherwise. Keep a clean data-scoping seam so it stays possible.

## 16. Assurance artifacts

In `docs/assurance/`, current, written for an outside reader:

- **Threat model** (STRIDE or equivalent) with mitigations mapped to code.
- **Data inventory and flow map** — what personal data is held, where it goes,
  who can see it, how long it is kept.
- **Retention and deletion policy**, and the code that enforces it.
- **Subject-rights runbook** — access, deletion, correction, opt-out, with
  working tooling.
- **SBOM** (CycloneDX or SPDX) generated in CI, plus a vulnerability policy with
  severity-based remediation SLAs.
- **Security questionnaire pre-answers** (SIG Lite / CAIQ shape).
- **SOC 2 control mapping** — which criteria the design satisfies, which depend
  on MVW's environment. Map readiness; never claim certification.
- **Penetration-test readiness notes** — scope, test accounts, known limits.
- **Architecture decision records** for every consequential choice.
- **DPA support material** — subprocessors, data locations, encryption
  specifics, breach-notification facts (legal owns the contract; you supply
  accurate facts).

Write these as you build. Retrofitting them is how programs slip a quarter.

## 17. Reliability, operations, and cost

- **SLOs** for the surfaces that matter, with error budgets.
- **Backups with a tested restore.** A backup you have never restored is a hope.
  Automate a restore drill and record its result.
- **DR**: documented RTO and RPO, and a failover you have actually exercised.
- **Load testing** at realistic volume — MVW has a large owner base and seasonal
  peaks. Size from real numbers and record the ceiling you measured.
- **Observability**: structured logs with correlation ids, metrics, traces,
  dashboards for the SLOs, alerts that page, each with a runbook.
- **Incident process**: severity levels, on-call, comms template, blameless
  postmortems — and specifically **what to do when the AI is wrong**, including
  how to find every action a bad model or prompt version touched, and how to
  notify and remediate affected owners.
- **Cost per unit of work.** Model and infrastructure cost per case, per
  workflow, per department, with budget alerts before overruns. MVW will ask what
  a resolved case costs; have the number.

---

# PART IV — PRODUCT SURFACE

## 18. The console

A web application. **Two themes only: light and dark.** One coherent design
system, no third variant, no glass or blur experiments. Legible on a laptop in a
conference room.

- **Accessibility: WCAG 2.2 AA** — contrast, focus order, labelled controls,
  keyboard reachability, screen-reader sanity. Automated checks in CI so it
  cannot rot; MVW is a consumer-facing brand with ADA exposure.
- Surfaces: the work queue; an approvals queue showing exactly what is being
  authorized; a per-run detail view with the full step trail and its cost; a
  workflow instance view a supervisor can read; the role registry with versions
  and evaluation results; the improvement queue (§13); the discovery backlog when §12 is enabled; an audit and evidence view
  a compliance officer can use unaided; an executive view tied to the metrics
  management named in the earnings release.
- Ask the owner about **Spanish** support for owner-facing or staff-facing
  surfaces.
- Brand care: MVW licenses Marriott, Sheraton, Westin, and Hyatt marks. Be
  conservative with logos and naming until someone with authority signs off.

## 19. Rollout: earn autonomy, never assume it

Every workflow walks this ladder, and each rung is a real mode in the product:

1. **Shadow.** The agent proposes; humans work as usual; the system records both
   and measures agreement. Zero risk, builds the golden set, builds the business
   case, and feeds the improvement loop.
2. **Assisted.** The agent drafts, a human edits and commits. Measure edit
   distance and time saved.
3. **Supervised.** The agent acts, a human approves before the effect lands.
4. **Bounded autonomy.** Low-risk, high-confidence cases proceed automatically
   within explicit limits; everything else parks. Never for anything with
   consumer-adverse consequences.

Promotion between rungs is a decision with evidence attached — golden-set
accuracy, shadow disagreement rate, incident history — not a date.

## 20. What NOT to build

Their absence is a feature. Say no explicitly:

- **No autonomous self-modification.** No system that changes its own behavior,
  prompts, rules, or code without a recorded human decision. §13 is the
  sanctioned form and its gate is not configurable.
- **No agent marketplace or capability catalog.** Few, purposeful roles.
- **No offline reflection or dreaming subsystem.**
- **No plugin or extension marketplace.**
- **No multi-tenancy** unless the owner says otherwise.
- **No card data.** Never accept, store, or transmit primary account numbers.
  Design deliberately to stay out of PCI scope, say so in the architecture docs,
  and hand off to MVW's payment systems by reference.

If something seems to require one of these, stop and ask. The answer is usually a
simpler mechanism with a human decision in it.

---

# PART V — EXECUTION

## 21. How to work

- **A feature is not done until something calls it.** A module with tests and no
  caller is inert. Before claiming a capability, name the path a real user or
  agent takes to reach it, and test that path.
- **Run the whole test suite before claiming it passes.** Focused runs miss
  namespace collisions, shadowed commands, and cross-module regressions.
- **Gates prove the code does what the tests say. They do not prove the feature
  is connected, or that your summary is true.** Re-read every PR description
  against its own diff and delete anything aspirational.
- **Attack your own work before asking for review.** Hunt specifically for replay
  and idempotency holes, state two processes can race, a kill switch an in-flight
  operation can outrun, bounds evaded by padding a different field, and error
  paths that fail open.
- **Deterministic demos.** Seeded data reproduces exactly from one command.
- **Never publish a measurement from a dirty working tree**, and never state a
  result without saying plainly what was and was not measured.
- **Secrets**: never committed, never logged, never in an audit record. Secret
  scanning in CI from day one.
- Conventional-commit PR titles, small reviewable PRs, tests with every behavior
  change, ADRs for consequential decisions.

## 22. Sequence and exit gates

Do not start a phase until the previous gate is met.

**Phase 0 — Foundation.** Repo `project-vacation`. Stack chosen by you and
justified in an ADR: boring, well-supported technology MVW's engineers can
maintain. CI running tests, lint, secret scanning, dependency scanning, SBOM, and
accessibility checks.
*Gate:* a new engineer goes clone-to-running locally in under fifteen minutes on
the README alone.

**Phase 1 — Spine and identity** (§5, §15), with tests proving the fail-closed
behavior of every control.
*Gate:* an auditor role can read a complete, verifiable record of a synthetic
action, and every containment control demonstrably stops in-flight work.

**Phase 2 — Workflow engine and knowledge layer** (§6, §8).
*Gate:* a multi-step workflow with a human task and a timer survives a process
restart mid-flight and resumes correctly; a regulated question returns a cited,
effective-dated answer or refuses.

**Phase 3 — First workflow end to end**, intake through governed action to an
audit record a compliance officer reads unaided. Roles defined (§7), golden set
and evaluation harness shipped.
*Gate:* measured quality on the golden set meets a threshold agreed with the
owner in advance, running in shadow mode.

**Phase 4 — Console** (§18) over that workflow, light and dark, WCAG 2.2 AA.
*Gate:* an MVW operator completes a real task unaided, watched, without you
narrating.

**Phase 5 — Improvement loop** (§13) closed end to end.
*Gate:* a real observation from shadow mode becomes a proposal, is evaluated,
approved by a human, applied, and reverted — all visible in the audit log; and a
proposal that weakens an evaluation case is refused by the system.

**Phase 6 — Demo.** Seeded, deterministic, tells the earnings story from §2.
*Gate:* runs twice in a row identically from a cold start.

**Phase 7 — Production readiness.** Everything in §4, §16, §17: IaC,
environments, zero-downtime migrations, rollback, backups with tested restore, DR
exercise, load test at real volume, observability with runbooks, incident
process, cost reporting, assurance artifacts complete.
*Gate:* a restore drill and a failover exercise both pass, on the record.

**Phase 8 — Handover.** Admin and operator documentation, training material,
support and escalation path, an honest written list of what is *not* production
grade, and a walkthrough with MVW's engineers.
*Gate:* an MVW engineer deploys a small change to a non-production environment
without your help.

## 23. Do not assume — verify

You do not know MVW's internal systems. Do not design integrations against
guesses (§11). Do not assume volumes, org structure, state coverage, or which
regulations bind which entity. Getting this wrong is the most expensive mistake
available to you.

## 24. Confirm before building

Bring these to the owner:

- Deployment target (cloud and region) and any data-residency constraint.
- Identity provider, and whether SCIM is available.
- Whether real or synthetic MVW data is available, and under what agreement.
- The named first workflow, once they have seen your ranked list.
- Approved model providers and models, where keys live, and whether zero
  retention is contractually in place.
- Timeline, and the first date anything must be shown to anyone.
- Who at MVW owns security, privacy, and compliance sign-off — and when to
  engage them (early is cheaper).
- Which systems of record the first workflow must touch, and who owns each.
- Whether outbound owner contact is in scope for the first release (it changes
  the compliance surface substantially).
- Document formats and correspondence channels actually in use.
- Brand and legal sign-off path for anything owner-facing.
- Accessibility and language requirements.
- **Work discovery (§12)**: whether employee observation is in scope at all,
  and if so the notice/consent posture, the states and countries whose staff
  would be observed, and who owns employment-law sign-off. Default to leaving
  it off until this is answered in writing.

Start with the priorities document and ranked workflow list from §2, and bring
those back before writing application code.
