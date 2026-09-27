# 0012: One durable execution layer: DBOS in Studio and in the Parsing Service

Date: 2026-09-26. Status: accepted; M1–M6 implemented locally on
`feat/dbos-m2-m6`, with the Spark cutover and smoke still pending under
[the DBOS plan](../plans/2026-09-24-unified-durable-execution.md). Amends the
job-backend part of [0009](0009-own-parsing-and-extraction-service-in-free.md).

## Context

FREE ran three durable job mechanisms and one long poll. The Parsing Service
queued conversions and extractions in Procrastinate on its own database, with
no cancel route, no idempotency and raw recovery SQL. Studio leased
`ExtractionJob` rows in its web process; a restart reran an extraction from
scratch and orphaned the Parsing Service's work. Batch Schema Suggestions ran
from a pump that HTTP handlers kicked. An upload held a thirty-minute request
open. Schema generation and edit proposals lived in the page, so a reload
lost them.

## Decision

- DBOS is the execution authority in both applications. Studio runs DBOS
  inside its one server process (system schema `dbos`); the Parsing Service's
  worker runs its own DBOS application (schema `kei_dbos`, owned by its own
  restricted role). Both schemas live in database `free`.
- FREE's tables keep outcomes with research meaning. Execution status is
  derived from DBOS on read, never mirrored.
- Row-backed work (Extractions, Batch Extractions, suggestion attempts) is
  enqueued in the same transaction as its rows. Other work starts
  workflow-first under a client-minted or server-minted ID.
- Studio hands conversions and extractions to the Parsing Service by portable
  enqueue on its lanes: a large and a small conversion lane, a two-slot
  extraction lane and a cleanup lane.
- Schema Suggestion and schema edit proposals run as workflows, so a reload
  or a Studio restart finds them again. The document chat, which no page
  had shown since August 2026, was deleted rather than made durable.
- A ten-minute `collectGarbage` schedule removes canonical packages, staged
  sources, Parsing Service runs and both workflow histories by reference,
  retention and quiescence. Cancelled work is cleaned up only after the
  process that ran it has restarted.
- Rejected: a Procrastinate HTTP relay, a stateless Parsing Service,
  Hatchet, Temporal, Absurd, a hand-written scheduler, a separate Studio
  worker service, Redis.

## Consequences

- `parsing_db`, Procrastinate, `ExtractionJob`, `BatchExtractionMember`, the
  lease worker and the suggestion pump are gone; one PostgreSQL server holds
  everything.
- A Studio restart interrupts calls in flight; unfinished steps run again on
  recovery. Exactly-once provider execution is not claimed.
- Cancelled history and runs wait for the next restart of their process;
  there is no fixed deletion deadline.
- A code change that alters a workflow's steps uses `DBOS.patch()`; the
  versions `studio@1` and `kei@1` change only after draining.
- DBOS history holds interactive results for about 24 hours and background
  inputs for about 30 days, and database dumps include it.
