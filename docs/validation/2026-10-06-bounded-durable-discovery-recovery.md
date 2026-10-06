# Bounded discovery recovery through durable extraction

Status: implementation verified; live acceptance and release verification in progress.
Outcome: [PR #191](https://github.com/HUM-CDCH/FREE/pull/191).

A dense Catalog discovery reply reached its output limit. The unified planner
already split unsuccessful discovery and entry windows, but durable call failure
handling paused admission and returned a failed child outcome before that fallback
could run. The original model request and token counts were reproduced against
the deployment model in an isolated database.

The forward migration adds an attempt-local `recoverable` failure policy. Only
unrecovered `length` replies in unified discovery or entry can continue to the
existing bounded split planner. Other failures retain their terminal policy.
Failed replies remain immutable failure history, separate from reusable success
checkpoints. Existing failures default to their previous terminal policy. Retry
still invokes the original immutable input, while completed calls remain reusable.
Committing a recoverable reply never clears Pause or Stop intent.

The child step consumes the policy returned by the fenced commit, including a
replay after an application commit and before native step acknowledgement. The
parent workflow's step sequence and `kei@1` application version remain unchanged.

Verification:

- The child boundary and complete native DBOS workflow both reproduced the bug
  before the fix: a truncated discovery reply caused `FAILED` before any split.
- 82 focused Python cases passed, including the unified algorithm and capture
  replay boundary.
- 15 native lifecycle cases passed: all four methods' Pause/Resume/Stop/Retry,
  queued admission, successful split recovery, and bounded failure when every
  split including a single-line window truncates.
- Five process-death cases passed, including the application commit/native
  acknowledgement gap and retained result recovery.
- Both real PostgreSQL upgrade paths passed. Restricted-role execution, immutable
  history, Retry input reuse, mixed/fatal errors, unsupported methods/stages,
  and Pause/Stop intent preservation passed.
- 88 database unit cases, database/extraction type checks, lint, and authored
  migration graph/artifact checks passed.

The live replay uses the canonical publication, pinned schema and default method
settings of the reported failure. Its initial HTTP body matched the saved failed
request exactly. It passed the initial truncation and saved a successful split
reply. An interrupted test connection caused a later transport failure; Retry
preserved the completed split checkpoint. Full completion and release acceptance
will be recorded on the resulting pull request.

Private source material, requests, traces, credentials, and deployment inventory
stay in ignored task artifacts and are excluded from this review record.
