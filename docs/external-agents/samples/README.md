# Setup samples

> ## These are shaped to be adapted, not copied
>
> **We have not confirmed which agent platforms MVW actually uses.** Nobody has
> told us yet whether these agents run inside a CRM's automation layer, a cloud
> provider's agent service, a purchased product with its own extension model, or
> something written in-house — and the answer changes the shape of the
> integration considerably: whether outbound HTTP with custom headers is
> available at all, whether a secret can be held, whether a background heartbeat
> loop is even possible.
>
> So these are written by **platform family** rather than by product, and no
> vendor product is named anywhere. Naming one we have not confirmed would put a
> guess into a document that reads like a decision.
>
> **"Which agent platforms are in scope, and what can code do inside them?" is
> on the consolidated open-question list.** Once it is answered, replace these
> with real samples for those platforms.

| Sample | Use it when |
| --- | --- |
| [`rest-curl.md`](./rest-curl.md) | Any platform that can make an HTTP request with custom headers. Start here to prove the plumbing before writing code. |
| [`node.md`](./node.md) | A JavaScript or TypeScript runtime — a serverless function, a worker, an extension host with `fetch` and `node:crypto`. |
| [`python.md`](./python.md) | A Python runtime — a function, a notebook-driven agent, an orchestration framework's tool layer. |

All three do the same three things, in the same order:

1. **Enrol** — what the MVW operator runs, before you write any code.
2. **Authenticate** — bearer for the simplest case, signed requests where the
   platform can hold a key.
3. **One governed call** — screen, then report; and, where the runtime allows
   it, a live run with its heartbeat.

Read [`../README.md`](../README.md) first. The published contract is
[`../openapi.yaml`](../openapi.yaml).

## Choosing a credential

| Your platform can... | Use |
| --- | --- |
| ...only set a static header | Bearer token. Rotate it on a schedule; it is a string, and strings leak. |
| ...hold a secret and compute HMAC-SHA256 | Signed requests, `hmac`. |
| ...hold a private key | Signed requests, `envelope`. |
| ...already issue signed assertions for its workloads | `jwt` — verified offline against a key set the operator pins, so no network fetch happens on the authentication path. |

Prefer the strongest one the platform can genuinely do. Once an agent holds a
signed credential, bearer authentication is **refused** for it — otherwise the
weaker credential would remain a way in and the stronger one would be
decorative.
