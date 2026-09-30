# Offline assembly repair and re-scoring, 2026-09-30

**Offline replay and re-scoring only.** These results come from the saved responses of
`extractbench-v3-corrected-development`: contract `a24b87e7`, results `e2542d20` and
`2024b85c`, and the run root `.scratch/extractbench-v3-corrected-development/`, which was
not modified. This pass made no model, tokenizer or network request.

- Every replay ran under `unshare -rn`.
- The chat was a network-free stub that raises on any cache miss. It borrows the research
  adapter's class name only because the cache key includes it; a replay through the real
  client was blocked by the session's safety policy.
- The study allowance was zero.
- None of these numbers is a new model observation, cost or timing.
- Production defaults, the live workflow, mandatory human review and the 8 held-out groups
  are unchanged.

Repair commit: `e4c9c906`. Private outputs are in `.scratch/extractbench-v3-offline-repair/`:
`original-tree/` (a `git archive` of `2024b85c`), `replay-original/`, `replay-repaired/`,
`scores/`, `summary.json` and `manifest.json`. `summary.json` and `manifest.json` here are
public copies; they contain counts, ids and hashes only.

## Defects

| Finding | Status | Where | Decisive test |
| --- | --- | --- | --- |
| Mission A1 lost its nested line items | **Confirmed** | `merge._field`: an object array (`item_type None`) fell into the whole-value `_groups` path. Three different chunk lists (5 + 11 + 12) became a 3-way "conflict", so the field was `unresolved` with value None. The 28 items stayed only in `alternatives`: withheld as a false conflict, not deleted. | `test_a_continuation_merge_unions_nested_items_...` |
| A singular root read in chunks becomes one record per chunk | **Confirmed** | `merge.cluster`: with no key and no identical span or exact repeat, the chunk roots stay apart. Nothing declared that the ExtractBench root is one object per document. | `test_a_document_root_read_in_chunks_is_one_record_...` |
| Caterpillar: the parent-title mismatch blocks its nested specs | **Confirmed as the mechanism, but downstream of fragmentation** | `evaluate._match`: `fixed_document_root` pairs only when `pred.count == 1`. A0 and A1 had 2 roots; root 0 shared 1 annotated value, need is 2, so it did not pair and all 38 spec rows were spurious. A3 shared 2, so it paired (26 matched). With one assembled root, all three sealed arms pair and score .442. | trace in this pass; `test_children_are_scored_under_their_own_parent_...` (negative case: shared attributes, swapped children) |
| Record totals mix scopes | **Confirmed (reporting)** | The published record column pooled document roots with nested items ("gold 13" = 3 roots + 10 nested) and left out **duplicated** records. Base 41 = 10 matched + **5 duplicated** + 26 spurious; the 5 are the extra pepco and mission roots. The partitions themselves hold in every cell and at both scopes. | `offline.scopes` asserts both identities per cell |
| The completeness gate is vacuous | **Confirmed** | `analyze._decide` guards on all-scope canonical strict records, which were 0 in every paired arm. The frozen rule text says "repeated-record count"; both were 0, so this did not change the verdict. | `test_f1_that_rises_because_nested_records_were_dropped_is_rejected...` |
| Unannotated collection mask | **Defect found by a new test** (never exercised by the study) | `score_structured`: a paired parent skipped an unannotated collection, but an unpaired or duplicate parent scored the same children as spurious. Mitchell's 14 `equipment_adjustments` lists would have hit this. | `test_an_unannotated_nested_collection_is_unscored_under_every_parent` |

Not reproduced: A1's gain as an extraction effect. It came entirely from the withheld items.

Unresolved:

- `merge.vote` still groups object arrays as whole values across samples. This was not
  exercised (n = 1) and was not changed.
- An exact item repeated in two chunks is folded once. A genuinely repeated identical row
  across a chunk cut would be undercounted. It is flagged (`repeated_items_merged`, 0 times
  in this replay), not hidden.

## Repair (`e4c9c906`)

**`merge._parts` (new, about 25 lines)**, called by `_field` only when candidates disagree on a
nested field:

- Objects fill in child by child. A missing, null, empty-string or empty-list child is
  "not stated" (the documented `typed` rule) and erases nothing.
- Collections keep every item in reading order. An item is folded only when another
  candidate already gave it; repeats inside one reply stay.
- A nested scalar conflict keeps the existing `unresolved` + `alternatives` representation.
- `value` and `raw` are the same list, so the raw-exact scorer stays index-aligned.

**`record_scope`** on `Case`/`InferenceCase`, beside `record_key`:

- `"document"` makes `cluster` and `align_samples` assemble every candidate into the one
  root.
- It is pinned in `case_pin` only when it is not the default, so historical pins are
  unchanged.
- The ExtractBench adapter writes it for future datasets, because `inference_schema`
  admits only object roots.
- For this replay it was set explicitly on all 9 cases. The saved inputs predate the field.

**Evaluator 3:**

- A collection that no gold record annotates is unscored under every parent.
- Its predicted items are counted as `unscored_records`, outside the scored partition.
- Nothing else changed.

**Candidate dispositions (repaired replay, all 15 sealed cells):**

- Every contributed nested item was kept: 0 folded, 0 withheld.
- Every root candidate was merged into its document's one record.
- Scalar disagreements between chunk roots are held as conflicts (pepco: 8–11 fields per
  arm) with every alternative and contributor.

No option was added for the old behaviour; the historical commit and the sealed outputs
preserve it.

## Offline 2×2 comparison

Same saved replies throughout. The original-assembly cells score the sealed artifacts. The
original replay rebuilt all 15 sealed artifacts byte-identically. The repaired replay sent
requests identical to the originals in all 15 cells with 0 fresh calls, so it is a
**complete** offline replay, not a diagnostic one. Caterpillar A2 needs 3 uncached recovery
requests, the ones refused at the run's cutoff. It stays incomplete in both replays and was
not completed.

Cohort: grafton, pepco and mission, all four arms. Mean group raw / canonical F1:

| Assembly / evaluator | A0 base | A1 | A2 | A3 |
| --- | --- | --- | --- | --- |
| original / original (v2) | .495 / .572 | .528 / .591 | .477 / .567 | .475 / .553 |
| original / revised (v3) | identical: 0 counts differ | | | |
| repaired / original (v2) | .616 / .721 | .616 / .721 | .632 / .750 | .621 / .726 |
| repaired / revised (v3) | identical: 0 counts differ | | | |

The original/original row reproduces the published per-group raw F1 exactly. **Attribution:
all changes are assembly; the evaluator revision contributes 0 on this cohort.** The
repaired single root pairs through the pre-existing `fixed_document_root` rule, which is
unchanged.

Per-group raw F1:

| Group | Original A0 / A1 / A2 / A3 | Repaired A0 / A1 / A2 / A3 |
| --- | --- | --- |
| grafton (1 chunk) | .830 / .830 / .769 / .769 | unchanged |
| pepco (5) | .297 / .297 / .301 / .297 | .462 / .462 / .571 / .537 |
| mission (3) | .359 / .458 / .359 / .359 | .556 / .556 / .556 / .556 |

The precision/recall trade-off (A0, raw):

- Pepco: P .20 → .47, R .55 → .45. Conflicting root scalars are now withheld as
  `unresolved` instead of scored as copies.
- Mission: P .29 → .49, R .48 → .64.

Reconciled records, cohort sums. Each scope satisfies predicted = matched + duplicated +
spurious and gold = matched + missing; unscored is 0 everywhere, and no unannotated fields
or collections occur in the cohort.

| Arm | Scope | Original: pred / matched / dup / spurious / missing | Repaired |
| --- | --- | --- | --- |
| A0, A2, A3 | root (gold 3) | 8 / 3 / 5 / 0 / 0 (A2, A3: 9 / 3 / 5 / 1 / 0) | 3 / 3 / 0 / 0 / 0 |
| A0, A2, A3 | nested (gold 10) | 33 / 7 / 0 / 26 / 3 | 33 / 10 / 3 / 20 / 0 |
| A1 | root | 6 / 3 / 3 / 0 / 0 | 3 / 3 / 0 / 0 / 0 |
| A1 | nested | **5 / 2 / 0 / 3 / 8** | 33 / 10 / 3 / 20 / 0 |

- The remaining nested excess (20 spurious, 3 duplicated) is mission's 28 predicted line
  items against 8 gold. That is an extraction error the merger must not hide.
- **A1 is now equivalent to A0.** Under a declared document root the continuation merge
  cannot act. A1's replies gave the same records as A0's on 3 of 4 cases and the same
  scores on all. The former A1 ablation is no longer meaningful.

Caterpillar is reported separately and is not in the ranking (raw F1; nested matched /
spurious):

| | A0 | A1 | A2 | A3 |
| --- | --- | --- | --- | --- |
| original | 0 (0 / 38) | 0 (0 / 38) | unsealed | .361 (26 / 9) |
| repaired | .442 (32 / 6) | .442 (32 / 6) | unsealed | .442 (32 / 3) |

A3's original caterpillar "advantage" disappears once the root is assembled.

Separated layers:

- **HTTP:** 43 completions, 0 failed.
- **Schema-valid replies:** 42 of the 42 inside sealed cells. The 43rd, caterpillar A2, was
  truncated. Parse failures and schema failures are not recorded apart.
- **Complete extraction jobs:** 15 sealed cells of 16 started, all with full coverage.
- **Correct values:** raw tp 311 → 569 and canonical 351 → 626, out of 1,041 annotated gold
  values across the 15 cells.

## Gates

- **Old frozen rule (v1):** "evidence insufficient" under both assemblies. On the original
  artifacts its strict-record guard passed A1 at 0 ≥ 0. Only the majority-of-wins clause
  stopped A1; its verdict is not changed.
- **Proposed rule (`completeness-gate-v2`, future studies only, `offline.gate_v2`):**
  - It keeps the F1 conditions.
  - It adds guards, in **every** paired group and at both scopes:
    - no loss: missing not higher and matched not lower;
    - no excess: duplicated + spurious not higher.
  - A guard with nothing annotated to test returns **"not established"**, never a pass.
  - Strict nested records are supplementary only.
- **Rule v2 on these artifacts:**
  - Original: A1 is **rejected**. Its cohort nested records go 7→2 matched and 3→8
    missing (all on mission, 5→0), even though F1 rose. A2 and A3 are rejected for one extra pepco root.
  - Repaired: all three arms are "evidence insufficient". Best is A2, +.016 mean raw F1 with
    1 win.
- These describe 3 single executions: no stochastic variation was measured.

## Proposed next development experiment (not executed; needs a fresh allowance)

**Reference:** A0 with the repaired assembly.

**One challenger:** A3, ID evidence.

- Why A3: FREE's mandatory human review needs per-value page evidence.
- In the original run, A3 gave the same page grounding as A2 (.635 vs .644) for about 17%
  fewer output tokens.
- Under repaired assembly its accuracy cost is +.005 mean raw F1, unresolved.
- A1 is dropped (equivalent to A0). A2 is dropped (the costlier twin).

**Cases**, chosen for structure, not length:

| Case | Chunks | Structure covered |
| --- | ---: | --- |
| grafton | 1 | smoke, run first |
| mission | 3 | nested line items across cuts |
| pepco | 5 | root scalar conflicts |
| caterpillar | 2 | long nested list, truncation |
| lancaster | 3 | unrun line items |
| mitchell (medium) | 16 | exercises the unannotated-collection mask |

Mitchell should run second, right after the grafton smoke, so the medium document is not
starved again.

**Cost, from the recorded run (43 calls; 1,573 input and 1,154 output tokens per call on
average; 149 s per call with 1 worker):**

- Nominal calls: 2 × 30 = 60; with recovery, up to 180.
- About 94k input and 69–83k output tokens.
- About 2.5–2.7 h wall time with 1 worker.
- Medium-document output density is unmeasured, so these are lower-confidence than the
  short-document means.

**Blockers:**

- A 120-minute window with 1 worker cannot finish this. It needs about 180 minutes, or
  separately approved concurrency.
- Erie (36 chunks, about 72 calls, about 3 h) does not fit either.
- DD1155 (long) needs 68 calls per arm, above the unchanged 60-call cell cap.

**FREE:** these results do not transfer. The in-domain decision still needs human-reviewed
FREE catalogue gold for repeated rows, fixed document roots and page evidence. FREE
catalogue schemas are record collections (`record_scope: "records"` with a declared key),
not document roots.

## Reproduce

Run from `prototypes/parsing_service` of the named tree, with `PYTHONPATH=src:.` and
`unshare -rn`. `D` is this directory, `P` is `$D/offline.py`, `R` is the original run root
and `O` is a new output directory. Every step refuses to overwrite.

```bash
git archive 2024b85c prototypes/parsing_service | tar -x -C $O/original-tree
# in $O/original-tree/prototypes/parsing_service (original assembly/evaluator):
python $P replay $R $O/replay-original records
python $P score $R sealed $O/scores/original-assembly--original-evaluator.json
python $P score $R $O/replay-repaired $O/scores/repaired-assembly--original-evaluator.json   # after the repaired replay
# in this worktree's prototypes/parsing_service (e4c9c906):
python $P replay $R $O/replay-repaired document
python $P score $R sealed $O/scores/original-assembly--revised-evaluator.json
python $P score $R $O/replay-repaired $O/scores/repaired-assembly--revised-evaluator.json
python $P summarize $R $O
python -m pytest -q tests/test_harness_v2.py $D/test_offline.py
```
