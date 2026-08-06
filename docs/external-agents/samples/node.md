# Sample: a JavaScript or TypeScript runtime

> **Adapt, do not copy.** Which agent platforms MVW uses has not been confirmed;
> see [`README.md`](./README.md). This sample assumes only a modern JS runtime
> with `fetch` and, for signed requests, `node:crypto`. Nothing here is specific
> to a framework, a serverless provider, or an agent product.

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

Put the credential in whatever secret store your runtime has. Not in the agent's
configuration, which is usually exportable; not in an environment variable that
a crash dump prints.

---

## 2. A client

```js
import { createHash, createHmac, randomBytes } from "node:crypto";

const BASE = process.env.PV_BASE_URL;
const AGENT_ID = process.env.PV_AGENT_ID;

/** The platform refused. Distinct from a transport failure, and treated so. */
export class GovernanceDenied extends Error {
  constructor(body) {
    super(body.message);
    this.name = "GovernanceDenied";
    this.reason = body.reason;   // stable; branch on this
    this.detail = body.detail ?? {};
  }
}

/** A human has to decide before this may proceed. Not an error, and not a yes. */
export class ApprovalPending extends Error {
  constructor(body) {
    super(body.message ?? "A human must decide this first.");
    this.name = "ApprovalPending";
    this.approvalId = body.approvalId;
    this.body = body;
  }
}

async function call(path, { method = "POST", body, credential }) {
  // Serialise once. The signature covers a digest of exactly these bytes, so
  // signing one string and sending another is the classic way to spend an
  // afternoon on "the signature does not verify".
  const payload = body === undefined ? "" : JSON.stringify(body);

  const response = await fetch(`${BASE}${path}`, {
    method,
    headers: {
      "content-type": "application/json",
      ...credential.headers(payload),
    },
    ...(payload === "" ? {} : { body: payload }),
  });

  const text = await response.text();
  const parsed = text ? JSON.parse(text) : {};

  if (response.status === 409) throw new GovernanceDenied(parsed);
  if (response.status === 202) throw new ApprovalPending(parsed);
  if (!response.ok) {
    throw new Error(`${path} failed: ${response.status} ${text.slice(0, 500)}`);
  }
  return parsed;
}

/** Simplest credential. A string, so rotate it and keep it out of logs. */
export function bearer(token) {
  return { headers: () => ({ authorization: `Bearer ${token}` }) };
}

/** Preferred wherever the runtime can hold a secret. */
export function hmac(secret) {
  return {
    headers(payload) {
      const timestamp = new Date().toISOString();
      // Single use. A fresh one per request, including per retry: a correctly
      // signed request presented twice is a replay whatever its timestamp says.
      const nonce = randomBytes(16).toString("hex");
      const bodyDigest =
        "sha256:" + createHash("sha256").update(payload, "utf8").digest("hex");

      // Domain-separated and newline-delimited. The prefix binds the signature
      // to this platform and this purpose; the newlines mean no field can be
      // shifted into its neighbour.
      const message = [
        "project-vacation/external-agent/v1",
        AGENT_ID,
        timestamp,
        nonce,
        bodyDigest,
      ].join("\n");

      return {
        "x-pv-agent": AGENT_ID,
        "x-pv-timestamp": timestamp,
        "x-pv-nonce": nonce,
        "x-pv-signature-kind": "hmac",
        "x-pv-signature": createHmac("sha256", secret).update(message).digest("base64"),
      };
    },
  };
}
```

---

## 3. Ask before acting

```js
const credential = hmac(await secrets.get("pv-hmac"));   // or bearer(...)

try {
  const decision = await call("/api/external/screen", {
    credential,
    body: {
      tool: "crm.read_contact",
      declaredRisk: "routine",
      estimatedCostUsd: 0.4,
      requiredScopes: ["owner_services"],
      subject: { contractId: "ctr_fl_0001" },
    },
  });
  // decision.outcome === "allowed"; decision.effectiveRisk may be HIGHER than
  // what was declared, because the operator's rating for the tool floors it.
  await doTheWork();
} catch (error) {
  if (error instanceof ApprovalPending) {
    await waitForApproval(credential, error.approvalId);   // §4
  } else if (error instanceof GovernanceDenied) {
    // Stop. Do NOT retry: repeated refusals inside the window contain the
    // agent, and a human has to release it.
    await tellSomebody(`the platform refused: ${error.reason} — ${error.message}`);
  } else {
    throw error;
  }
}
```

---

## 4. Waiting on a human

```js
async function waitForApproval(credential, approvalId, { timeoutMs = 3_600_000 } = {}) {
  const deadline = Date.now() + timeoutMs;
  let waitMs = 5_000;

  while (Date.now() < deadline) {
    const state = await call(`/api/external/approvals/${approvalId}`, {
      method: "GET",
      credential,
    });
    if (state.status === "granted") return state;
    if (state.status !== "pending") {
      // rejected, expired, or already consumed. All of them mean no.
      throw new Error(`approval ${approvalId} is ${state.status}`);
    }
    await sleep(waitMs);
    // Back off. Polling every second for an hour is a denial-of-service attempt
    // against a queue a human reads at human speed, and it counts against the
    // agent's request ceiling.
    waitMs = Math.min(waitMs * 2, 60_000);
  }
  throw new Error(`approval ${approvalId} was not decided in time`);
}
```

---

## 5. Report what you did

```js
// Derived from the episode, NOT from the attempt. Every retry of this episode
// must present the same key, or the retry charges the owner twice.
const idempotencyKey = `episode:${conversationId}:${episodeStartedAt}`;

const ingested = await call("/api/external/report", {
  credential,
  body: {
    tool: "owner.summarise",
    idempotencyKey,
    goal: "summarise the owner's outstanding questions",
    startedAt: episodeStartedAt,
    endedAt: new Date().toISOString(),
    outcome: "succeeded",
    summary: "three questions answered from the contract",
    costUsd: 3.25,
    subject: { contractId: "ctr_fl_0001" },
    steps: steps.map((step) => ({
      name: step.name,
      tool: step.tool,
      startedAt: step.startedAt,
      endedAt: step.endedAt,
      outcome: step.ok ? "succeeded" : "failed",
      costUsd: step.costUsd,
    })),
  },
});

if (ingested.duplicate) {
  // Already recorded under this key. The ORIGINAL record came back and nothing
  // was counted twice. This is the expected outcome of a retry, not a problem.
}
```

Retrying this call is safe *because* of the key. Retrying without one is how a
network blip becomes a doubled spend figure in a report somebody presents to
finance.

---

## 6. A live run, and honouring the kill switch

```js
const run = await call("/api/external/runs", {
  credential,
  body: { tool: "owner.summarise", goal: "work through the open questions" },
});

const controller = new AbortController();

/**
 * Beat, and obey the reply.
 *
 * The reply is a directive, not an acknowledgement. This platform cannot reach
 * into the runtime to stop anything — the one moment it can stop us is the
 * moment we next ask, which is here.
 */
async function heartbeatLoop(externalRunId, intervalMs) {
  while (!controller.signal.aborted) {
    await sleep(intervalMs);
    let reply;
    try {
      reply = await call(`/api/external/runs/${externalRunId}/heartbeat`, {
        credential,
        body: {},
      });
    } catch (error) {
      if (error instanceof GovernanceDenied) {
        // Being refused a heartbeat is not a reason to keep working.
        controller.abort(new Error(`heartbeat refused: ${error.reason}`));
        return;
      }
      // A transport failure is not permission either. Keep beating, but if the
      // run goes quiet for reclaimAfterSeconds it is closed on the record with
      // the honest outcome that nobody heard from us.
      continue;
    }

    if (reply.directive === "stop") {
      // Stop NOW. Not after this step, not after a retry.
      controller.abort(new Error(reply.reason ?? "stopped by the platform"));
      return;
    }
  }
}

const beating = heartbeatLoop(run.externalRunId, 30_000);

try {
  await doTheWork({ signal: controller.signal });
  await call(`/api/external/runs/${run.externalRunId}/finish`, {
    credential,
    body: { outcome: "succeeded", summary: "three questions answered", costUsd: 2.5 },
  });
} catch (error) {
  if (controller.signal.aborted) {
    // The platform stopped us. The run is already closed on its side; do not
    // finish it, and do not report it as an episode that completed.
    return;
  }
  await call(`/api/external/runs/${run.externalRunId}/finish`, {
    credential,
    body: { outcome: "failed", summary: String(error).slice(0, 4000), costUsd: spentSoFar },
  });
} finally {
  controller.abort();
  await beating;
}
```

Beat well inside `reclaimAfterSeconds` — half of it is a reasonable interval.

---

## 7. Have the platform act for you

```js
// A read runs immediately.
const contact = await call("/api/external/execute", {
  credential,
  body: {
    integration: "crm",
    operation: "read_contact",
    mode: "read",
    request: { contactId: "ctr_fl_0001" },
  },
});

// A write is two-phase and digest-bound. Build the request ONCE and keep it:
// the commit must be identical in content to what a human approved.
const write = {
  integration: "crm",
  operation: "update_contact",
  mode: "write",
  request: { contactId: "ctr_fl_0001", field: "mailing_preference", value: "post" },
};

let parked;
try {
  await call("/api/external/execute", { credential, body: write });
  throw new Error("a write should have been parked for a human");
} catch (error) {
  if (!(error instanceof ApprovalPending)) throw error;
  parked = error.body;   // parkedActionId, approvalId, preview
}

await waitForApproval(credential, parked.approvalId);

const result = await call("/api/external/execute", {
  credential,
  // Same object. Key order does not matter — the binding is to canonical
  // content — but any changed VALUE voids the action.
  body: { ...write, parkedActionId: parked.parkedActionId },
});

switch (result.outcome) {
  case "completed":
    break;
  case "already_done":
    // A replayed commit. It was not performed twice.
    break;
  case "indeterminate":
    // Started, outcome never recorded. It may or may not have landed. DO NOT
    // RETRY: a retry of an action that succeeded is a duplicate effect on a
    // real owner's record. Escalate; an operator has been told to look.
    await escalate(result.message, result.parkedActionId);
    break;
}
```

---

## 8. Before you call it done

- [ ] `GovernanceDenied` stops the agent; it never becomes a retry loop.
- [ ] `ApprovalPending` is treated as "wait", never as "proceed".
- [ ] `idempotencyKey` is derived from the episode, not from the attempt.
- [ ] The heartbeat loop aborts the work on `stop`, and cannot be starved by
      the work it is supposed to be able to interrupt.
- [ ] `indeterminate` escalates to a person and is never retried.
- [ ] The credential comes from a secret store and never reaches a log,
      an error message, or a trace.
