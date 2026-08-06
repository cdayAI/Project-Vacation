# Sample: any platform that can make an HTTP request

> **Adapt, do not copy.** Which agent platforms MVW uses has not been confirmed;
> see [`README.md`](./README.md). This sample assumes only that something in
> your environment can issue an HTTPS request with custom headers.

Work through this with `curl` before writing any code. It proves the enrolment,
the credential, and the network path in about five minutes, and every failure it
finds is one you would otherwise have found buried inside your agent.

```bash
PV=https://platform.example.invalid       # your operator supplies this
TOKEN=pvx_...                             # shown to you once, at mint
```

---

## 1. Enrolment — what the operator runs

Not you. Enrolment is a high-consequence action: it needs an approval a
different person granted, plus a fresh re-authentication.

```bash
# 1a. Raise the approval.
pv agents enroll \
  --name crm-assistant \
  --owner dana.owner@mvw.example \
  --department "owner services" \
  --host "customer relationship system" \
  --purpose "answer owner questions about their contract" \
  --risk-ceiling high_consequence \
  --spend-ceiling 500 --budget-period monthly \
  --wall-clock-ms 600000 \
  --expires 2027-01-01T00:00:00Z \
  --tool crm.read_contact:routine \
  --tool crm.update_contact:high_consequence \
  --tool owner.summarise:routine \
  --scope owner_services \
  --raise-approval

# 1b. Somebody else grants it in the console. Then, with the same arguments:
pv agents enroll ... --approval apr_... --reauthenticated

# 1c. Mint a credential. The token is printed once and never again.
pv agents credential mint crm-assistant \
  --kind bearer --label "crm production" --reauthenticated
```

`--tool name:tier` is the operator's own risk rating for that tool. It **floors**
whatever your agent later declares: rating `crm.update_contact` as
`high_consequence` means every use of it needs a human, regardless of what your
request says.

The operator gives you the `eag_...` id and the token — through a channel that
is not a ticket and not this document.

---

## 2. Ask before acting

```bash
curl -sS -X POST "$PV/api/external/screen" \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -H "X-Correlation-Id: my-trace-0001" \
  -d '{
        "tool": "crm.read_contact",
        "declaredRisk": "routine",
        "estimatedCostUsd": 0.4,
        "requiredScopes": ["owner_services"],
        "subject": { "contractId": "ctr_fl_0001" }
      }'
```

```json
{ "outcome": "allowed", "effectiveRisk": "routine", "remainingBudgetUsd": 500 }
```

Now try one the operator rated higher:

```bash
curl -sS -i -X POST "$PV/api/external/screen" \
  -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d '{ "tool": "crm.update_contact", "declaredRisk": "routine" }'
```

```
HTTP/1.1 202 Accepted
```
```json
{
  "outcome": "approval_required",
  "effectiveRisk": "high_consequence",
  "approvalId": "apr_01j8x...",
  "poll": "/api/external/approvals/apr_01j8x...",
  "message": "This action needs a human decision. Poll approval apr_01j8x..."
}
```

Two things to notice, because both will bite a client that ignores them:

- The status is **202, not 200**. If your code checks only "did it succeed", it
  will read this as permission. Branch on `outcome`.
- `effectiveRisk` came back higher than what was declared. The registry decides
  how risky a tool is, not the caller.

Poll until decided:

```bash
curl -sS "$PV/api/external/approvals/apr_01j8x..." \
  -H "Authorization: Bearer $TOKEN"
```

```json
{ "approvalId": "apr_01j8x...", "status": "granted", "decided": true,
  "approvalsRequired": 1, "approvalsGranted": 1 }
```

And a refusal, so you have seen one:

```bash
curl -sS -i -X POST "$PV/api/external/screen" \
  -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d '{ "tool": "crm.issue_refund" }'
```

```
HTTP/1.1 409 Conflict
```
```json
{
  "denied": true,
  "reason": "authorization.action_not_permitted",
  "message": "crm-assistant is not permitted to use \"crm.issue_refund\".",
  "detail": { "externalAgentId": "eag_01j8x..." }
}
```

**Do not loop on a 409.** Repeated refusals inside the window contain the agent,
and a human has to release it.

---

## 3. Report what you did

```bash
curl -sS -X POST "$PV/api/external/report" \
  -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d '{
        "tool": "owner.summarise",
        "idempotencyKey": "episode-2026-08-06-0001",
        "goal": "summarise the owner'\''s outstanding questions",
        "startedAt": "2026-08-06T11:00:00.000Z",
        "endedAt":   "2026-08-06T11:30:00.000Z",
        "outcome": "succeeded",
        "summary": "three questions answered from the contract",
        "costUsd": 3.25,
        "subject": { "contractId": "ctr_fl_0001" },
        "steps": [
          { "name": "retrieve contract terms", "tool": "crm.read_contact",
            "startedAt": "2026-08-06T11:01:00.000Z",
            "endedAt":   "2026-08-06T11:02:00.000Z",
            "outcome": "succeeded", "costUsd": 1.25 }
        ]
      }'
```

```
HTTP/1.1 201 Created
```
```json
{ "runId": "run_01j8x...", "duplicate": false, "costUsd": 3.25 }
```

**Send exactly the same command again.** This is the important one:

```json
{ "runId": "run_01j8x...", "duplicate": true, "costUsd": 3.25 }
```

Same run id, HTTP 200 instead of 201, and the spend meter did not move a second
time. That is what `idempotencyKey` buys, and it is why you must reuse the same
key on every retry of the same episode. Generate a fresh key per episode — a
timestamp is not a key, and a random one per attempt is worse than none.

---

## 4. A live run, and the kill switch

```bash
RUN=$(curl -sS -X POST "$PV/api/external/runs" \
  -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d '{ "tool": "owner.summarise", "goal": "work through the open questions" }' \
  | sed -n 's/.*"externalRunId":"\([^"]*\)".*/\1/p')

curl -sS -X POST "$PV/api/external/runs/$RUN/heartbeat" \
  -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" -d '{}'
```

```json
{ "directive": "continue", "reclaimAfterSeconds": 120 }
```

Now have the operator run `pv agents contain crm-assistant --reason planned_change`
and beat again:

```json
{ "directive": "stop",
  "reason": "agent contained: planned_change — a deliberate, planned stop while something is changed",
  "reclaimAfterSeconds": 120 }
```

**That is the kill switch, and it is the only one there is.** Your agent runs
where this platform cannot reach it, so containment cannot be pushed to you —
the one moment we can stop you is the moment you next ask. `stop` means stop
now: not "finish the current step", not "retry in a minute".

Note it arrived as HTTP 200. A stop delivered as an error would land in your
exception handler, which is the last place a kill switch should live.

Then close the run:

```bash
curl -sS -X POST "$PV/api/external/runs/$RUN/finish" \
  -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d '{ "outcome": "succeeded", "summary": "three questions answered", "costUsd": 2.5 }'
```

---

## 5. Have the platform act for you

Reads run immediately:

```bash
curl -sS -X POST "$PV/api/external/execute" \
  -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d '{ "integration": "crm", "operation": "read_contact",
        "mode": "read", "request": { "contactId": "ctr_fl_0001" } }'
```

Writes are two-phase. Phase one returns 202 with a preview:

```bash
BODY='{"integration":"crm","operation":"update_contact","mode":"write","request":{"contactId":"ctr_fl_0001","field":"mailing_preference","value":"post"}}'

curl -sS -X POST "$PV/api/external/execute" \
  -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" -d "$BODY"
```

```json
{
  "outcome": "approval_required",
  "parkedActionId": "pac_01j8x...",
  "approvalId": "apr_01j8y...",
  "preview": [
    { "label": "contactId", "value": "ctr_fl_0001" },
    { "label": "field", "value": "mailing_preference" },
    { "label": "value", "value": "post" }
  ]
}
```

That preview is what a human reads before saying yes. Once they have, phase two
re-sends the **same** request plus the parked action:

```bash
curl -sS -X POST "$PV/api/external/execute" \
  -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d '{"integration":"crm","operation":"update_contact","mode":"write","request":{"contactId":"ctr_fl_0001","field":"mailing_preference","value":"post"},"parkedActionId":"pac_01j8x..."}'
```

Change any value and the action is voided with `approval.digest_mismatch`.
Reordering keys is fine — the binding is to content, not to bytes, so your JSON
library's key order cannot stop you committing your own approved request.

**Handle `indeterminate`.** It arrives as HTTP 200 with `retryable: false`,
which is deliberate: as a 5xx, something in your stack would retry it, and a
retry of an action that may already have taken effect is a duplicate
consumer-facing effect. Stop, and tell somebody.

---

## 6. Signed requests without a scripting runtime

If your platform can shell out, the same five headers work here. `openssl` is
enough:

```bash
BODY='{"tool":"crm.read_contact","declaredRisk":"routine"}'
AGENT=eag_01j8x...
TS=$(date -u +%Y-%m-%dT%H:%M:%S.000Z)
NONCE=$(head -c 16 /dev/urandom | od -An -tx1 | tr -d ' \n')
DIGEST="sha256:$(printf '%s' "$BODY" | openssl dgst -sha256 -hex | awk '{print $2}')"

SIG=$(printf 'project-vacation/external-agent/v1\n%s\n%s\n%s\n%s' \
        "$AGENT" "$TS" "$NONCE" "$DIGEST" \
      | openssl dgst -sha256 -hmac "$HMAC_SECRET" -binary | base64)

curl -sS -X POST "$PV/api/external/screen" \
  -H "Content-Type: application/json" \
  -H "X-PV-Agent: $AGENT" \
  -H "X-PV-Timestamp: $TS" \
  -H "X-PV-Nonce: $NONCE" \
  -H "X-PV-Signature-Kind: hmac" \
  -H "X-PV-Signature: $SIG" \
  -d "$BODY"
```

Note `printf` rather than `echo`: the digest must cover exactly the bytes sent,
and a trailing newline is a different body. A fresh nonce every request,
including every retry — the nonce is single use, and a correctly signed request
presented twice is a replay whatever its timestamp says.

---

## 7. Before you call it done

- [ ] A 409 stops the agent, and does not become a retry loop.
- [ ] A 202 is treated as "wait", never as "proceed".
- [ ] Every retry of an episode reuses that episode's `idempotencyKey`.
- [ ] `directive: "stop"` stops the work immediately.
- [ ] `outcome: "indeterminate"` is escalated to a person and never retried.
- [ ] The credential is in a secret store, not in the agent's configuration
      export, and not in a log line.
- [ ] The operator can see your first screen, your first report, and your first
      run in the console, beside native work.
