# NIST AI Risk Management Framework — control mapping

**Framework:** NIST AI RMF 1.0 (AI 100-1), four functions: GOVERN, MAP,
MEASURE, MANAGE.
**Last reviewed:** 2026-08-06.

This maps the platform's implemented controls to the framework's subcategories.
Where a subcategory is not satisfied, it says so. A mapping that claims full
coverage of a framework this broad would not be credible.

**Legend:** `Platform` — implemented here. `Shared` — mechanism here, operated
by MVW. `MVW` — organisational, outside this codebase. `Gap` — not satisfied.

---

## GOVERN — a culture of risk management

| Subcategory | Status | Implementation |
| --- | --- | --- |
| GOVERN 1.1 Legal and regulatory requirements understood | Platform | Regulatory surface documented per capability: statutory rescission (`timeline/`), TILA/Reg Z framing, ECOA/UDAAP in `roles/bias.ts`, TCPA and state do-not-call in `contact/gate.ts`, CCPA/CPRA and GDPR in `data-inventory.md` |
| GOVERN 1.2 Trustworthy AI characteristics integrated | Platform | Fail-closed default (ADR 0003); no-grounding-no-answer; human decision required for consumer-adverse outcomes |
| GOVERN 1.3 Risk management prioritised by impact | Platform | Explicit risk tiers per action with a human-involvement policy per tier (`guard/registry.ts`) |
| GOVERN 1.4 Risk management process documented | Platform | ADRs, threat model, this mapping |
| GOVERN 1.5 Ongoing monitoring and review | Platform | Golden-set evaluation gate in CI; post-change quality watched against baseline; corpus freshness review cadence |
| GOVERN 1.6 Inventory of AI systems | Platform | Model inventory (`models/inventory.ts`) and role registry, both queryable |
| GOVERN 1.7 Decommissioning | Shared | Roles disabled instantly through containment without a deploy; retention job handles data |
| GOVERN 2.1 Roles and responsibilities | Shared | Platform roles map to MVW functions; the auditor role sees everything and changes nothing |
| GOVERN 2.2 Training | MVW | Handover training material provided; delivery is MVW's |
| GOVERN 2.3 Executive accountability | MVW | — |
| GOVERN 3.1 Diverse perspectives in the AI lifecycle | MVW | Recommended: compliance and employment counsel engaged early, which the brief already requires |
| GOVERN 4.1 Risk culture, critical thinking | Platform | The improvement loop surfaces failure patterns with evidence rather than hiding them |
| GOVERN 4.2 Documented AI risks and impacts | Platform | Threat model §5 states accepted and partial mitigations plainly |
| GOVERN 4.3 Testing, incident identification, information sharing | Platform | Incident process includes a specific procedure for when the AI is wrong, including finding every action a bad model or prompt version touched |
| GOVERN 5.1 Feedback from external stakeholders | MVW | — |
| GOVERN 6.1 Third-party risk policies | Shared | Subprocessor list; **model provider terms not yet confirmed** |
| GOVERN 6.2 Contingency for third-party failure | Platform | Fallback chains; explicit integration degradation policy; total failure denies rather than degrading |

---

## MAP — context and risks identified

| Subcategory | Status | Implementation |
| --- | --- | --- |
| MAP 1.1 Intended purpose and context | Platform | `docs/context/mvw-priorities.md` derives candidate workflows from management's own stated metrics |
| MAP 1.2 Interdisciplinary perspectives | MVW | — |
| MAP 1.5 Organisational risk tolerance | Shared | Ceilings, risk tiers, and the rollout ladder are configurable expressions of tolerance |
| MAP 2.1 System task and method defined | Platform | Each role declares purpose, permitted actions, risk ceiling, data scope, model assignment, and human-in-the-loop tier |
| MAP 2.2 Knowledge limits documented | Platform | Regulated questions refuse without grounding; statutory rules ship unverified and say so |
| MAP 2.3 Scientific integrity of the method | Platform | Quality measured against human-curated golden sets, not asserted |
| MAP 3.1 Benefits examined | Platform | Ranked workflow list with impact and feasibility reasoning, written to be argued with |
| MAP 3.4 Operator proficiency | Shared | Console designed for non-engineers; operator guide provided |
| MAP 4.1 Third-party risks mapped | Platform | Threat model boundaries 5 and 6 |
| MAP 5.1 Impacts to individuals and groups | Platform | Bias harness for consumer-affecting outcomes; discovery's employee-privacy constraints |
| MAP 5.2 Feedback on impacts | Platform | Harvest stage captures human corrections and overrides as structured observations |

---

## MEASURE — risks assessed and tracked

| Subcategory | Status | Implementation |
| --- | --- | --- |
| MEASURE 1.1 Approaches selected | Platform | Golden-set evaluation with per-case results and aggregate accuracy |
| MEASURE 1.2 Appropriateness of metrics | Platform | Golden sets are human-curated and protected against weakening (ADR 0011) |
| MEASURE 1.3 Independent assessment | **Gap** | No independent third-party assessment performed |
| MEASURE 2.1 Test sets and metrics documented | Platform | Evaluation runs record model version, prompt version, and per-case outcome |
| MEASURE 2.2 Human subject evaluation | **Gap** | Shadow-mode agreement measurement is implemented; no formal human-subject study |
| MEASURE 2.3 System performance | Platform | Evaluation harness plus shadow-mode disagreement rate |
| MEASURE 2.4 Deployed system monitored | Platform | Post-change quality tracked against pre-change baseline; regression alerts and offers revert |
| MEASURE 2.5 Validity and reliability | Platform | Determinism gate in CI; contract tests against both persistence adapters |
| MEASURE 2.6 Safety risks | Platform | Sandbox disabled by default; irreversible actions require approval gates and declared compensation |
| MEASURE 2.7 Security and resilience | Platform | Threat model; boundary screen; containment tested against in-flight work |
| MEASURE 2.8 Transparency and accountability | Platform | Hash-chained audit log, independently verifiable; citations with version and effective date |
| MEASURE 2.9 Explainability | Platform | Deadline computations carry their full derivation; answers carry click-through citations; `describeInstance()` explains an instance in plain language |
| MEASURE 2.10 Privacy risk | Platform | Digests not payloads; redaction before egress; data inventory |
| MEASURE 2.11 Fairness and bias | **Partial** | Harness implemented on synthetic fixtures only. Real testing requires MVW compliance engagement before any consumer-affecting workflow goes live |
| MEASURE 3.1 Tracking over time | Platform | Evaluation history retained; quality trends queryable |
| MEASURE 4.1 Field measurement | Platform | Shadow mode measures agreement against human work at zero risk |

---

## MANAGE — risks prioritised and acted on

| Subcategory | Status | Implementation |
| --- | --- | --- |
| MANAGE 1.1 Determination to deploy | Platform | The rollout ladder: shadow, assisted, supervised, bounded autonomy. Promotion is a decision with evidence attached, not a date |
| MANAGE 1.2 Treatment prioritised | Platform | Improvement clusters ranked by frequency and cost |
| MANAGE 1.3 Responses to high-priority risks | Platform | Containment controls; role disable; integration revocation |
| MANAGE 1.4 Residual risk documented | Platform | Threat model §5 |
| MANAGE 2.1 Resources allocated | MVW | — |
| MANAGE 2.2 Mechanisms to sustain value | Platform | The improvement loop, human-gated end to end |
| MANAGE 2.3 Superseded systems | Shared | Role versions revertible in one action |
| MANAGE 2.4 Deactivation mechanisms | Platform | Global pause, per-workflow, per-role, per-integration — seconds, no deploy, stops in-flight work |
| MANAGE 3.1 Third-party risks managed | Shared | Egress allowlist; scoped revocable credentials; fallback chains |
| MANAGE 3.2 Pre-trained model risks | Platform | Model inventory with versions and fallbacks; changes re-run evaluation |
| MANAGE 4.1 Post-deployment monitoring | Platform | Watch stage against baseline |
| MANAGE 4.2 Continual improvement | Platform | The improvement loop — and its gate is not configurable |
| MANAGE 4.3 Incident communication | Platform | Incident process with a specific AI-is-wrong procedure |

---

## Gaps, consolidated

1. **MEASURE 1.3** — no independent third-party assessment.
2. **MEASURE 2.2** — no formal human-subject evaluation.
3. **MEASURE 2.11** — bias testing runs on synthetic fixtures only; real testing
   requires MVW compliance engagement and real (or realistically distributed)
   data before any consumer-affecting workflow goes live.
4. **GOVERN 6.1** — model provider data-handling terms not contractually
   confirmed.
5. Several GOVERN and MAP subcategories are organisational and depend on MVW
   rather than on this codebase. They are marked `MVW` and are not claimed.
