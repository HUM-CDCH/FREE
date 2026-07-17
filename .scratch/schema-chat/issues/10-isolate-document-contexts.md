# 10 — Isolate active Source Document contexts

Status: resolved
Type: task
Blocked by: 09

## What to build

Opening another Source Document starts a new active document context:
increment the monotonic document epoch, abort schema generation and chat for
the previous context, clear the approved schema, pending suggestion,
conversation, and Extraction Results, and reset schema revision for the new
epoch. Generation, chat, and extraction responses from a previous epoch must
not cross into the new context — completion guards include both epoch and
revision. `SchemaPanel` local editing state resets after an external Apply.

Run the final integrated acceptance verification against the complete
acceptance list in `docs/schema-chat-plan.md` § Acceptance, with the
credentialed Gemma check as the documented manual smoke test.

## Acceptance criteria

- [x] Opening another Source Document clears all browser-owned document context
- [x] Late generation/chat/extraction responses from a previous epoch cannot commit
- [x] Revision resets per epoch; guards always pair epoch and revision
- [x] `SchemaPanel` local editing state resets after external Apply
- [x] Full plan acceptance list verified; manual smoke procedure current
- [x] Focused lifecycle tests added; test, lint, and build green

## Answer

Opening another Source Document now establishes a new monotonic document epoch,
resets revision to zero, removes the approved Extraction Schema and pending
suggestion, and remounts document-scoped chat and schema panels. The remount
stops and clears the previous conversation and resets SchemaPanel editing state;
Extraction Results are projected idle by the epoch/revision extraction identity.
Schema generation is aborted and its success and error completions now require
both the captured epoch and revision to match the active context, even if the
transport ignores cancellation. Existing chat suggestion freshness and
extraction completion guards likewise pair epoch with revision, so a reset
revision cannot make prior-document work current. The document-opening reset is
now one tested transition used by `App`, and a generated root suggestion can be
Applied or Rejected while the new document has no approved schema; rejecting it
clears only the pending review state and leaves revision zero unchanged.

The complete plan acceptance list is covered by the integrated Studio suite.
The credentialed Gemma procedure remains current in
`docs/schema-chat-provider-spike.md`; it is the documented VPN-only manual smoke
rather than an uncredentialed CI test.

Verification: `pnpm --filter studio test`, `pnpm --filter studio lint`, and
`pnpm --filter studio build` pass (197 tests passed, 2 credentialed smoke tests
skipped; Vite reports only its existing chunk-size warning). The focused
lifecycle coverage includes the complete App-owned document reset, stale
epoch/revision completion guards, and the idle root-suggestion Reject path.

## Blocked by

- 09-modify-schema-through-chat
