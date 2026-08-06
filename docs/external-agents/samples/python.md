# Sample: a Python runtime

> **Adapt, do not copy.** Which agent platforms MVW uses has not been confirmed;
> see [`README.md`](./README.md). This sample assumes only Python 3.11+, the
> standard library, and one HTTP client. Nothing here is specific to an
> orchestration framework or an agent product; the client below is meant to sit
> underneath whichever one you use.

Work through [`rest-curl.md`](./rest-curl.md) first if you have not — it proves
the enrolment and the network path before any of this matters.

---

## 1. Enrolment — what the operator runs

Not you. See §1 of [`rest-curl.md`](./rest-curl.md). You need three things from
them:

| | |
| --- | --- |
| `PV_BASE_URL` | The deployment's base URL. |
| `PV_AGENT_ID` | Your `eag_...` id. |
| `PV_TOKEN` or `PV_HMAC_SECRET` | The credential, handed over once. |

Load the credential from a secret store. Not from a notebook cell, not from a
committed `.env`, and not from anywhere that ends up in a traceback.

---

## 2. A client

```python
import base64, hashlib, hmac as hmac_lib, json, os, secrets, time
from dataclasses import dataclass
from datetime import datetime, timezone

import httpx

BASE = os.environ["PV_BASE_URL"]
AGENT_ID = os.environ["PV_AGENT_ID"]


class GovernanceDenied(Exception):
    """The platform refused. Distinct from a transport failure, and treated so."""

    def __init__(self, body: dict):
        super().__init__(body.get("message", "refused"))
        self.reason = body.get("reason")      # stable; branch on this
        self.detail = body.get("detail", {})


class ApprovalPending(Exception):
    """A human must decide before this may proceed. Not an error, and not a yes."""

    def __init__(self, body: dict):
        super().__init__(body.get("message", "a human must decide this first"))
        self.approval_id = body.get("approvalId")
        self.body = body


class BearerCredential:
    """Simplest. A string, so rotate it and keep it out of tracebacks."""

    def __init__(self, token: str):
        self._token = token

    def headers(self, payload: bytes) -> dict:
        return {"authorization": f"Bearer {self._token}"}


class HmacCredential:
    """Preferred wherever the runtime can hold a secret."""

    def __init__(self, secret: str):
        self._secret = secret.encode("utf-8")

    def headers(self, payload: bytes) -> dict:
        timestamp = datetime.now(timezone.utc).isoformat(timespec="milliseconds").replace(
            "+00:00", "Z"
        )
        # Single use. A fresh one per request, including per retry: a correctly
        # signed request presented twice is a replay whatever its timestamp says.
        nonce = secrets.token_hex(16)
        body_digest = "sha256:" + hashlib.sha256(payload).hexdigest()

        # Domain-separated and newline-delimited. The prefix binds the signature
        # to this platform and this purpose; the newlines mean no field can be
        # shifted into its neighbour.
        message = "\n".join(
            [
                "project-vacation/external-agent/v1",
                AGENT_ID,
                timestamp,
                nonce,
                body_digest,
            ]
        ).encode("utf-8")

        signature = base64.b64encode(
            hmac_lib.new(self._secret, message, hashlib.sha256).digest()
        ).decode("ascii")

        return {
            "x-pv-agent": AGENT_ID,
            "x-pv-timestamp": timestamp,
            "x-pv-nonce": nonce,
            "x-pv-signature-kind": "hmac",
            "x-pv-signature": signature,
        }


@dataclass
class Governance:
    credential: object
    client: httpx.Client

    def call(self, path: str, body: dict | None = None, method: str = "POST") -> dict:
        # Serialise once. The signature covers a digest of exactly these bytes,
        # so signing one string and sending another is the classic way to spend
        # an afternoon on "the signature does not verify".
        payload = b"" if body is None else json.dumps(body).encode("utf-8")

        response = self.client.request(
            method,
            f"{BASE}{path}",
            content=payload or None,
            headers={
                "content-type": "application/json",
                **self.credential.headers(payload),
            },
        )

        parsed = response.json() if response.content else {}

        if response.status_code == 409:
            raise GovernanceDenied(parsed)
        if response.status_code == 202:
            raise ApprovalPending(parsed)
        response.raise_for_status()
        return parsed
```

---

## 3. Ask before acting

```python
pv = Governance(HmacCredential(load_secret("pv-hmac")), httpx.Client(timeout=20))

try:
    decision = pv.call(
        "/api/external/screen",
        {
            "tool": "crm.read_contact",
            "declaredRisk": "routine",
            "estimatedCostUsd": 0.4,
            "requiredScopes": ["owner_services"],
            "subject": {"contractId": "ctr_fl_0001"},
        },
    )
    # decision["outcome"] == "allowed". decision["effectiveRisk"] may be HIGHER
    # than what was declared: the operator's rating for the tool floors it.
    do_the_work()

except ApprovalPending as pending:
    wait_for_approval(pv, pending.approval_id)          # §4

except GovernanceDenied as denied:
    # Stop. Do NOT retry: repeated refusals inside the window contain the agent,
    # and a human has to release it.
    tell_somebody(f"the platform refused: {denied.reason} — {denied}")
```

---

## 4. Waiting on a human

```python
def wait_for_approval(pv: Governance, approval_id: str, timeout_s: float = 3600) -> dict:
    deadline = time.monotonic() + timeout_s
    wait = 5.0

    while time.monotonic() < deadline:
        state = pv.call(f"/api/external/approvals/{approval_id}", method="GET")
        if state["status"] == "granted":
            return state
        if state["status"] != "pending":
            # rejected, expired, or already consumed. All of them mean no.
            raise RuntimeError(f"approval {approval_id} is {state['status']}")
        time.sleep(wait)
        # Back off. Polling every second for an hour is a denial-of-service
        # attempt against a queue a human reads at human speed, and it counts
        # against the agent's request ceiling.
        wait = min(wait * 2, 60.0)

    raise TimeoutError(f"approval {approval_id} was not decided in time")
```

---

## 5. Report what you did

```python
# Derived from the episode, NOT from the attempt. Every retry of this episode
# must present the same key, or the retry charges the owner twice.
idempotency_key = f"episode:{conversation_id}:{episode_started_at}"

ingested = pv.call(
    "/api/external/report",
    {
        "tool": "owner.summarise",
        "idempotencyKey": idempotency_key,
        "goal": "summarise the owner's outstanding questions",
        "startedAt": episode_started_at,
        "endedAt": datetime.now(timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z"),
        "outcome": "succeeded",
        "summary": "three questions answered from the contract",
        "costUsd": 3.25,
        "subject": {"contractId": "ctr_fl_0001"},
        "steps": [
            {
                "name": step.name,
                "tool": step.tool,
                "startedAt": step.started_at,
                "endedAt": step.ended_at,
                "outcome": "succeeded" if step.ok else "failed",
                "costUsd": step.cost_usd,
            }
            for step in steps
        ],
    },
)

if ingested["duplicate"]:
    # Already recorded under this key. The ORIGINAL record came back and nothing
    # was counted twice. This is the expected outcome of a retry, not a problem.
    pass
```

Note the timestamps carry a timezone designator. One without is read in
whichever zone the reading machine sits in — a different instant on every host —
and is refused rather than guessed at. `datetime.now()` without `timezone.utc`
is the mistake this refuses.

Retrying this call is safe *because* of the key. Retrying without one is how a
network blip becomes a doubled spend figure in a report somebody presents to
finance.

---

## 6. A live run, and honouring the kill switch

```python
import threading

run = pv.call(
    "/api/external/runs",
    {"tool": "owner.summarise", "goal": "work through the open questions"},
)

stop = threading.Event()
stop_reason: str | None = None


def heartbeat_loop(external_run_id: str, interval_s: float) -> None:
    """Beat, and obey the reply.

    The reply is a directive, not an acknowledgement. This platform cannot reach
    into the runtime to stop anything — the one moment it can stop us is the
    moment we next ask, which is here.
    """
    global stop_reason
    while not stop.wait(interval_s):
        try:
            reply = pv.call(f"/api/external/runs/{external_run_id}/heartbeat", {})
        except GovernanceDenied as denied:
            # Being refused a heartbeat is not a reason to keep working.
            stop_reason = f"heartbeat refused: {denied.reason}"
            stop.set()
            return
        except httpx.HTTPError:
            # A transport failure is not permission either. Keep beating; if the
            # run goes quiet for reclaimAfterSeconds it is closed on the record
            # with the honest outcome that nobody heard from us.
            continue

        if reply["directive"] == "stop":
            # Stop NOW. Not after this step, not after a retry.
            stop_reason = reply.get("reason", "stopped by the platform")
            stop.set()
            return


beater = threading.Thread(
    target=heartbeat_loop, args=(run["externalRunId"], 30.0), daemon=True
)
beater.start()

try:
    do_the_work(stop)      # must check stop.is_set() between units of work
    if stop.is_set():
        # The platform stopped us. The run is already closed on its side; do not
        # finish it, and do not report it as an episode that completed.
        raise SystemExit(0)
    pv.call(
        f"/api/external/runs/{run['externalRunId']}/finish",
        {"outcome": "succeeded", "summary": "three questions answered", "costUsd": 2.5},
    )
except Exception as error:      # noqa: BLE001 — the outcome must be recorded
    if not stop.is_set():
        pv.call(
            f"/api/external/runs/{run['externalRunId']}/finish",
            {"outcome": "failed", "summary": str(error)[:4000], "costUsd": spent_so_far},
        )
    raise
finally:
    stop.set()
    beater.join(timeout=5)
```

`do_the_work` must actually look at `stop` between units of work. A heartbeat
loop that sets a flag nobody reads is a kill switch that is wired to nothing.

---

## 7. Have the platform act for you

```python
# A read runs immediately.
contact = pv.call(
    "/api/external/execute",
    {
        "integration": "crm",
        "operation": "read_contact",
        "mode": "read",
        "request": {"contactId": "ctr_fl_0001"},
    },
)

# A write is two-phase and digest-bound. Build the request ONCE and keep it: the
# commit must be identical in content to what a human approved.
write = {
    "integration": "crm",
    "operation": "update_contact",
    "mode": "write",
    "request": {
        "contactId": "ctr_fl_0001",
        "field": "mailing_preference",
        "value": "post",
    },
}

try:
    pv.call("/api/external/execute", write)
    raise RuntimeError("a write should have been parked for a human")
except ApprovalPending as pending:
    parked = pending.body      # parkedActionId, approvalId, preview

wait_for_approval(pv, parked["approvalId"])

result = pv.call(
    "/api/external/execute",
    # Same dict. Key order does not matter — the binding is to canonical content
    # — but any changed VALUE voids the action.
    {**write, "parkedActionId": parked["parkedActionId"]},
)

if result["outcome"] == "completed":
    pass
elif result["outcome"] == "already_done":
    # A replayed commit. It was not performed twice.
    pass
elif result["outcome"] == "indeterminate":
    # Started, outcome never recorded. It may or may not have landed. DO NOT
    # RETRY: a retry of an action that succeeded is a duplicate effect on a real
    # owner's record. Escalate; an operator has been told to look.
    escalate(result["message"], result["parkedActionId"])
```

---

## 8. Before you call it done

- [ ] `GovernanceDenied` stops the agent; it never becomes a retry loop.
- [ ] `ApprovalPending` is treated as "wait", never as "proceed".
- [ ] `idempotency_key` is derived from the episode, not from the attempt.
- [ ] Every timestamp carries a timezone designator.
- [ ] The work loop actually reads the stop flag the heartbeat sets.
- [ ] `indeterminate` escalates to a person and is never retried.
- [ ] The credential comes from a secret store and never reaches a log,
      a traceback, or a notebook output cell.
