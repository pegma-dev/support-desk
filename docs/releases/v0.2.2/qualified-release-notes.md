# Support Desk 0.2.2

All five synchronized packages are published and strictly verified at `0.2.2`: contracts, core, templates, application and the optional AI package.

This release adds opt-in durable retrieval staging for assistant answers and immutable resolution-learning review intents. Hosts can prepare and retain a review intent, recover an already committed outcome before obsolete draft checks, or atomically cancel-or-recover after an unknown acknowledgement. Current staff/resource authority and transactional Audit checks remain enforced.

The default assistant path remains monolithic. Opt-in staging consumes the first existing attempt for retrieval without a paid model call. After the new `prepared` result, the host must return from that physical invocation and resume later; the next attempt provides one paid opportunity. Both application and configuration caps must permit at least two attempts, without resetting or automatically raising them. The full validated configuration and customer-authority snapshots must remain stable between phases; changed evidence fails closed before paid work.

Migration: exhaustive TypeScript handlers must cover the new `prepared` result member even when callers leave staging disabled. Hosts adopting review recovery must retain the immutable SDK intent rather than rebuild an uncertain command from newer draft fields. The optional AI package now pins Knowledge Base application/contracts to exact `0.1.5`; published `0.2.1` artifacts retain their original dependencies.

The protected signed tag binds [source 99cf4e67](https://github.com/pegma-dev/support-desk/commit/99cf4e67da1d2357d99fd80389a96318a6e2cc93). Both Node 22/24 release lanes passed 2,600 tests in 57 files with zero skips. [Publication run 42907283767](https://github.com/pegma-dev/support-desk/actions/runs/42907283767) completed on its original attempt: all seven jobs and 94 steps succeeded. No recovery, repack or replacement artifact was required.

The [workflow verifier](https://github.com/pegma-dev/support-desk/actions/runs/42907283767/job/130161276758) and an independent retained check passed exact registry byte/dependency and source-provenance checks, genuine npm 11.18 signature/Sigstore verification, and a clean registry install with lifecycle scripts disabled and all six public entry points imported. The public receipt separates mutable dist-tags from immutable release identity.

Preserved evidence files: `package-manifest.json`, `prepared-artifact.json`, `verification-job.json`, `registry-verification.json`, and the untouched `support-desk-v0.2.2-original-artifact-13806500809.zip`. Verify original ZIP SHA-256 `aea7c164b2c5b25d3d7a827d1bac24aac65909a6c4bd1b983e6c9e2e890ca106` before extraction, then manifest SHA-256 `3fd79ca5400e57f6c0edb8657441f38bb16043a3a0ea1d0cfda595dcc848853d`. The [release page](https://github.com/pegma-dev/support-desk/releases/tag/v0.2.2) provides the publication record.

Host dependency adoption, deployment/privacy/operational checks, requested-client acceptance, live-provider evaluation and supervised pilots remain separate gates. This SDK release does not establish a universal Workers Free query or CPU budget.

Developed by RetireGolden, LLC. MIT licensed.
