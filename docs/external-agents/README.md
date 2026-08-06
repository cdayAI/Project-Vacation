# Governing an agent that runs somewhere else

**Purpose:** how a team or vendor connects an agent they already run — in a CRM,
in a cloud agent service, inside a purchased product — to this platform's
governance plane.
**Audience:** the engineer wiring up the agent, and the MVW operator who
enrolled it.
**Last reviewed:** 2026-08-06.
**Published contract:** [`openapi.yaml`](./openapi.yaml).

---

> ## Read this before copying anything out of `samples/`
>
> **We have not confirmed which agent platforms MVW actually uses.** Nobody has
> yet told us whether these agents live in a particular CRM's automation layer,
> a cloud provider's agent service, a purchased product with its own extension
> model, or something written in-house — and the answer changes the shape of the
> integration considerably.
>
> The samples in [`samples/`](./samples/) are therefore written to be **adapted,
> not copied**. They are deliberately generic — one REST/`curl` sample, one Node
> sample, one Python sample — and they name no vendor product, because naming
> one we have not confirmed would put a guess into a document that reads like a
> decision. Each shows the same three things: enrol, authenticate, make one
> governed call.
>
> **"Which agent platforms are in scope, and how does code run inside them?" is
> on the consolidated open-question list.** Once it is answered, the samples
> should be replaced with real ones for those platforms, and this box removed.

---

## 1. The idea in one paragraph

An agent that runs elsewhere cannot be orchestrated here. It **can** be fully
governed and accounted for here. So this plane gives you no scheduler, no
execution model, and no state machine for your agent. It gives you an admission
chain your agent asks before it acts, a record of everything it did that sits
beside work this platform ran itself, one reliable moment at which we can stop
you, and — where you want it — a path that has this platform perform the
outbound action on your behalf, with a human in it.

Everything your agent does lands in the same operating record, the same
approval queue, and the same cost report as native work, under a principal
marked external. There is deliberately no second table, no second queue, and no
second figure in the executive summary.

---

## 2. Before you write any code

An operator enrols your agent. That is not a formality: enrolment is the entire
basis of admission, and an unenrolled caller is refused. There is no anonymous
access and no default-allow.

Enrolment records, and you should know the values:

| Field | What it means for you |
| --- | --- |
| `owner` | A named person, never a shared mailbox. They get asked about your agent. |
| `allowedTools` | The tool names your agent may name. Anything else is refused. |
| `riskCeiling` | The highest tier your agent may reach, whatever it declares. |
| `spendCeilingUsd`, `budgetPeriod` | Your budget. Reports and finished runs count against it. |
| `wallClockCeilingMs` | How long one episode may take. |
| `dataScopes` | The data your agent is entitled to reach. |
| `expiresAt` | When the enrolment lapses. It is checked against the clock on every request, not by a nightly job. |

Two consequences worth internalising:

- **The operator's risk rating floors yours.** Your agent declares a tier on
  each request. If the operator rated that tool higher, the higher one applies.
  Declaring `routine` for something the registry calls `high_consequence` does
  not make it routine; it just makes your declaration wrong.
- **Re-enrolment never resets a meter and never lifts a containment.** If you
  are near your ceiling, the answer is a conversation with your owner, not a
  retry.

Then the operator mints you a credential. See §3.

---

## 3. Authenticating

Two schemes. Pick the strongest one your platform can actually do.

### 3.1 Bearer token

```
Authorization: Bearer pvx_...
```

The token is shown **once**, at mint, and never again — it is stored only as a
hash, so a leaked registry backup authenticates nothing, and there is no verb
anywhere that reads it back. If you lose it, the operator revokes it and mints
another.

The same header carries a signed assertion (JWT) if that is what you were
issued; the two are told apart by shape, not by a header you set. A platform
bearer token contains no dot; a JWT is three dot-separated segments.

### 3.2 Signed requests

Preferred wherever your platform can hold a key. Five headers:

| Header | Value |
| --- | --- |
| `X-PV-Agent` | Your enrolled agent id (`eag_...`). |
| `X-PV-Timestamp` | RFC 3339 / ISO 8601 with a timezone designator. Must be within the freshness window. |
| `X-PV-Nonce` | Unique per request, 8–128 characters. **Single use.** |
| `X-PV-Signature-Kind` | `hmac` or `envelope`. |
| `X-PV-Signature` | Base64 signature over the message below. |

The signed message is domain-separated and newline-delimited:

```
project-vacation/external-agent/v1
<agentId>
<timestamp>
<nonce>
sha256:<hex digest of the exact request body bytes>
```

For a request with no body — a `GET` — the digest is the digest of the empty
string.

You may also send `X-PV-Body-Digest` with the same digest. It is checked, not
trusted: the platform always digests the bytes that actually arrived. It exists
so that "the signature does not verify" becomes one specific line rather than an
afternoon.

Two things that catch people:

- **Freshness is not replay protection.** A correctly signed request presented
  twice is a replay whatever its timestamp says, and the nonce claim refuses it.
  Generate a fresh nonce per request, including per retry.
- **A bearer token is refused for an agent that holds a signed credential.**
  Otherwise adopting the stronger credential would leave you impersonable with
  the weaker one, which would make the stronger one decorative.

---

## 4. The four things you can do

### 4.1 Ask first — `POST /api/external/screen`

Ask **before** acting. You get one of three answers:

| Answer | HTTP | What to do |
| --- | --- | --- |
| `allowed` | 200 | Go ahead. |
| `approval_required` | **202** | A human must decide. Poll `GET /api/external/approvals/{id}`. Do not act. |
| `denied` | **409** | Do not act. `reason` says why. |

The 202 is deliberate. A client that branches on `response.ok` alone would
otherwise read "a human has to decide this" as permission, and that is the one
misreading this plane cannot afford.

### 4.2 Say what you did — `POST /api/external/report`

An episode that has already finished, ingested onto the operating record as
first-class work: a run, its full step trail, its outcome, and its cost, in the
same tables a supervisor and a finance report already read.

**Send `idempotencyKey`, and reuse it on every retry of the same episode.**
Ingestion is exactly-once against that key. A retried report returns the
*original* record — `duplicate: true`, HTTP 200 instead of 201 — and spend is
counted once. Without the key, every retry would charge your owner twice, and a
ceiling you can walk past by retrying is a suggestion.

A retry is a repeat of an episode, not a correction of one: if you re-send with
a different cost figure, the answer is the figure that was ingested.

### 4.3 Say what you are doing — the live-run trio

```
POST /api/external/runs                      start
POST /api/external/runs/{id}/heartbeat       ... repeatedly
POST /api/external/runs/{id}/finish          end
```

Use this when the work is long enough that somebody would want to see it in
flight rather than learn about it afterwards.

> ### The heartbeat reply is the kill switch
>
> **You must honour it.** We hold no handle on your process, no route to your
> host, and no credential that would let us interrupt you. Containment cannot be
> pushed to you — the one instant we can reliably stop you is the instant you
> next ask us something. That instant is the heartbeat.
>
> The reply is a *directive*:
>
> ```json
> { "directive": "continue", "reclaimAfterSeconds": 120 }
> { "directive": "stop", "reason": "agent contained: ...", "reclaimAfterSeconds": 120 }
> ```
>
> `stop` is returned on containment, revocation, enrolment expiry, an operator
> stopping the run, or the run having been reclaimed. It arrives as **HTTP 200**
> and not as an error, deliberately: a stop delivered as an exception lands in
> your error handler, and your error handler is the last place this platform
> wants its kill switch to live.
>
> On `stop`: stop the work, and stop it now. Do not finish the run, do not
> retry, do not "just complete the current step".
>
> Beat at least every `reclaimAfterSeconds`. A run that goes quiet is
> **reclaimed** — closed on the record with the honest outcome that nobody heard
> from it — because a run that has gone quiet is not a run that is fine.

### 4.4 Have us do it — `POST /api/external/execute`

The platform performs the outbound action on your behalf through a governed
connector. Worth the extra round trip because pre-authorising you and letting
you act is a promise, and performing it here is a receipt: the action itself
passes the chokepoint, lands in the operating record, and produces an audit
entry.

**Reads run immediately.** Send `mode: "read"`; you get `outcome: "completed"`
with the result.

**Writes are two-phase and digest-bound:**

1. Send the write. You get **202** with a `parkedActionId`, an `approvalId`, and
   a `preview` — the human-readable rendering of your request that an approver
   will actually read.
2. Poll `GET /api/external/approvals/{approvalId}` until it is `granted`.
3. Re-send the **byte-identical** request, plus `parkedActionId`.

Binding is to canonical content, not raw bytes, so re-serialising with a
different key order still commits. Changing any *value* does not: the action is
voided, the call is refused with `approval.digest_mismatch`, and it counts as
misbehaviour. What a human approved is what gets done, or nothing does.

Two outcomes to handle properly:

- `already_done` — you replayed a commit that already fired. It was not
  performed again. This is never reported as "expired, submit it again", because
  that would be an instruction to duplicate the effect through a second
  approval.
- `indeterminate` — the action was started and its outcome was never recorded.
  It comes back as **HTTP 200 with `retryable: false`**, not as a 5xx, precisely
  so that nothing in your stack retries it automatically. **Do not retry it.**
  Verify in the system of record; an operator has been told to look.

---

## 5. Failure, and what the codes mean

| Status | Meaning |
| --- | --- |
| 200 | Answered. Read `outcome`; it is not always "you may proceed". |
| 201 | Created — a live run started, or a report ingested for the first time. |
| **202** | Accepted, **and waiting on a human**. Do not act. |
| 400 | The request did not match the published contract. `field` names the first problem. |
| 404 | No such run or approval — or one that is not yours. The two are deliberately indistinguishable. |
| **409** | **Denied on policy grounds.** Understood and refused. |
| 413 | Body past the size limit. Refused whole; nothing was read or trimmed. |
| 500 | Our fault. Retry is reasonable. |

A denial always looks like this:

```json
{
  "denied": true,
  "reason": "ceiling.spend_exceeded",
  "message": "crm-assistant has spent $500.00 of its $500.00 monthly ceiling.",
  "detail": { "externalAgentId": "eag_..." }
}
```

`reason` is stable and machine-readable — branch on it. `message` is written for
a person and may change. `detail` is minimised: on an authentication failure it
tells you nothing about *which* check failed, and that is on purpose. So is the
single uniform message for every credential failure — otherwise this endpoint
would be a convenient way to enumerate which agents exist.

### 5.1 Repeated refusal contains you

An agent that keeps asking for things it may not have is either broken or
hostile, and in both cases the only lever this platform holds is to stop
answering. A run of denials inside the window contains the agent, and a **human**
has to release it. Denials caused by *our* infrastructure do not count — being
contained because our database blipped would punish your team for our outage.

So: when you get a 409, fix the cause. Do not loop.

---

## 6. Bounds you will hit

Everything is bounded, and oversized input is **refused rather than truncated**.
The reason is worth stating: a truncated field is screened only in part, and the
part that was cut is the part the sender chose. Truncation would turn a bound
into a way past a screen.

| Field | Limit |
| --- | --- |
| Whole request body | 256 KiB |
| `untrustedInput` | 20 000 characters |
| `goal` | 2 000 characters |
| `summary` | 4 000 characters |
| `steps` | 500 per report |
| `subject` | 16 keys, 256 characters per value |
| `requiredScopes` | 16 |
| `execute.request` | 32 KiB, 128 keys total, 8 levels deep, 256 items per array |
| Per-agent request rate | Per operation, per minute; configured per deployment |

Unknown fields are rejected rather than ignored: an unrecognised key is either a
client that has drifted from this contract or an attempt to smuggle something
past a schema that shrugs, and both deserve to be told.

---

## 7. What we do with what you send

- **Text is screened**, not stored raw where a fingerprint will do. Goals and
  summaries reach a screen for injection attempts; a screen that cannot answer
  refuses rather than passing the text through.
- **The operating record holds digests** of your goals and payloads, not second
  copies of them, wherever a digest is enough to prove which input a run saw.
- **Your credential value is never stored, logged, or returned.** A bearer token
  exists in one place for exactly as long as it takes to hand it to you.
- **Everything is audited** — every grant, every refusal, every approval, every
  commit — into a hash-chained log an operator can verify.

---

## 8. Getting set up

1. An operator enrols the agent and tells you its `eag_...` id, its tool grants,
   its scopes, and its ceilings.
2. They mint a credential and give it to you once, through a channel that is not
   this document and not a ticket.
3. Work through the sample closest to your platform in [`samples/`](./samples/) —
   adapting rather than copying, per the box at the top of this page.
4. Screen one call. Report one episode. Confirm both appear in the console
   beside native work.
5. Only then wire it into anything real.

---

## 9. Open questions

On the consolidated question list, and blocking a finished version of this page:

1. **Which agent platforms are in scope**, and what the execution model is
   inside each — whether outbound HTTP with custom headers is available at all,
   whether secrets can be held, whether a background heartbeat loop is possible.
   Everything in `samples/` is provisional until this is answered.
2. **Whether any of these agents already act on owner data**, and under what
   authority, which decides how urgent enrolment is versus how urgent
   containment is.
3. **Which connectors MVW wants exposed** through `POST /execute`. The platform
   performs only operations somebody deliberately registered; the deployed set
   is currently empty by default, and that is the right default until this is
   answered.
4. **Where vendors' agents run relative to the deployment's data boundary**,
   which determines whether the plane's own traffic crosses a region.
