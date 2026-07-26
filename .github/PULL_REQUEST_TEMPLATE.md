## Summary

<!-- What changed, and why? -->

## Customer, authorization, and privacy impact

<!--
Describe any change to customer-visible messages, staff access, requester
association, ticket ownership, provider data, retention, or sensitive content.
Write "None" when not applicable.
-->

## Delivery and compatibility impact

<!--
Describe idempotency, retry, threading, public-contract, migration, and provider
compatibility effects.
-->

## Validation

<!-- List the checks you ran. -->

- [ ] `npm run check`
- [ ] `npm test`
- [ ] `npm run format:check`

## Checklist

- [ ] Workflow changes include successful and rejected-transition tests.
- [ ] Authorization changes include cross-account or denied-access tests.
- [ ] Customer-visible and internal message paths remain separated.
- [ ] Retryable operations are idempotent.
- [ ] Public API changes include documentation and migration impact.
- [ ] No provider-specific types leaked into core contracts.
- [ ] No secrets, credentials, mailbox payloads, or customer data are included.
