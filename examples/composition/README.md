# Host-neutral composition example

This example wires Support Desk the way a host should: public package entry
points only, a memory `Store`, synthetic `AccessContext` values, a fixed
`Clock`, a fake mail provider, and process-local worker cursor stubs. It does
not use Express, Hono, Auth0, Cloudflare, Azure, or a real mail SDK.

## What it proves

- customer create, list, read, and reply through
  `@pegma/support-desk-application`;
- staff detail, queue, note, assign, priority, and reply;
- internal notes stay out of the customer view and customer-visible mail body;
- one complete mail send page via `supportMail.worker` with host-owned cursor
  persistence modeled by `MemoryCursorStore`;
- one queue repair page with a separate cursor key.

## Run

From the repository root with Node.js 22 or newer:

```sh
npm ci
npm run example
```

## Host mapping

Map application outcomes to HTTP using
[docs/HOST_COMPOSITION.md](../../docs/HOST_COMPOSITION.md). Never return raw
exception messages, storage keys, email addresses, permission sets, or provider
diagnostics to a browser.

Schedule the host-owned loops documented there (mail send, reconciliation,
terminal sweep, customer-index prune, receipt sweeps, queue repair, queue
inactive-row sweep). Each loop needs its own durable cursor; this example only
keeps cursors in process memory.

> [!WARNING]
> This example is not production infrastructure. Replace the Store, access
> resolution, clock, provider, templates, and cursor store before accepting
> real traffic.
