# Contributing to Support Desk

Thank you for helping improve Support Desk.

## Before opening an issue

- Search existing issues and planning documents.
- Use GitHub private vulnerability reporting for security concerns.
- Remove customer data, message content, credentials, and private email
  addresses from examples and logs.
- Keep core proposals provider-neutral unless they target a named adapter.

## Local development

Support Desk requires Node.js 22 or newer.

```sh
npm ci
npm run check
npm test
npm run format:check
```

## Pull requests

Keep changes focused. Include:

- the problem and intended user behavior;
- authorization and privacy implications;
- tests for workflow changes and rejected transitions;
- delivery or idempotency behavior when relevant;
- migration impact for public contracts;
- documentation for new externally visible behavior.

## Project conventions

- Do not build persistence here. Declare collections against
  `@pegma/storage-core` and take a `Store` from the host.
- Do not build an access model here. Ask `@pegma/authorization-core` whether a
  principal holds a permission.
- Import `PrincipalId`, `IsoTimestamp`, `Clock`, `Logger`, and event
  definitions from `@pegma/spine` rather than declaring local equivalents.
- Keep provider SDK types outside `contracts` and `core`.
- Treat inbound message content and sender information as untrusted.
- Never authenticate a customer solely from an email address.
- Use a stable `PrincipalId` when linking to a known account.
- Keep external message IDs for deduplication, not ticket authorization.
- Prefer append-only audit records for staff and system actions.
- Make retries safe before adding asynchronous delivery.
- Keep RetireGolden-specific plans, permissions, priorities, and branding in
  RetireGolden configuration.
- Avoid adding a production dependency when a small local implementation is
  sufficient.

## Commits

Use concise, imperative commit subjects. The project uses pull requests and
squash merging.

By contributing, you agree that your contributions are licensed under the
project's MIT License.
