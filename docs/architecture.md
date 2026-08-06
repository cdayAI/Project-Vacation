# Architecture

Written for an engineer who will maintain this after handover. It explains the
shape of the system and, where the shape is unusual, why.

---

## 1. The one-sentence version

Every consequential action passes a single authorization chokepoint, is recorded
in a durable operating record, and produces an entry in a hash-chained audit log
— and every control on that path refuses rather than proceeds when it cannot do
its job.

Most of what follows is a consequence of that sentence.

---

## 2. Module layering

Modules may import from their own layer or below, and never above. An
architecture test enforces this; a violation fails the build.

```
layer 8   cli
layer 7   api
layer 6   demo
layer 5   workflows
layer 4   improve, discovery
layer 3   roles, engine, documents, external
layer 2   knowledge, integrations, contact
layer 1   guard, models, identity
layer 0   record, audit, timeline
layer -   kernel                      (everything may import kernel)
          store/db                    (adapters only)
```

**Why the layering is worth enforcing.** The governance controls live in `guard`.
If `guard` could import `engine`, a future change could route an authorization
decision through workflow state, and the chokepoint would stop being a
chokepoint. The layering is what makes "every action passes through one place"
a structural property rather than an aspiration.

**Three deliberate asymmetries.** `timeline` is at layer 0 despite being domain
logic, because statutory deadlines must be computable without any of the
machinery above them — that keeps the highest-consequence computation testable
in isolation. `discovery` must not import `models`, enforced by its own test,
because employee observations must never reach a model provider. And `external`
— the plane that governs agents running outside this platform — sits at layer 3
rather than at the entry points, because it is not an entry point: it is a set
of controls that the API and the CLI both call into, and putting it beside them
would let a route make a decision the plane is supposed to own.

**`external` is governance, not orchestration.** It has no scheduler and no
state machine for somebody else's agent, because an agent that runs elsewhere
cannot be orchestrated here. What it has is an admission chain, a record of
everything the agent asked for, and a two-phase path for actions it wants this
platform to perform on its behalf. See ADR 0016.

---

## 3. Request path

```
  browser
     │  session cookie
     ▼
  api/          route, parse, resolve actor from session
     │
     ▼
  guard/authorize.ts ─── registry: is this action registered? risk tier?
     │                   containment: is anything stopped?
     │                   mode: is this permitted in shadow/assisted/...?
     │                   role: does this actor hold a permitted role?
     │                   scope: is this actor entitled to this data?
     │                   step-up: recent re-authentication?
     │                   ceilings: spend, rate, time — with reservation
     │                   approval: consume, bound to the proposal digest
     │
     │  ── any failure ──▶ DeniedError, audited, nothing happens
     ▼
  the action
     │
     ├──▶ record/   step appended with input and output digests, cost recorded
     └──▶ audit/    decision appended to the hash chain
```

The order inside the chokepoint is deliberate. Cheap, decisive checks run first;
approval consumption runs last, because consuming an approval is destructive and
burning a human's decision to then fail a role check would be rude and would
force them to approve again.

---

## 4. The seven ideas that carry the design

### 4.1 Refusal is a type

`DeniedError` carries a machine-readable `DenialReason`. It is not a generic
`Error`. That distinction is what lets a caller — or a reviewer — tell "we chose
not to" apart from "something broke", and it is why the fail-closed posture is
enforceable rather than merely intended. Anything that catches a `DeniedError`
and continues is a bug.

### 4.2 The audit log holds fingerprints

Entries record digests of inputs, opaque subject references, and a structured
decision. `AuditLog.record` refuses anything that looks like a payload. This is
what lets the platform satisfy a compliance reviewer and a privacy officer at
the same time, and what lets a deletion request be honoured without breaking the
evidence trail.

### 4.3 Canonical JSON exists for two callers

`kernel/canonical.ts` guarantees byte-identical serialisation of equal values.
The audit hash chain and approval digests both depend on it. If serialisation
were unstable, an intact chain would fail verification and an approval would
stop matching its proposal — both indistinguishable from tampering, and both
expensive to diagnose. Hence one implementation, used by everything that hashes.

### 4.4 Nothing reads the wall clock

Everything takes a `Clock`. This is not fussiness: statutory deadlines are
computed from these values, the demo must reproduce byte-for-byte, and workflow
timers must be testable without waiting. An architecture test asserts that
nothing outside `kernel/clock.ts` calls `Date.now()`.

### 4.5 Ports with two adapters and one contract suite

Every persistence dependency is a port with a Postgres adapter and an in-memory
adapter, and one contract-test suite runs against both — **including concurrency
tests**, because the platform's guarantees are concurrency guarantees. That is
why `MemoryDb` has a real mutex rather than relying on JavaScript's
single-threaded execution to hide the problem.

### 4.6 Atomicity lives in the port, not the caller

Three operations cannot be safely composed by a caller and are therefore single
port methods: audit sequence assignment, step sequence assignment, and approval
consumption. Each would be a race if expressed as read-then-write. The port
contract says so explicitly, and both adapters implement it.

### 4.7 Idempotency instead of distributed transactions

Local durability comes from transactions; correctness of external effects comes
from idempotency keys checked against the operating record before the effect
(ADR 0007). There is no two-phase commit anywhere.

---

## 5. Where to make common changes

| I want to… | Go to |
| --- | --- |
| Add a new action the platform can take | `guard/registry.ts` — declare its risk tier; unregistered actions are refused |
| Add a workflow | `workflows/` — a declarative definition, versioned |
| Add or change a state's rescission rule | `timeline/rules.ts` — data, not code |
| Change which model serves a task | model inventory configuration — never business logic |
| Add a system of record | `integrations/` — a narrow port, a realistic fake, contract tests |
| Add a console view | `packages/console/src/views/` — and an accessibility assertion, or CI fails |
| Stop something right now | Containment CLI — global, workflow, role, or integration; seconds, no deploy |
| Add a persisted entity | Your module's `types.ts`, `port.ts`, both adapters, a new migration |

---

## 6. Things that will look wrong until you know why

**Denials are logged at `info`, not `error`.** A refused action is the platform
working. Logging refusals as errors trains operators to ignore errors.

**`guard/ceilings.ts` throws *after* spending money.** The post-hoc check stops
the *next* step. It converts an unbounded runaway into one bounded by a single
step's cost, which is the best any consumption meter can do.

**Compensation steps run even under containment.** Refusing to run a
compensating action after a pause would leave the world in the broken half-state
the compensation exists to repair.

**The in-memory store has a mutex.** It is a fake, not a toy; the contract tests
run concurrent callers against it.

**`timeline/rules.ts` ships every rule marked `verified: false`.** The engine is
correct; the data is placeholder, and saying so is better than shipping
plausible-looking citations someone later relies on.

**There is no way to auto-apply an improvement.** Not a missing feature. See
ADR 0011.

---

## 7. What is deliberately absent

No autonomous self-modification. No agent marketplace. No offline reflection
subsystem. No plugin marketplace. No multi-tenancy. No card data. Each has an
ADR explaining the refusal, so that a future request meets a recorded decision
rather than an oversight.
