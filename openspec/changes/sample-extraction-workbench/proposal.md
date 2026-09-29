# Sample extraction workbench

Status: proposal, 2026-09-29, based on `dev` at `80686ec4`. UX direction:
prototype B ("the schema is the workbench") of the
[Sample extraction loop canvas](https://claude.ai/artifact/5wbU715Zww6bvrEkB2cLgk).
Reviewed before writing by Codex `gpt-6-astra` (read-only); its findings were
checked against the code and are folded into [design.md](design.md), with two
stated departures (a JSON snapshot column instead of a table, §6; Studio's
existing flush-before-run/edit instead of a separate draft context, §4).

## Why

On a long Source Document a Humanities Researcher only learns whether an
Extraction Schema works after a full Extraction: every wrong field description
costs a whole-document run and a whole-document review. Researchers need to try
the schema on a few pages, review what comes back where they edit the schema,
fix it and try again, then run the whole document without reviewing the sampled
values a second time.

## What Changes

- A single Extraction MAY be admitted with a **page scope**: the viewed page,
  its neighbours or pages picked on a thumbnail strip. The Parsing Service
  extracts only records on those pages (`options.pages`); an unscoped request is
  unchanged, fingerprints included. Scope is part of admission identity and
  replay, never of the Extraction Method (ADR 0015).
- Scoped Extractions are **Sample Extractions**. They never become a document's
  latest attempt, latest reviewed result or project summary, and `complete`
  means complete for their pages. Batch Extraction stays whole-document.
- The Schema tab becomes the **workbench**: under each field's name, type and
  description it shows that field's sample values with Evidence, lets the
  researcher mark each right or correct it in place, and shows which Schema
  Revision and pages produced them. Provenance works both ways between a value
  and its passage in the PDF.
- A correction may cite a passage the researcher picks on the page when its
  value is not where the model's Evidence points or the model gave none.
- Re-running a sample compares each value with what the researcher reviewed:
  fixed, as reviewed, changed, type changed, new field, or unmatched record.
- Reviewed sample decisions **carry** into later sample runs and into the full
  Extraction's review when the record aligns and the field, value and Evidence
  agree; everything else stays to review.
- "Suggest a description from N corrections" sends the field's corrections and
  their Evidence to the Interaction Route's existing schema-edit proposal flow.
- Schema chat's spec is corrected to what the code already does: it proposes
  descriptions and allowed values as well as names and types.

## Capabilities

### New Capabilities

- `sample-extraction`: page-scoped admission and execution, scope echo and
  replay, isolation from latest/summary views, scope-relative completeness.
- `schema-sample-workbench`: sample values, review and two-way provenance inside
  the Schema tab; run/revision labelling; re-run comparison statuses; handling
  of renamed, retyped, added and removed fields.
- `review-transfer`: record alignment, decision matching, the immutable transfer
  snapshot pinned at admission, and seeding of the destination review.

### Modified Capabilities

- `canonical-evidence-lifecycle`: a Review Decision may carry researcher-picked
  Evidence for a corrected or model-ungrounded value, and a review may start
  from carried decisions without becoming authoritative before the researcher
  completes it.
- `schema-chat-edit`: an edit request may carry a correction context; chat may
  propose descriptions and allowed values.

## Impact

Parsing Service: `kie/extract/run.py` options and fingerprints, recipe Catalog
entry selection (`grounded.py`), contract fixtures. Extraction package: kei
handoff/artifact acceptance, admission and replay, attempts/summary queries,
review rules. Database: nullable page scope and transfer snapshot on
`Extraction`; correction Evidence on `ReviewDecision`. Studio: viewer page state
and thumbnail strip, Schema panel, results review, schema-edit request.
`CONTEXT.md` gains *Sample Extraction* and *Carried Review Decision*.

Non-goals: batch sampling, sampling by entry count, automatic sample choice,
a whole-document Article inventory for a sample, promises that a
passing sample admits the full run (full-context Article still refuses an
oversized source), or carrying decisions across a new Source Representation.
