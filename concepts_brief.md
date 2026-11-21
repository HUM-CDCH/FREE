# Signal-guided review for large Extractions

* **Author:** Gennaro Baratta
* **Date:** 2026-11-13

## Overview

A large Extraction saves thousands of values. A Finalized Review is refused
until every saved value has an approve, edit or reject decision
(`CONTEXT.md:147`, `packages/extraction/src/durable-repository.ts:424`). The
author expects researchers to approve everything without reading it; the batch
grid already offers bulk Approve
(`apps/studio/src/projectContexts/BatchReviewGrid.tsx:204`). The current rule
shows that decisions exist, not that anyone looked.

The concept, as the author confirmed it on 2026-11-13:

1. Three techniques give every value a doubt score.
2. The scores split the values into two piles. The researcher reviews every
   value in the **doubtful** pile and does not look at the **confident** pile.
3. FREE draws a small random check from the confident pile only.
4. If the check finds few errors, the confident pile is accepted and its
   values stay marked as not seen by a researcher. If it finds too many, more
   values move to the doubtful pile and the researcher reviews them.

Reviewing everything by hand stays possible. No real review decisions exist
yet, so the techniques cannot be calibrated on data today. The random check is
what makes the result trustworthy while the techniques are unproven, and it
produces the labelled data that is missing.

### The three techniques

* **Token probability.** How sure the extraction model was when it wrote the
  value. vLLM can return it; FREE does not ask for it today.
* **Entailment score.** A small cross-encoder model judges whether the
  Evidence passage supports "this field of this record has this value".
* **Embedding distance.** How far a value, or its Evidence passage, sits from
  the other values or passages of the same field.

Two hints FREE already saves are used as inputs too, at no cost: the value is
not printed as such in its Evidence, and the value has no Evidence at all.

## Analysis

Seven Goldfish lenses reviewed the concept twice. Each ran as a separate Codex
session (`gpt-6-astra`, high reasoning effort, read-only) with no access to
the brainstorming conversation. All seven completed in both rounds.

Both rounds reviewed an earlier shape of the concept: a random sample per
field decided acceptance, and the three techniques were postponed. The author
then restored the techniques to the centre. **No lens has reviewed the shape
described in the Overview.** The findings below are the ones that still apply
to it.

### What the reviews established

**1. Checking only doubtful values says nothing about the rest.** A claim
about the confident pile needs values drawn at random from that pile. This is
why the random check stays, even though it is small.

**2. The acceptance rule must be fixed before the check starts.** Recomputing
a bound after each decision and stopping when it passes gives the check
several chances to pass and breaks the stated confidence. A plan with zero
errors allowed is also a poor choice: with 59 checks, a pile whose true error
rate is 1% passes only 55% of the time. A workable plan is larger and
tolerates a few errors. As an order of magnitude: about 155 checks with up to
3 errors allowed supports "at most 5% errors, 95% confidence" and passes a
pile at 1% about 93% of the time. The draft must confirm the exact plan for
the real pile size.

**3. A decision is not yet a correctness label.** Approving a Value
Disagreement means choosing a reading (`durable-repository.ts:319`), and an
edit can be a formatting change. The check needs its own record of whether
the original value was wrong: wrong content, wrong record, or Evidence that
does not support it. Fixing a checked value must not erase that it was wrong.

**4. Random draws must be saved and cannot be skipped.** The server picks the
draws and saves them before showing them. A skipped draw stays open. Values
the researcher reviews in the doubtful pile, or approves in bulk, never count
toward the check. The current queue allows postponing
(`apps/studio/src/reviewQueue.ts:33`), so the check needs its own screen.

**5. Acceptance is a new saved record, not an approval.** FREE must not write
an approval for each unseen value. A separate, versioned record stores which
values were in the confident pile, the scores and their versions, the plan,
the draws, the errors found and the result. Finalization refers to it.
Existing finalizations keep their meaning of full review.

**6. Finalization, screens and exports must show the difference.** Exports
today show Approved, Edited, Rejected and To check
(`apps/studio/src/durableExport.ts:29`), and CSV holds only the research table
(`durableExport.ts:56`). A reader must be able to tell a value someone read
from a value accepted without being read. Finalizing a pilot unlocks schema
stabilization (`packages/extraction/src/postgres-persistence.ts:166`); that
check must learn the difference before the first such finalization exists.

**7. The scored unit is one scalar, including attributes of list items.** A
saved value is one top-level field and can be a whole list
(`apps/parsing_service/src/kei_exp/kie/extract/retained.py:141`). Places
inside it are addressed by Evidence link paths and by walking the value, as
Studio's `valueParts` does (`apps/studio/src/durableRailModel.ts:38`).

**8. Corrections replace the whole value.** An edit to a list replaces the
list (`durable-repository.ts:314`), so positions can shift, and one corrected
attribute would count as a review of the whole list. Smallest safe rule: when
a researcher edits an object or a list, that whole value goes to full review.

**9. Token probabilities need a protocol change.** The request does not ask
for them and `Reply` drops them
(`apps/parsing_service/src/kei_exp/kie/extract/llm.py:45`, `:94`, `:170`). A
SQL validator rejects request keys outside an allowlist
(`packages/db/migrations/app/20261101T1702_claude_code_extraction/claude_code.sql:95`),
and a workflow-step change must go behind `DBOS.patch()`. The Codex provider
probably cannot supply them. The default Catalog path runs with verification
off (`unified.py:155`), so there is no verifier call to read a probability
from.

**10. The other two techniques have unmeasured costs.** The cross-encoder
adds a model to deploy; small entailment models are trained mostly on English,
and the documents' languages are not yet stated. Embedding distance needs
enough values per field, flags rare correct values, and misses an error that
repeats many times.

**11. All three techniques share two blind spots.** An OCR misreading copied
faithfully looks confident to all of them, and so does a correct value placed
in the wrong record. Such values land in the confident pile. Only the random
check can find them, and if they are common the check will fail.

**12. The synthetic benchmark can reject a bad technique but cannot prove a
good one.** It has known values and wrong-record cases
(`apps/parsing_service/experiments/synthetic_pdf/README.md:174`), but its own
README says it does not estimate accuracy on research documents
(`README.md:241`). Its runner calls `OpenAIChat` directly, so it can request
token probabilities without touching the durable protocol.

**13. Omissions stay outside any claim.** A check over saved values cannot
find a value, a record or a list item the extraction left out.

### Contradictions and how the concept resolves them

* **Few checks against a trustworthy result.** The techniques do the sorting;
  the random check only audits the pile nobody reads (segmentation).
* **Unproven techniques against shipping them.** A weak technique cannot
  cause a false acceptance. It makes the check fail and sends more values to
  review. The cost of a weak technique is extra work, not wrong data.
* **No labelled data against the need to calibrate.** Every random check is a
  label, saved with the scores of that value. Use of the feature produces the
  data needed to tune it.

### Ideal final result

A researcher reads the values most likely to be wrong and a short random
check. FREE can show, for any finalized review, which values were read, which
were accepted unread, under which scores and which check. As labelled checks
accumulate, the doubtful pile shrinks.

## Goals vs. Non-Goals

* **In-Scope Goals:**
  * A doubt score per scalar from the three techniques and the two existing
    hints, with a recorded reason when a technique is unavailable.
  * A split into a doubtful pile, reviewed in full, and a confident pile.
  * A fixed-plan random check of the confident pile, with saved draws and a
    saved acceptance record.
  * A visible "accepted, not read" state in finalization, review screens and
    exports.
  * Saving every check with its scores, as labelled data.
  * An offline comparison of the three techniques on the synthetic benchmark
    before they are built into the product.
* **Out-of-Scope Non-Goals:**
  * Any claim about omitted values, records or list items.
  * OCR confidence, agreement between repeated extractions, and a trained
    error classifier.
  * A certificate across many documents. The first release covers one
    Extraction, so a collection of many small documents is not helped.
  * Carrying an acceptance over to a new or changed Extraction.
  * Editing single list items with their own review state.

## Alternatives Weighed

* **Techniques only, no random check.** Rejected by author after analysis:
  FREE could only say "the most doubtful values were reviewed" and never
  "the review is sufficient", and a weak technique would go unnoticed.
* **Random sample per field, techniques postponed.** Rejected by author: it
  dropped the three techniques the author asked for. It also needed a sample
  for every field and Evidence class, up to about 2,650 checks for a 15-leaf
  schema in the best case.
* **Recompute the bound after every decision.** Rejected by review: it does
  not give the stated confidence.
* **Zero-error plan of 59 checks.** Rejected by review: a good pile fails too
  often.
* **Verifier-label probability.** Rejected by review: the default Catalog
  path has no verifier call.
* **Save acceptance as an approval on each value.** Rejected by review: it
  hides who decided what and corrupts future labels.
* **OCR confidence as the first technique.** Deferred by author.
* **Trained error classifier.** Deferred by author: no labelled data yet.

## Key Decisions & Staging for Next Steps

Decided by the author:

1. The three techniques sort the values. A small random check of the confident
   pile decides acceptance.
2. One Extraction snapshot per assessment.
3. List item attributes are scored and checked like any other scalar.
4. Values accepted without being read are marked as such everywhere.
5. A value printed inexactly in its Evidence, and a value with no Evidence,
   are told apart; both raise doubt.

Proposed, not yet confirmed by the author:

1. **Combining the scores.** A value is doubtful if any technique flags it. A
   value for which no technique could run is doubtful. Without calibration a
   score has no meaning on its own, so each technique flags a fixed share of
   the values, starting with its most doubtful 20%.
2. **After a failed check.** The share rises and the check is drawn again
   from the new, smaller confident pile. At a set limit the Extraction goes to
   full review.
3. **Check plan.** One fixed plan for the whole confident pile, sized as in
   finding 2. Known limit: one check over all fields can hide a single field
   that is mostly wrong. Drawing the check in proportion to each field's size
   makes this visible but does not remove it.
4. **Edits.** An edit to an object or list sends that whole value to full
   review.
5. **Admission.** Only a completed snapshot from one producing selection, with
   no provisional values. Pilots keep full review.
6. **Exports.** A per-scalar status table in the workbook and status columns
   beside the values in CSV.

Suggested staging:

1. Measure the three techniques on the synthetic benchmark, extended with
   OCR-corruption and wrong-record cases, against random order.
2. Build the plumbing for the techniques that pass: token probabilities
   through the durable protocol, the cross-encoder and the embeddings as
   scoring that runs outside the extraction path.
3. Ship the split, the random check, the acceptance record and the
   finalization and export changes, behind an opt-in.
4. Use the saved checks to tune the shares and, later, to train a combined
   score.
