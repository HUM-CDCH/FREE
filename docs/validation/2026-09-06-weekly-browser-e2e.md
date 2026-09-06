# Weekly Browser E2E — 2026-09-06

Status: executed; two defects reproduced; both fixed (P2 retested below, P1 fixed in `83a07c09`); download delivery remains inconclusive.

Scope: commits reachable from `62e42dc5` dated 2026-08-30 through 2026-09-06,
plus the working-copy changes already present in `ResultsTab.tsx` and
`packages/extraction/src/lexical.ts`. No product code was changed by this test run.
This is workflow coverage, not an exhaustive test of every provider or failure permutation.

All interactive checks used the requested Codex **Browser** through its supported
CUA/Playwright API. PostgreSQL, migrations, ownership, OIDC, Studio, extraction
jobs, grounding, and review persistence were real. Model responses and canonical
ingestion packages were deterministic fixtures adapted from
`prototypes/studio/e2e/canonical-evidence-lifecycle.spec.ts`.
Live model quality, fresh Docling ingestion, GPU experiments, production deployment,
and Entra tenant administration were not tested.

## Findings

### P1 — OpenAI-compatible schema output does not transmit the schema

1. Configure an OpenAI-compatible connection to the local fixture endpoint.
2. Select **Schema-constrained output**, Apply, close and reopen the dialog.
3. Run an Article Extraction; repeat with **JSON mode and schema-constrained output**.
4. Inspect the request captured by the fixture provider.

Expected: the extraction request carries its JSON Schema, including required fields.
Observed for both explicit settings: `response_format: {"type":"json_object"}`;
there is no `json_schema`. This is an actual wire request produced by a Browser
action, not a mocked call to `generateText`.

`prototypes/studio/api/_provider.ts:493` creates `createOpenAICompatible` without
`supportsStructuredOutputs`. The installed adapter only serializes `json_schema`
when that option is true; otherwise it serializes `json_object`. The application
still validates returned values, but it does not enforce the advertised schema
at generation time. The 101 passing model/schema unit tests did not catch this.

This was also observed with Automatic, although the strongest reproduction is
the explicit schema override. Fix belongs at provider creation/capability wiring;
add an actual HTTP transport assertion for the OpenAI-compatible provider.

Follow-up fix (2026-09-06, `83a07c09`): the OpenAI-compatible provider is now created
with `supportsStructuredOutputs`, so explicit schema output serializes `json_schema`;
`_model.transport.test.ts` asserts the wire format.

### P2 — Nested extraction records cannot be opened using the keyboard

1. Complete the two-record Catalog fixture and open Results → Review.
2. Attempt to focus/activate **Item 1** using the keyboard.
3. Click the same item with the pointer.

Observed: Enter does not open the item and focus stays on the Results tab;
pointer click opens the record. The rendered row is a `div` with `onClick`,
without a button role, `tabIndex`, or keyboard handler. Nested arrays use the
same pattern, affecting access to individual nested review decisions.

Locations: `prototypes/studio/src/ui/ResultValue.tsx:462` and `:517`.
This is a defect in a surface modified during the week; this run does not claim
that the missing keyboard support was first introduced during that week.

Follow-up fix (2026-09-06): both row headers now use native buttons, with visible
keyboard focus and `aria-expanded` for inline disclosure. The four new regression
cases failed before the fix; all 31 ResultValue/ResultsTab tests and Studio
typecheck pass afterward. Browser retest on the persisted Catalog fixture passed:
Tab reaches Item 1 with a 2px visible outline, Enter opens it, Space opens findings,
Tab/Enter opens Finding 1, and Space opens Item 2.

## Browser coverage

| Modified feature/workflow | Evidence and outcome |
| --- | --- |
| Authentication and account navigation | PASS: real mock OIDC login; keyboard logout reaches signed-out page; different fixture identity gets its own project rail. |
| PDF authentication failure (`00b62471`) | PASS: a local fault proxy returned 401 only for the versioned PDF request, while session/bootstrap requests remained real. FREE redirected to OIDC; completing sign-in restored the same document URL and all six PDF pages. |
| PDF loading/navigation | PASS: retained canonical PDF renders six pages, source navigation opens the document, reload/back restores the workspace. |
| Project creation and rename (`e4421e93`) | PASS: Enter creates and renames; the rail updates; Escape from creation returns focus to Create project. |
| Destructive-dialog accessibility (`e4421e93`) | PASS for cancellation: initial focus is Cancel; Escape closes the delete dialog and restores focus to Delete project. Permanent deletion was not executed. |
| Responsive controls (`e4421e93`) | PASS: Batch Run and provider Apply remain within the viewport and focusable at 1280×800, 1024×768, 859×800, 390×844 and 640×400 (the repository's 200% zoom-equivalent check). |
| Schema editing/history | PASS: changing record description appends Revision 2; historical Revision 1 is read-only; Close preview restores Revision 2. |
| Schema regeneration | PASS: Regenerate schema obtains the deterministic template and updates record description and typed fields. Conversational streaming schema editing was not separately exercised. |
| General-profile extraction (`c040f0ba`, `873528cd`) | FAIL: extraction completes, but explicit schema output does not send JSON Schema for OpenAI-compatible; see P1. Required-field conversion is covered additionally by existing tests. |
| Unexpected model keys (`43743cf7`) | PASS: fixture returns an extra `surprise` field; it is excluded from the rendered/persisted extraction shape. |
| Output settings (`4f688e7f`) | PASS for configuration: Automatic is the absent-field default; separate Extraction schema / Interaction prompt overrides survive reopen; Single model native override stores the setting on both routes. Raw NuExtract disables the generic output selector. Wire-level schema support fails as above. |
| Model catalog and offline Apply | PASS: an invalid catalog shows a bounded error while Apply still saves; a valid fixture catalog subsequently shows Connected with one model. Escape closes the model list while preserving the provider dialog/draft. |
| Automatic fallback (`4f688e7f`) | PASS: first run uses `json_object`; explicit unsupported-format 400 triggers prompt-only retry; grounding and a subsequent rerun omit the format. Authentication/transport errors were not mistaken for this fallback. |
| Article extraction/double activation | PASS: double-click starts an active attempt, controls disable, then an eight-value result becomes available. Fixture log records one values call and one grounding call for that initial run. |
| Values preview (`3e91df91`) | PASS: during delayed grounding, values are shown with “Values extracted · linking Evidence…”; Export/Rerun are disabled and no review actions are offered. |
| Cancellation and retry (`3e91df91`) | PASS: cancel during grounding reaches “Evidence linking stopped: Extraction cancelled.” Values remain visible, export stays disabled; Rerun completes successfully. |
| Extraction failure/history | PASS: fixture HTTP 500 produces “Extraction failed” and Retry extraction. Latest reviewed still exposes the saved 1902 edit and rejected title. |
| Single-result review (`4f688e7f`, `617cc566`) | PASS: edit year to 1902, approve/reject title, approve remaining; autosave succeeds and refresh preserves the reviewed values/decisions. An in-progress value edit survives interacting with another field. |
| Review views | PASS: Raw JSON shows edited 1902 and rejected `title: null`; Markdown and pinned read-only Schema Revision are available. |
| Evidence checks (`e9bbd52b`, `62e42dc5`) | PASS: linked title “Grav 8” has no Check badge; 1801 absent from its linked passage displays “Value not found in the linked passage”. Eight fields show seven checks. Lexical edge cases additionally run through package tests. |
| Batch execution (`3e91df91`) | PASS: two selected documents execute through queued/running states. Export/grid are initially disabled, then enabled once a member result exists; both members complete. |
| Batch grid review (`e6095701`, `4f688e7f`) | PASS: non-integer input is rejected with “Enter a whole number”; edit is preserved by column/global approval; rejection remains rejected; both rows autosave and survive grid deep-link refresh. Targeted member-load failure/retry and simultaneous multi-tab review conflicts were not separately injected. |
| Review statistics (`66feddf8`) | PASS: one unchanged row reports 100%, the row with one edit and one rejection among eight fields reports 75%; both are reviewed and Needs review (0) filters them out. |
| Catalog extraction | PASS: discovery of two fixture headings produces two records / 16 grounded values; bulk review saves. The next-run selector returns to Article. Nested keyboard access fails as P2. |
| CSV/Excel export | INCONCLUSIVE delivery: options are operable and the menu closes without a browser console error, but Browser download events time out (CSV and Excel, Excel retried with 10-second timeout). No downloaded bytes were inspected, so these are not marked E2E passes. Serialization has 33 passing non-browser tests. |

## Supplementary checks

355 existing checks passed, zero failed:

- Studio model/provider/schema: **101** (`_model`, `_model.transport`, `_provider`, `schemaNode`).
- Extraction package: **36** (`pnpm --filter extraction test`).
- Grounding Lab: **98 Python + 12 Node**. CLI-only research workflows have no Browser surface; this does not rerun live model/GPU evaluations.
- Studio PDF/results/grid regressions: **75** (`App`, `ResultsTab`, `useBatchExtractionReviewGrid`).
- Export serialization: **33** (`pnpm --filter extraction-result-export test`).

Raw local evidence is under `prototypes/studio/test-results/`:

- `weekly-01a077a9-model.jsonl`: fixture-side requests, including exact output formats.
- `weekly-01a077a9-model-tests.json`, `weekly-01a077a9-ui-tests.json`.
- `weekly-01a077a9-extraction-tests.log`, `weekly-01a077a9-lab-tests.log`, `weekly-01a077a9-export-tests.log`.

The temporary fixture/proxy scripts were archived under `tmp/weekly-01a077a9/`
and removed from the E2E source directory. Their relative imports assume the
original `prototypes/studio/e2e/` location if reused. The unique test stack and
its model fixtures remain running at `http://localhost:42749/` for inspection;
the PDF fault proxy was stopped. The first, externally reused stack was left untouched.

## Environment and limitations

The initial `free-browser-weekly` stack's provider configuration was changed by
another execution during testing (port 41750 became 47911). Subsequent checks were
isolated in Compose project `free-weekly-01a077a9`, database
`free_test_weekly_01a077a9` on loopback 46432, Studio 42749, OIDC 42748, with a
unique configuration/data directory. Initial observations after detecting
interference were not used to diagnose product defects.

The tested code includes pre-existing uncommitted changes; this is not evidence
against a pristine checkout or production build. The test stack uses Vite and
the root base path, not the nginx `/free` deployment path. Fresh parsing/uploads,
live provider credentials, all provider families, document-chat streaming,
multi-tab conflict recovery and the physical download bytes remain outside the
verified Browser coverage. Therefore this report does **not** certify every
possible end-to-end path as passing.
