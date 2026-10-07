# 0014: Server-owned Source Ingestion

Date: 2026-09-27. Status: accepted; supersedes, for uploads, the thirty-minute
upload wait of the DBOS plan
(2026-09-24-unified-durable-execution.md,
*Source ingestion*) and its out-of-scope line on asynchronous ingestion.
Plan: 2026-09-27-server-owned-source-ingestion.md.

## Context

Studio parsed every upload in a DBOS `ingestSource` workflow, but the browser
also kept a queue of its own: it sent one PDF at a time and held each request
open until the parse ended (up to thirty minutes). Files behind it lived only
in browser memory, so a reload, a second tab or a Studio restart made the
in-progress upload disappear until it became a Source Document. The browser
queue was also redundant: kei's conversion lanes already order GPU work, and a
small PDF waited in the browser behind a large one.

## Decision

One queue, the server's.

1. **Admission answers at once.** The upload `POST` answers `202 { workflowId }`
   as soon as `ingestSource` is enqueued, or the running attempt of the same
   content is joined. Content Studio already holds still answers `201` with its
   Source Document. The request no longer waits for the parse.
2. **The listing is the queue.** `GET …/source-ingestions` reads DBOS's own
   records: live attempts, successes of the last fifteen minutes (so a page
   never misses a completion) and failures of the last thirty days that no newer
   attempt of the same content superseded and whose content is not a Source
   Document. Named workflow IDs are answered whatever their age.
3. **Dismissing a failure deletes it.** `DELETE …/source-ingestions/<id>`
   deletes the failed attempts of that content from DBOS history, all or
   nothing under M6's quiescence rule (a stopped attempt only once it was last
   updated before this Studio process booted). There is no new table.
4. **Retrying a failed upload sends the bytes again**; the workflow removes its
   staged file on failure. A send that Studio could not acknowledge keeps its
   file in the tab for Retry.
5. **The browser only sends.** It keeps a file until Studio admits it, then
   until the listing shows (or reports absent) that workflow. The page renders
   the listing and re-reads the Project Context until every listed success is
   in it.

## Consequences

- An admitted upload survives reloads, other tabs, navigation and Studio
  restarts. A file not yet sent does not.
- Every selected PDF reaches `source-inbox` and kei's lanes at once; no quota is
  added.
- An observed Project Context costs at most three `listWorkflows` reads and one
  content lookup per request, every 3 s while work is live and every 30 s
  otherwise.
- Dismissal is the one exception to M6's thirty-day background-history
  retention.
- Reprocessing still waits on its parse, in its own browser region, until it
  moves to the same model.
