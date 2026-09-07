# Browser E2E — 74ecd5c — 2026-09-07

Status: executed; two browser failures and one pre-existing wording issue observed.
No product code was changed. This is not an all-green certification.

## Scope and environment

- Commit: `74ecd5ca0ebcc56c3a54a021f7ccee62345e8973`.
- Change boundary: first-parent diff, `74ecd5c^1..74ecd5c` (merge into dev).
- Started with the requested **`pnpm dev`**, in the commit's clean worktree.
- Browser: Codex in-app Browser, through CUA and its supported Playwright API.
- Entry point: `https://localhost:8443/free/`, including the real nginx proxy.
- Docker build passed TypeScript compilation and client/server builds.
- Startup applied `20260906T2044_extraction_review_drafts` to the existing local
  database. Existing volumes were retained; no reset was performed.
- Switching the existing `free` stack from another checkout was explicitly
  approved by the user. The previous checkout had uncommitted changes; it was
  not used as evidence for this commit.
- Runtime hashes matched the checkout for `api.ts`, `useExtraction.ts`,
  `useBatchExtractionReviewGrid.ts`, and `packages/extraction/src/lexical.ts`.

An isolated project, **E2E 74ecd5c review workflows**, was created in Browser:
`e6b66f8c-70e7-4431-a706-bff1db187413`.
Its source `013bf7b0-8f9b-4496-ad4b-432da7c848d0` was uploaded through the file
chooser from `examples/Beretning_Ellekilde_8_13.pdf`. Real parsing produced six
pages and 329 Evidence entries. The existing Graves project was not edited.

The saved Ollama endpoint on port 41900 was unavailable. Model generation was
therefore supplied by a temporary deterministic HTTP fixture on port 41901;
authentication, ingestion, scheduling, provider adapters, grounding, evidence,
schema revisions, review persistence and concurrency remained real.

## Failures

### P1 — A draft-write 401 stalls automatic reauthentication

1. Open a completed, unreviewed extraction and save partial decisions.
2. Return HTTP 401 for only that extraction's `/review/draft` request. Keep
   authentication, callback, session and document routes unchanged.
3. Reverse the rejected year decision in Browser.

Observed: nginx records the draft POST returning 401. The UI changes to
**Opening FREE Studio / Resolving session…**, retains the document URL, and
does not request `/auth/login`. It stays there across subsequent observations.
No active JavaScript dialog was exposed by Browser. After the fault was removed,
manual reload recovered and saved the captured reversal: year 1801 was approved,
and the earlier title approval remained.

Automatic reauthentication is a **FAIL**; captured-decision recovery after manual
reload is a **PASS**. This does not demonstrate a successful automatic OIDC
round trip after draft expiry.

Likely interaction, based on source inspection: the new draft transport installs
`beforeunload` at `prototypes/studio/src/api.ts:177` and removes it only when the
write settles. `authenticatedFetch.ts:41` synchronously reports the 401 before
that settlement, and `AuthApplication.tsx:137` changes to redirecting state and
calls navigation. The guard is therefore still active during that navigation.
The precise browser cancellation mechanism remains unverified; reproduce with
a visible browser dialog before treating this explanation as a confirmed fix.
The guard itself is new in the tested first-parent diff.

Test extraction: `21b020c1-2e62-4335-9575-6687b3a35a16`.

### P2 — Sign out receives 403 without visible feedback

1. Open Researcher Account.
2. Activate Sign out with the pointer; repeat with Enter.

Observed: both activations POST `/free/auth/logout` and receive HTTP 403. The
project page and menu remain visible with no error message. This occurred before
fault injection; the normal project-creation POST succeeded in the same session.

The sign-out form, canonical-origin guard and nginx referrer policy are unchanged
in the first-parent diff. This run does **not** attribute the failure to 74ecd5c
or prove it occurs in every browser. The origin rejection needs investigation
against this nginx-prefixed browser path.

### P3 — Partial-review quality badge describes the wrong denominator

In the six-value batch, approve title only. The badge says **17% approved
unchanged so far**, with a tooltip claiming 17% of fields reviewed so far were
approved unchanged. The only reviewed field was approved unchanged. After one
approval and one edit, it says 17% again, rather than the 50% implied by that
tooltip.

`confirmedNoChangeShare` divides confirmed approvals by **all** reviewable
decisions, while the tooltip describes reviewed-so-far decisions. Both the
calculation and wording are present in the first parent: this is a pre-existing
wording inconsistency, not a newly introduced calculation regression. Final
completed review correctly shows 83% for five approvals and one edit.

## Browser coverage

| Changed feature/workflow | Result and evidence |
| --- | --- |
| Migration and existing data | PASS: forward draft migration completed; existing project and source documents remained accessible. |
| Session startup | PASS: after stack replacement, real mock-OIDC authorization/callback requests produced an authenticated workspace. Ordinary Studio restart retained access. Eight-hour expiry itself was checked separately below. |
| Single-document partial draft | PASS: approval displays Draft saved, survives refresh and appears in another tab; untouched fields stay pending. |
| Single-document competing tabs | PASS: stale write shows the conflict banner, retains the local decision and offers Reload server review; reload restores the authoritative title approval and original year. |
| Single-document edit/reject/reverse | PASS: edit year to 1902; reject/reverse/reject nested detail; rapid writes serialize and complete without a spurious conflict. |
| Finalization after draft writes | PASS: approve remaining preserves the edit and rejection, automatically finalizes all six decisions, and reload shows year 1902 and detail null in Raw JSON. |
| Draft failure and Retry | PASS with a targeted 503: decision remains visible, Retry draft appears, removing the fault and clicking Retry produces Draft saved. |
| Unsaved decision on 401 | FAIL for automatic navigation; PASS for capture/recovery after manual reload. See P1. |
| Batch partial draft | PASS: column approval and year edit to 1903 persist across deep-link refresh and a real Studio restart. |
| Batch integer validation | PASS: 1.5 is rejected with Enter a whole number; it cannot become a saved integer edit. |
| Batch competing tabs | PASS: stale column approval receives conflict; Reload server review restores authoritative decisions. A stale tab also cannot overwrite an already-finalized review. |
| Batch finalization | PASS: approve remaining preserves 1903, marks Review saved, reaches Reviewed, and Needs review (0) removes the row. |
| Batch empty draft | PASS: approve a field, Revert all, refresh; seven values remain pending, zero touched, Not yet reviewed. |
| Batch failure and Retry | PASS: targeted 503 shows Retry draft; after restoring the endpoint, retry clears the alert and displays Draft saved. |
| Current versus pinned schema on reopen | PASS: after creating Revision 2, refresh retains its current description; the reviewed extraction remains pinned to read-only Revision 1 and reports Extraction Schema updated. |
| Field order | PASS: fixture returns findings before title and detail before kind; review renders title/year/tags/findings and kind/detail, following schema order. |
| Nested keyboard navigation | PASS: Enter opens findings; Space opens Finding 1 and exposes child review controls. Enter also opens scalar-array items. |
| Evidence doubt flags | PASS: Grav 8 reports one other passage; 1801 reports absent from linked passage. Rejection/edit hides the original check and decreases To check; approval retains the check. |
| Lexical normalization | PASS: extracted 25–35 matches source 25-35 and 2.2 matches source 2,2 without a Check badge. Extracted 25 against the 25-35 passage is correctly flagged. |
| Evidence navigation | PASS: clicking decimal evidence highlights the PDF passage containing 2,2 m. |
| Automatic output UI | PASS: neither Capability Routes nor Single model exposes retired output-format controls. Raw NuExtract remains separately selectable on Ollama. |
| Single model save | PASS: changing the Single model ID, applying and reopening preserves one target for both capability routes. |
| Legacy output overrides | PASS: test-only saved jsonOutput fields load without an error; Browser Apply removes both fields from persisted configuration. |
| OpenAI-compatible schema transport | PASS: Browser extraction generates actual json_schema requests containing a JSON Schema, and completes with six grounded values. |
| Automatic fallback and memory | PASS: explicit unsupported-format HTTP 400 triggers a request without response_format; extraction remains grounded. The next run omits response_format for both generation calls. |
| Raw NuExtract compatibility | PASS: schema generation, Article extraction and the first batch complete through /api/generate with the raw route. |
| Sign out | FAIL on this Browser/nginx path; see P2. |

## Supporting checks and limits

**119 supporting tests passed**, separate from Browser E2E:

- 83 Studio tests: `server/session.test.ts`, `src/api.reviewDraft.test.ts`,
  `api/_model.transport.test.ts`, `api/_model_config.test.ts`, and
  `api/document_reopen.test.ts`.
- 36 extraction package tests, including multilingual dates, numeric grouping,
  signs, decimals, ranges, lexical boundaries, grounding and execution paths.

Eight-hour expiry boundaries, old session versions, token validation and cookie
attributes were verified by the session tests, not by waiting eight hours in
Browser. No system clock was changed. The 401 was a narrowly scoped injected
response, not an actually expired cookie.

One initial outage check stopped Studio and observed an HTTP 502 draft error.
Restart then triggered Vite's automatic page reload. That attempt did not verify
the Retry button; the later targeted 503 checks did, without restarting Studio.

One initial OpenAI-compatible fixture response failed to recognize the grounding
prompt's content-array representation, producing zero evidence. Correcting the
fixture produced six grounded values; this was not classified as a product bug.

Coverage is representative of each changed browser surface, not exhaustive
permutations: no separate Catalog discovery run, multi-document batch failure
permutation, production Entra administration, live model quality evaluation,
eight-hour wall-clock wait, or downloaded export-byte validation was performed.

## Final state and evidence

- `pnpm dev` remains running at the tested commit, with the original volumes.
- Original Ollama and Codex CLI routes were restored, including raw NuExtract
  and the original Ollama port 41900. That pre-existing endpoint remains unavailable.
- The added OpenAI-compatible connection was removed after becoming unused;
  the temporary model server was stopped.
- Original nginx configuration was restored after every injected fault.
- The isolated test project and its extraction/review history remain for inspection.
- The existing Graves project was not modified.
- No product fixes, commits or external issue submissions were made.

Local reproduction artifacts are retained, git-ignored, under
`prototypes/studio/test-results/e2e-74ecd5c/`: `model.mjs`, `requests.jsonl`,
the fixture mode, and the original/temporary nginx includes. The model fixture's
request log contains actual transport payloads from Browser-triggered extraction.
The temporary nginx include is evidence only and is not installed in the stack.

## Follow-up: Revert all after automatic finalization

The user subsequently reported that Revert all was disabled after the complete
review saved. The original coverage tested reverting draft decisions, not a
finalized review. The button and handler both excluded finalized members.

The working tree now supports a version-checked reset to pending, retains prior
review revisions, and projects only the current active revision into results.
The live batch `7e670311-4f9e-4069-867c-43ede52b3a6b` was reset through Browser:
all seven values returned to pending, 0% reviewed, and remained pending after
refresh. The development stack now includes this uncommitted fix.

Validation: typecheck passed; Studio's full suite passed (987 tests), followed
by all 40 grid tests including reset failure/retry and a repeated finalize/reset
cycle; Extraction unit tests passed (36); disposable PostgreSQL tests passed
(19), including ownership, concurrent resets, stale versions, preserved history,
and batch result projection after reset and re-finalization.
