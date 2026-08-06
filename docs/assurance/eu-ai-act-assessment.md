# EU AI Act — applicability assessment

**Last reviewed:** 2026-08-06.
**Status:** engineering assessment for legal review. **Not legal advice.**

> **Two caveats before anything else.**
>
> 1. This assessment is written from the Regulation as understood at the time of
>    writing. The Act's implementation has been subject to ongoing amendment and
>    guidance, and at least one legislative package affecting timing was under
>    discussion during 2025–2026. **MVW counsel must confirm the current text,
>    the current timetable, and any applicable guidance before this assessment
>    is relied on.** Where this document states a date, treat it as a prompt to
>    verify, not as a finding.
> 2. Whether the Act applies at all turns on a fact this engineering team does
>    not have: whether MVW's European owners and members are in scope for this
>    platform. That is question 1 below and it gates everything else.

---

## 1. Does the Act apply to this platform?

The Act reaches AI systems placed on the EU market, put into service in the EU,
or whose **output is used in the EU** — the last limb being the one that catches
systems hosted elsewhere.

MVW operates Interval International, an exchange network with European members,
and sells vacation ownership to European consumers. If this platform processes
data about, or produces output affecting, those owners or members, the Act is in
scope regardless of where the platform is deployed.

**MVW would be a *deployer*** (the Act's term for an entity using an AI system
under its own authority). Where MVW's engineers extend the platform after
handover, MVW may additionally take on **provider** obligations for what they
build.

**Question 1 for MVW: are European owners or members in scope for this platform,
in the first release or in the roadmap?** If the answer is no and it is enforced
technically — by data scoping — the analysis below is contingent rather than
immediate. If the answer is yes, or is "not yet but probably", the high-risk
analysis in §3 is live and should be resolved before the relevant workflows go
anywhere near production.

---

## 2. Timing

The Act's obligations phase in over several years. The phase covering **Annex
III high-risk systems** was scheduled to apply from **2 August 2026** — four
days before this assessment was written.

If any workflow in §3 is classified high-risk and European owners are in scope,
the obligations are **current, not future**. That timing is the single most
important line in this document, and it is also the line most in need of
verification against the current text and any transitional provisions.

---

## 3. Risk classification by capability

The Act classifies by use, not by technology. Each capability is assessed on its
own.

### 3.1 Prohibited practices — none

Nothing in the platform performs social scoring, emotion inference in the
workplace or education, untargeted facial-image scraping, biometric
categorisation, or exploitation of vulnerability. **The platform must not be
extended into any of these**, and the action registry's `prohibited` risk tier
exists partly so that such an action is refused unconditionally rather than
being a configuration question.

### 3.2 Likely high-risk — the two that matter

**(a) Anything credit-adjacent.** Annex III includes AI systems intended to
evaluate the creditworthiness of natural persons or establish their credit
score. Candidate workflow #4 in the priorities document — delinquency
early-warning and treatment preparation — sits directly next to this line.

*How the platform is designed relative to that line:* the buildable version was
deliberately scoped as **evidence assembly with a human decision-maker**. The
platform gathers the loan file, extracts and cites relevant policy and contract
terms, checks contact-compliance history, and presents an evidence pack. It does
not rank, score, or sequence borrowers.

Whether that scoping keeps the system outside Annex III, or merely makes a
high-risk system easier to comply with, **is a legal determination, not an
engineering one.** The honest engineering position is: we built it to be
defensible either way, and the controls the Act would require for a high-risk
system — risk management, data governance, logging, transparency, human
oversight, accuracy and robustness — are substantially present already (§4).

**(b) Employee work discovery.** Annex III includes AI systems used for
monitoring and evaluating the performance and behaviour of persons in work
contexts. **Work discovery is squarely within that description.**

This is one of several independent reasons the feature ships disabled (ADR 0012)
and must stay disabled until the employment-law questions are answered in
writing. For any European or non-US staff, the Act's obligations attach *in
addition to* works-council consultation and GDPR — and in several jurisdictions
monitoring without consultation is unlawful regardless of individual consent.

### 3.3 Limited risk — transparency obligations

Systems interacting with natural persons, or generating content delivered to
them, carry transparency obligations. Owner-facing correspondence generated by
the platform falls here.

*Currently satisfied by:* every generated document recording its template
version, data digest, model, and approver; the contact gate recording evidence
for every outbound message; and human approval above the risk threshold.

*Question 2 for MVW: what disclosure language should appear on AI-assisted
owner-facing correspondence, and who signs it off?* This is a brand and legal
decision, not an engineering one, and it is cheap to build once decided.

### 3.4 Minimal risk

Internal document assembly, HOA board packs, and the compliance-checking
workflows against internal documents carry no specific obligations beyond
general ones.

---

## 4. Where the platform already stands against high-risk requirements

If a capability is classified high-risk, these are the Article-level
requirements and what exists today. This table is the useful part of this
document: it shows the gap is narrower than it might appear, and exactly where
it is not.

| Requirement | Present | Where |
| --- | --- | --- |
| Risk management system | Yes | `threat-model.md`, ADRs, risk tier per action, review cadence |
| Data governance | Partial | Corpus provenance, effective-dating, governed ingestion. **Training-data governance does not arise: the platform does not train models** |
| Technical documentation | Yes | ADRs, threat model, this assurance set, README |
| **Record-keeping / automatic logging** | **Yes, strongly** | Hash-chained audit log with independent verification — this is the requirement the platform is best positioned on |
| Transparency to deployers | Yes | Model inventory, role registry with versions and evaluation results, plain-language instance descriptions |
| **Human oversight** | **Yes, strongly** | Human-in-the-loop policy by risk tier; approvals with dual control; the rollout ladder; consumer-adverse outcomes are human-decided by design |
| Accuracy | Partial | Golden-set evaluation with a CI gate. **Accuracy against real MVW data is unmeasured** |
| Robustness | Partial | Fail-closed throughout; graceful degradation; contract tests. **No load testing at realistic volume** |
| Cybersecurity | Partial | Threat model, boundary screen, egress allowlist, sandbox default-disabled. **No penetration test performed** |
| Registration in the EU database | **Not done** | A deployer/provider obligation for high-risk systems. MVW action if applicable |
| Fundamental-rights impact assessment | **Not done** | Required of certain deployers. MVW action; the bias harness and data inventory are inputs to it |
| Post-market monitoring | Partial | Quality watched against baseline; incident process. No formal post-market monitoring plan |
| Serious-incident reporting | **Not done** | Requires a defined reporting path to the relevant authority. MVW action |

---

## 5. Recommended sequence

1. **Answer question 1** — are European owners and members in scope? Everything
   follows from it.
2. If yes, have counsel confirm the current text, timetable, and guidance, and
   classify the delinquency workflow specifically.
3. **Keep work discovery disabled.** It is the clearest high-risk candidate and
   has the least offsetting benefit.
4. Sequence the first release around workflow #1 (rescission compliance) and #2
   (HOA board packs), neither of which is a strong Annex III candidate — which
   is a further argument for that ordering beyond the ones in the priorities
   document.
5. Close the three measurable gaps that apply regardless of classification:
   accuracy against real data, load testing, and a penetration test.

---

## 6. Questions for MVW

1. Are European owners or members in scope for this platform, now or in the
   roadmap?
2. Who at MVW owns EU AI Act assessment, and are they engaged?
3. What disclosure appears on AI-assisted owner-facing correspondence?
4. Does MVW have European or other non-US **staff** who would ever be in scope
   for work discovery? If yes, that feature needs works-council consultation
   before it is even prototyped against real people.
