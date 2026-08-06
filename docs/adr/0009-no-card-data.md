# ADR 0009 — No card data: deliberately outside PCI scope

**Status:** Accepted
**Date:** 2026-08-06

## Context

MVW takes payments — down payments at point of sale, loan servicing payments,
maintenance-fee collections. A platform touching collections and owner services
sits next to those flows, and it would be easy for a primary account number to
arrive in a free-text field, a pasted note, an uploaded document, or an
integration response.

If it does, this platform enters PCI DSS scope. That is not a small increase in
obligation. It changes the assessment, the segmentation requirements, the
logging constraints, and the cost of every subsequent change.

## Decision

**The platform never accepts, stores, transmits, or processes primary account
numbers, and is designed to stay out of PCI scope.**

Enforced rather than asserted:

1. **No card fields anywhere.** No domain type carries a PAN, expiry, CVV, or
   track data.
2. **Redaction catches them anyway.** `kernel/redact.ts` detects Luhn-valid
   candidate PANs and removes them before anything is logged, screened, or sent
   to a model provider. The Luhn check is there so ordinary long numbers —
   contract ids, account references — survive.
3. **The audit log refuses them.** `AuditLog.record` runs the secret detector
   over subject and decision values and refuses the write, so a PAN cannot enter
   the seven-year record.
4. **Payment actions are by reference only.** Where a workflow needs a payment
   to happen, it hands off to MVW's payment systems by reference — a token or a
   payment-method identifier that is meaningless outside those systems — and
   records only that reference.

## Consequences

- Workflows involving payment cannot be fully automated inside this platform;
  they hand off. That is the intended boundary, and it is a feature when
  procurement asks about scope.
- The security questionnaire and SOC 2 mapping can state the absence plainly,
  with the enforcement points named.
- Redaction may occasionally remove a Luhn-valid number that was not a card.
  Losing a digit sequence from a log line is a much smaller cost than the
  alternative.
- This is a design constraint that later feature requests will press against.
  When someone asks for card capture, the answer is that it changes the
  platform's regulatory classification, and the ADR is the reference for that
  conversation.

## Alternatives considered

**Accept card data and tokenise on entry.** Rejected: tokenising at our
boundary means the data passed through our boundary, which is what puts us in
scope. Tokenisation belongs in MVW's payment estate, before this platform sees
anything.

**Stay silent and rely on nobody sending card data.** Rejected. Free-text
fields receive whatever a human types, and hoping is not a control.
