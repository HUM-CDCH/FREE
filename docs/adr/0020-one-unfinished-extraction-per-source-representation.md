# 0020: One unfinished Extraction per Source Representation

Date: 2026-10-12. Status: accepted.

## Context

Studio offers Run only when the Extraction a document opens on, the newest on
its current Source Representation, is absent, Completed or Stopped
(`canRun` in `useExtraction.ts`); any other is paused, resumed, retried or
stopped in Results. Admission did not check this. A page that had not seen a
newer Extraction, started in another tab or as a Batch Extraction member,
still offered Run, and admission started a second Extraction beside the
unfinished one.

## Decision

- **A single start waits for the newest Extraction.** Admission finds the
  newest Extraction with a live durable head on the requested, current Source
  Representation: the one the document opens on. While it is neither Completed
  nor Stopped (Queued, Running, Pausing, Paused, Stopping or Failed), admission
  starts nothing and answers 409 `extraction_in_progress`, naming it. Studio
  shows the refusal with "Open it".
- **It is `canRun`'s rule.** The same Extraction and the same two statuses, so
  admission and a current page agree, and admission decides for a stale one.
- **Batch Extraction members count.** A member is its document's Extraction:
  as the newest, it blocks a single start until it is Completed or Stopped.
- **Under the Source Document row lock, after replay resolution and the
  request's own refusals** (method, Record Scope, pins). An identical repeat
  still replays, and of two concurrent starts one is admitted and the other
  refused.

## Consequences

- This is an admission rule, not an invariant. Batch admission is not
  refused, so a member can be admitted beside an unfinished Extraction and
  become the newest. Adopting revised inputs turns a Completed Extraction,
  an older one included, Paused outside the document lock. Both paths stay
  open.
- A Failed newest Extraction blocks new starts until a Retry completes it or
  Stop ends it.
- After the refusal the page keeps the Extraction it knew, so Run stays
  offered until the researcher opens the named one or reloads.
- Rejected: counting interactive Extractions only (Studio's Run counts batch
  members, so the two rules would disagree).
