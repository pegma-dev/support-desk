# Host-neutral composition example

This example wires Support Desk the way a host should: public package entry
points only, a memory `Store`, synthetic `AccessContext` values, a fixed
`Clock`, a fake mail provider, fake inbound account-matcher and routing ports,
and `@pegma/scheduler@0.1.0` for the seven direct host loops. It does not use Express, Hono, Auth0, Cloudflare, Azure,
or a real mail SDK.

## What it proves

- customer create, list, read, and reply through
  `@pegma/support-desk-application`;
- staff detail, queue, note, assign, priority, and reply;
- `runLifecycleExampleFlow`: normalized staff tags, the synthetic host
  response-target policy (also wired to inbound), due-soon queue filtering,
  first response and resolution milestones, safe stale-revision hints, and
  exact committed replay after a later change;
- internal notes stay out of the customer view and customer-visible mail body;
- verified inbound mail with a host-evaluated sender result: an unknown sender
  creates a low-priority unverified ticket, a provider retry is deduplicated, a
  threaded follow-up joins the ticket, an auto-reply is suppressed, and a
  unique account match is routed as `matched_email` without web access;
- mail send and queue repair as static `createScheduler` tasks
  (`mail.send`, `queue.repair`, `thread-index.repair`, plus reconcile /
  terminal-sweep / inactive-sweep / `thread-index.sweep`) with durable
  checkpoints instead of process-local cursors;
- receipt and principal sweeps remain host-selected helpers outside the task
  registry.

## Run

From the repository root with Node.js 22 or newer. Corepack is bundled
through Node 24; on Node 25 or newer, install it first.

```sh
npm install -g corepack
corepack enable
pnpm install --frozen-lockfile
pnpm run example
```

## Host mapping

Map application outcomes to HTTP using
[docs/HOST_COMPOSITION.md](../../docs/HOST_COMPOSITION.md). Never return raw
exception messages, storage keys, email addresses, permission sets, or provider
diagnostics to a browser.

Schedule the seven direct loops with `@pegma/scheduler` (host owns Cron/Timer
wakeups; this example drives `runManual`). Map each domain page’s
`nextCursor` to `nextCheckpoint`. Keep receipt/principal sweeps as separate
host-selected drivers.

> [!WARNING]
> This example is not production infrastructure. Replace the Store, access
> resolution, clock, provider, templates, and host wakeup path before accepting
> real traffic.
