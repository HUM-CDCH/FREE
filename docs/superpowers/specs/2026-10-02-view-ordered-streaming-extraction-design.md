# View-ordered, streamed extraction — design

Date: 2026-10-02 · Status: implemented locally by `docs/superpowers/plans/2026-10-03-view-ordered-streaming-service.md` (Part A) and `docs/superpowers/plans/2026-10-03-view-ordered-streaming-client.md` (Part B); Part B delivery pending (see its SDD ledger). Superseded in part by `2026-10-04-results-review-redesign-design.md` (2026-10-04, its §5): a record kei has finished may be reviewed while the run goes on, as a draft reconciled at settlement; the Constraints bullet "review, finalize and export read the settled attempt only" and §1's settlement sentence are replaced there · Scope:
`prototypes/parsing_service/src/kei_exp` (`kie/extract/unified.py`,
`kie/extract/article.py`, `kie/extract/run.py`, `api.py`), `packages/extraction/src`,
`prototypes/studio/api`, `prototypes/studio/shared`, `prototypes/studio/src`,
`packages/db` (one migration)

## Purpose

Today an Extraction is one request and one reply: Studio polls the attempt
every two seconds and shows nothing until kei publishes the whole artifact. A
catalogue of fifty records keeps the researcher waiting for the last record to
see the first.

After this change the records on the page the researcher is looking at are
read first, and every value appears as soon as it exists, in two visible
steps: read, then grounded. Article and Catalog both stream; Catalog needs it
most.

Decided with the researcher on 2026-10-02: "the page/element the user is
seeing on render has the priority when doing extraction, leverage streaming so
user can see the extracted values as soon as possible, even if incomplete …
the streaming should be at field level". Confirmed on 2026-10-02: a run still
starts on Run; the view decides only the order.

## Constraints

- A candidate is never shown as a value. `CONTEXT.md` (Unified Catalog
  Method): candidates are accepted only after a separate verification. A value
  before its verification is shown as a candidate, visibly so.
- The settled attempt stays the record of truth. Partial results are a view
  of files kei already writes; review, finalize and export read the settled
  attempt only.
- No change to a workflow's step sequence. Everything here is inside a step's
  body or in read paths, so nothing goes behind `DBOS.patch()`
  (`prototypes/studio/CLAUDE.md`).
- The artifact identity and fingerprint do not change: the start page is
  excluded from `Options.dumped()` exactly as `pages` was.
- The two-second poll stays. A model call takes longer than that; a new
  transport would buy at most two seconds per update.
- Base: a fresh worktree from `origin/dev` after the redesign spec has merged
  (the client part); the service and package parts may start in parallel.

## 1. The researcher's view

Per value, one of six states; the redesign spec defines their styling:

| State | Meaning | Shown as |
|---|---|---|
| `queued` | the record was discovered and waits | collapsed record: label and page |
| `reading` | the values call for this record (Catalog) or this value context (Article) is in flight | placeholder, never text |
| `checking` | the call returned a candidate; verification (Catalog) or grounding (Article) runs | the candidate in muted ink with a hollow marker |
| `grounded` | verified; the Evidence link exists | solid value, evidence chip, highlight on the page |
| `empty` | nothing found | as today |
| `contested` | sources disagreed | as today |

Records are listed in the order they were read: those on the start page
first, then the rest in source order. The Results tab header shows "Reading
records · 7 of 48 · started at page 6" and a progress bar; the Results badge
shows "7 of 48". Evidence highlights draw on the page as links arrive. When the
attempt settles, the settled list takes the partial list's place in one render,
in source order (Part B, Ruling 7: two components, no DOM continuity promised).

First-record latency is discovery plus one entry: discovery reads the whole
source before any record is extracted, and this spec does not reorder it.

## 2. What kei publishes during a run

The unified Catalog already publishes `catalog-execution.json`,
`catalog-discovery.json` and `catalog-entry-{n}.v{ENTRY_VERSION}.json` under
`runs/<run>/extractions/<extraction>/`, each write-once by atomic rename, and
reuses them on re-execution (`unified.py`, `read()`). This spec adds:

- `catalog-entry-{n}.candidates.v1.json`, written after the entry's values
  call and before verification: the candidates (`_Found` rows with `kind:
  "candidate"`), the entry's index, ranges and `discovery_sha256`. The name is
  distinct from `entry_name(n)`, and `_entry_reusable` and `read()` never look
  at it, so a retry's resume logic cannot mistake it for a finished entry. It
  is rewritten (rename over) if the values call is retried.
- The finished entry file is unchanged. An entry that fails or stays
  undecided is still not published; its state stays `reading` or `checking`
  in the partial view until the artifact settles it.
- Article (`article.py`) today ignores `run_dir`. It gains the same
  `extraction_id` and directory plumbing and publishes
  `article-context-{k}.v1.json` after each value context's call (the fields it
  answered) and `article-grounding-{b}.v1.json` after each grounding batch
  (the links it made). Both are write-once and ignored by any resume path.

## 3. kei's progress route

`GET /api/runs/{run_id}/extractions/{extraction_id}/progress` (`api.py`):

- 404 `no progress yet` until `catalog-discovery.json` (Catalog) or the first
  `article-context-*` file (Article) exists.
- Reads files only; never a model call, never the DBOS status (Studio reads
  that as today).
- Returns `{ "strategy", "started_at_page", "discovered": n, "finished": n,
  "entries": [ { "index", "label", "page", "stage": "queued" | "candidates" |
  "finished", "candidates": [...] | null, "record": {...} | null,
  "evidence": [...] | null } ], "document": { "contexts": [...], "links":
  [...] } | null }`. An entry's `page` is the page of the passage its first
  range names; `record` and `evidence` for a finished entry are what
  `_artifact` would assemble for that entry alone (`merge` and `_link`), so
  Studio converts them with the same code as the final artifact.
- Served from the same process as the artifact route, with the same `run_dir`
  lookup and the same 404 for an unknown run.

## 4. Order follows the view

- `Options.start_page: int | None` on kei's request (`run.py`), validated as a
  one-based page, excluded from `dumped()` as `pages` was, so the fingerprint
  is unchanged.
- `unified.extract` submits entries to the pool sorted by distance of their
  page from `start_page` (ties in source order); `futures` keeps source order
  for assembly, so the artifact is identical whatever the order of work.
  Without `start_page` the order is source order, as today.
- `article.extract`: when contexts are bounded, value contexts are called in
  the same distance order; the document-level call and the single unbounded
  context are unchanged.
- Studio: the run request body gains `startPage` (optional, one-based); the
  workspace sends the page pdf.js reports as current when Run is clicked.
  `AdmittedExtraction.startPage` is stored on the Extraction row (a new
  nullable column `startPage`, one migration; it is not part of the admission
  identity, so the same whole-document Extraction is the same whatever page the
  researcher was reading) and `keiExtractRequest` adds `start_page` inside the
  `submitToKei` step body. A `loadAdmitted` checkpoint written before the
  column exists reads `null`.
- Batch Extractions send no start page.

## 5. Studio reads partial results

- `read()` in `api/extractions.ts`: when `executionStatus` is `RUNNING`, call
  `keiExpClient.readExtractionProgress(runId, keiExtractionId)` with the run
  from `keiRunOf(preprocessId)` and the extraction id from
  `keiExtractWorkflowId(extractionId)`, under a two-second timeout. The
  response gains `partial: PartialResult | null`; a 404, a timeout or an error
  yields `null` and never fails the read.
- `PartialResult` (`shared/extraction.contract.ts`): `{ startedAtPage,
  discovered, finished, records: [{ index, label, page, state, values: Record<
  pathKey, { value, state } >, evidenceLinks }], document }`. Candidates arrive
  with `state: "checking"`, finished entries with `"grounded"` per link and
  `"empty"` otherwise. A `partialFromProgress` function in
  `packages/extraction/src/kei-artifact.ts` does the conversion with the
  artifact reader's own link and value code.
- `useExtraction.ts`: `extractionStateFromAttempt` returns `{ status:
  'running', step: 'extraction', partial }`; the monitor stores the latest
  partial; a partial never regresses (an entry once `finished` stays so until
  the settled result replaces it).
- `ResultsTab.tsx` renders `partial.records` through the record and value
  components of the redesign spec; `useEvidenceOverlays.ts` accepts partial
  links; the Results badge and the run button read `finished` and
  `discovered`.

## 6. Later, not in this spec

- Live re-prioritisation while the researcher scrolls: a
  `PATCH /extractions/{id}/focus` writing the page kei reads between entries
  through the existing `before_entry` hook.
- An automatic "extract as I read" mode per project.
- Progress for Batch Extractions.

## Error handling

- kei's progress route and the stage files are best effort for the view
  only: a missing or unreadable stage file is skipped; the artifact is
  unaffected.
- A candidates file left by a cancelled or failed run is removed with the
  extraction directory by the existing garbage collection; it is never read by
  a retry.
- Studio's read path degrades to today's behaviour whenever kei is slow or
  unreachable: `partial: null`, status unchanged.
- The settled result always wins over a partial, including when a partial
  showed more records than the artifact kept (an entry refused at the end).

## Testing

- Parsing Service: unit tests for the candidates stage file (written after the
  values call, ignored by `read()` on a retry), the Article stage files, the
  progress route's 404 and shape against a fixture directory, the entry order
  under `start_page` and the unchanged artifact, and `dumped()` excluding
  `start_page`.
- `packages/extraction`: `keiExtractRequest` carries `start_page` from the
  admitted row; `partialFromProgress` maps a fixture to the contract; the
  workflow sequence test is unchanged.
- Studio API: `read()` returns `partial` while RUNNING and `null` on a 404,
  a timeout and after settlement.
- Client: `extractionStateFromAttempt` with a partial; `ResultsTab` renders
  records in read order with the six states; the badge and run button follow
  the counts; no regression of a finished record.
- Browser: with the kei stand-in delaying entries, Run shows the first record
  of the current page before the attempt settles.

## Files

New: `prototypes/parsing_service/src/kei_exp/kie/extract/progress.py` (stage
file names and the progress reader), the progress route in `api.py`, one
migration under `packages/db/migrations/app/` named `start_page` with its
timestamp prefix like its neighbours, `packages/extraction/src/partial-result.ts`,
and the tests beside each.

Edited, Parsing Service: `kie/extract/unified.py`, `kie/extract/article.py`,
`kie/extract/run.py`, `workflows/extract.py` (passes the directory and
extraction id to Article).

Edited, `packages/extraction/src`: `types.ts`, `workflows.ts`,
`kei-handoff.ts`, `kei-artifact.ts`, `postgres-admission.ts`,
`postgres-attempts.ts`, and `kei-exp.ts` (the kei read client) for
`readExtractionProgress`.

Edited, Studio: `api/extractions.ts`, `api/_extractions.ts`,
`shared/extraction.contract.ts`, `src/useExtraction.ts`, `src/extraction.ts`,
`src/ResultsTab.tsx`, `src/useEvidenceOverlays.ts`, `src/App.tsx`.

## Out of scope

- Token-level streaming through kei: a half-parsed JSON reply is not a field,
  and showing unverified text as a value breaks the evidence contract.
- Server-sent events or websockets from Studio.
- Reordering discovery itself.
