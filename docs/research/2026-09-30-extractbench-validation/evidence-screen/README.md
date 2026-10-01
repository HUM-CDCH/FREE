# A0 versus A3 passage-ID evidence screen, 2026-10-01

**Status: executed within limits; partially complete.** Run `extractbench-v4-evidence-screen`, a new development-only
run with its own allowance. Contract `420ab5b4` (code `8fede430`, dataset-v3). Prior runs are untouched:
the closed execution `extractbench-v3-corrected-development` (contract `a24b87e7`) and the offline replay
([assembly-repair](../assembly-repair/README.md), `e4c9c906`, `5c62481a`, `9c38ab92`).

Headline:

- 3 complete short pairs (grafton, mission, pepco). Their 18 replies are **byte-identical** to the closed run's
  replies to the same prompts (temperature 0, same server). They reproduce the offline repaired replay; they are
  not new, independent observations.
- **Mitchell (medium, 13 pages, 16 chunks) is the only new observation, and it is incomplete.** A0 sealed with full
  coverage. A3 sealed with 1 of 16 regions failed: 4 replies were truncated at 4,096 tokens and the depth-1 recovery
  could not save one region. So the medium-document question is **not answered** by a complete pair.
- Caterpillar: A0 was stopped at the admission cutoff, and A3 was not run. Lancaster was not run.
- Frozen gate (`screen-gate-v3`) on the 3 complete pairs: **"loss observed"**. Grafton's A3 raw F1 is −0.061, beyond
  the 0.05 tolerance. That tolerance was chosen after grafton's historical −0.061 had been published. It works
  against A3, not for it, but it was not blind.
- Production defaults, the live workflow, mandatory human review and the 8 held-out groups are unchanged.

## 1. Preflight

| Item | Outcome | Evidence |
| --- | --- | --- |
| Dataset scope | **Repaired (new revision).** dataset-v3 was re-prepared with the existing adapter, offline (`unshare -rn`, PDFs symlinked from v2). Delta vs v2: `"record_scope": "document"` added to all 10 inputs. `dataset.json`, `adapter-manifest.json`, all annotations, passages and schemas are byte-identical. `freeze.py` asserts the delta and that each case pin differs from v2 only by scope. | contract `identity.dataset_revision.delta_from_dataset_v2` |
| Why "document" | The adapter's task contract: `inference_schema` admits only an object root, its record description is "One complete document…", and each benchmark row has one `expected_output` object scored as one fixed root. This comes from the contract, not from gold content or predictions. | `extractbench.py` |
| Singular vs collection | **Tested, no change.** A synthetic keyed catalogue stays `records`, the adapter case is `document`, and an unknown scope is refused. Chunk records stay apart under `records` and merge under `document`. | `test_a_collection_task_and_a_document_task_stay_distinguishable`, `test_a_continuation_merge_…` |
| Multiplicity | **Repaired (`46ca8833`).** Object-array items were folded across chunk candidates whenever their canonical values were equal, and equal whole lists from several chunks collapsed to one. Items have no item-level source reference (A3 cites per top-level field), so identity is ambiguous. Every item is now kept and the field is flagged `possible_repeated_items`. Not entity resolution. | `test_identical_looking_rows_are_never_folded_by_value_alone` covers: within one chunk, across chunks, repeated through overlap (kept and flagged), similar but distinct |
| Earlier "0 folded" claim | **Holds.** Re-assembling the 15 sealed cells of the closed run with the new code changed no count or score. | `.scratch/extractbench-evidence-screen-2026-10-01/preflight-replay/` |
| Annotation semantics | **Repaired (evaluator 4, `46ca8833` + `8fede430`).** A duplicate parent's collection now takes the availability of the gold record it duplicates. An extra parent's collection is known only if every gold parent at that place annotates it; otherwise it is unscored as `unknown_availability_records`. Explicit `null`/`[]` count as annotated-empty, missing counts as unannotated. The parent stays duplicated or spurious. Counts are kept per path. | `test_unannotated_and_explicitly_empty_collections_differ_under_matched_duplicate_and_extra_parents` (mixed path), `test_an_unannotated_nested_collection_is_unscored_under_every_parent` (Mitchell shape) |
| Exhaustive rule | Applied as documented for paired parents. An unpaired parent's children still default to exhaustive. Only lancaster has a rule (`line_items: true`), so nothing in this study is affected. | — |
| Completeness gate | **Replaced for this study.** "Missing not higher" and "matched not lower" were the same check; one was dropped. The guard is now per group **and per collection path**, so paths never offset each other. A path with no annotated records is listed as "not established". | `test_screen.py`: the adversarial F1-rises-after-withholding test is kept, plus a gain-in-X-cannot-offset-loss-in-Y test |
| Root shortcut | **Tested, no change.** A structurally paired root with wrong values keeps `wrong_values = 3`, `tp = 0`, `strict = 0`. | `test_a_singular_root_pairs_structurally_but_its_wrong_values_stay_wrong` |
| Sampling | `sampling.n = 1` is asserted. `merge.vote` is untouched. | `freeze.py` |
| Not fixed (out of path) | Under `records` scope, `merge.cluster` still joins two keyless candidates of one reply that repeat every field. This study never uses that path. | — |

Tests: 193 passed (`tests/test_harness_*.py`, `test_screen.py`, `assembly-repair/test_offline.py`). Source diff since `9c38ab92`:
`merge.py` +17/−17, `evaluate.py` +30/−10 (incl. docstrings), tests +80; no dependency added.

## 2. Execution

| Item | Value |
| --- | --- |
| Clock (written before any model-service contact) | start 23:05:21Z, admission cutoff 01:50:21Z (deadline − 900 s timeout), deadline 02:05:21Z |
| Runner finished | 01:57:40Z, **172.3 min** elapsed. Runner under a hard SIGINT kill at the deadline, which was not needed. |
| Completion attempts | **57 of 180** (smoke 2 + main 55). Reserved before dispatch. 123 unused and not carried forward. 1 refused at the cutoff. |
| Failed / unknown-usage / hidden retries | 0 / 0 / none (`retries 0`, no retry adapter) |
| Truncated (`length`) | 5: Mitchell A3 4, Mitchell A0 1 |
| Recovery attempts (subdivision halves, counted) | 6: Mitchell A3 4 (region c4: 2 halves, one cut off again, region failed; c11: 2 halves, recovered), Mitchell A0 2 (c4, recovered); no other cell |
| Auxiliary (journalled separately, not counted) | 118 `POST /tokenize`, 2 `GET /models` |
| Reconciliation | 57 journal starts = 57 finishes = 57 cell fresh calls = 57 runner-reported; 0 replayed. **Reconciled.** |
| Tokens | 93,799 input / 79,865 output |
| Restarts | none; the smoke and main invocations share one clock and one allowance |
| Smoke | grafton pair, 2 attempts, both sealed with full coverage and one root. Included, since nothing changed after it. |
| Infrastructure | existing local Qwen3.8-27B-FP8 (`017b9c7a`), image `8ca4c87c`, vLLM `0.29.1rc1.dev17`, max-model-len 32768, max-num-seqs 4 (unchanged); 1 client worker; SSH tunnel 23:05:14Z – ~02:23Z (idle about 18 min past the deadline; both journals show no request after 01:57:40Z) |

## 3. Results

Layers (`supplementary.json`, descriptive). Every sealed cell had HTTP 57/57 completed. Valid JSON equals
schema-valid in every cell: Mitchell A0 17/18 and A3 16/20, where the invalid replies are exactly the truncated ones;
all short cells are valid. Job completion means full coverage: Mitchell A3 was **not** complete. Record matching and
correctness are below. 0 fully correct (strict) records in any cell except pepco's meter (canonical, both arms).

### Complete pairs (reproductions of the closed run)

| Group (pages/chunks) | Arm | Raw P / R / F1 | Canonical F1 | Unresolved / missed-as-absent | Nested path: gold / pred / matched / dup / spurious | Calls | Out tokens | Seconds |
| --- | --- | --- | --- | --- | --- | ---: | ---: | ---: |
| grafton (1/1) | A0 | .846 / .815 / .830 | .943 | 0 / 1 | line_items 1/1/1/0/0 | 1 | 563 | 73 |
| | A3 | .800 / .741 / .769 | .885 | 0 / 2 | 1/1/1/0/0 | 1 | 1,056 | 136 |
| mission (2/3) | A0 | .493 / .638 / .556 | .707 | 0 / 8 | line_items 8/28/8/0/20 | 3 | 3,210 | 415 |
| | A3 | identical | .707 | 0 / 8 | 8/28/8/0/20 | 3 | 4,880 | 630 |
| pepco (3/5) | A0 | .474 / .450 / .462 | .513 | 10 / 0 | meters 1/4/1/3/0 | 5 | 1,282 | 168 |
| | A3 | .524 / .550 / .537 | .585 | 8 / 0 | 1/4/1/3/0 | 5 | 3,426 | 444 |

- Root scope: exactly 1 predicted root per cell, paired structurally. That is an alignment, not credit.
- Missing records: 0 on every path in every sealed cell (Mitchell included).
- Labelled aggregate over the 3 pairs: mean group raw F1 .616 (A0) vs .621 (A3); canonical .721 vs .726.
- A3 cost: the same 9 calls, output tokens 5,055 → 9,362 (×1.85), seconds 656 → 1,210 (×1.84).
- Pepco's A3 gain is partly abstention moving: 2 fewer unresolved root conflicts became values, raising both
  recall and precision.

### Mitchell (new, incomplete pair; descriptive, not gated)

| | A0 (complete) | A3 (1/16 regions failed) |
| --- | --- | --- |
| Raw P / R / F1 | .532 / .624 / .574 | .644 / .611 / .627 |
| Predicted values / gold | 365 / 311 | 295 / 311 |
| comparable_vehicles: gold / pred / matched / dup / spurious | 14 / 41 / 14 / 9 / 18 | 14 / 27 / 14 / 11 / 2 |
| equipment_adjustments (unannotated in all 14 gold parents) | 28 items unscored | 27 items unscored |
| Wrong values on matched records / spurious where gold absent | 49 / 6 | 54 / 7 |
| Unresolved / missed as absent | 15 / 52 | 12 / 54 |
| Flagged possible repeats | 0 | 2 items |
| Calls / truncated / output tokens / seconds | 18 / 1 / 23,160 / 2,994 | 20 / 4 / 38,614 / 4,985 |

A3's higher precision comes with 70 fewer predicted values and 16 fewer extra vehicle records, and one region was
never read. It cannot be attributed to evidence.

### A3 grounding (top-level scalar leaves; page-annotated gold)

| Group | Pages | Annotated n | Correct with annotated page cited | Not citing every page | Mean cited-page fraction | Verdict (frozen) |
| --- | ---: | ---: | --- | ---: | ---: | --- |
| grafton | 1 | 9 | 8/8 | 0 | 1.0 | uninformative (single page) |
| mission | 2 | 9 | 7/7 (2 wrong values also hit) | 3 | .82 | useful page evidence |
| pepco | 3 | 14 | 6/6 (8 abstained or absent) | 5 | .72 | useful page evidence |
| Mitchell (incomplete) | 13 | 13 | 13/13 | 12 | .15 | useful page evidence |

- Unresolvable ids: 0, which is guaranteed by the enum constraint and therefore says nothing.
- Cited lines that print the value (`checks.literal`, a lower bound): Mitchell 12/13, pepco 6/6, grafton 4/6,
  mission 4/6. The misses include correct citations of formatted numbers (a thousands-separated amount vs its plain integer).
- Collections carry **one citation per top-level field**: Mitchell's `comparable_vehicles` cited 439 ids over 62% of
  its pages. Items get no per-item evidence. The evaluator's all-leaves "annotated page joint" (Mitchell .614) is
  inherited and coarse.
- Semantic support is unmeasured: there are no labels.
- Mitchell's verdict comes from the frozen script applied to an incomplete cell. It is descriptive and was not gated.

## 4. Interpretation

- **Evidence.** On the one medium document, A3 returned specific, correct page references for root scalar fields:
  13/13 correct values hit an annotated page, citing on average 15% of the pages. On 2–3 page documents, page hits
  are close to automatic, because header values repeat on every page and chunk citations are unioned. A3 gives
  **no record-level evidence for collection items**, which are most of the annotated values (Mitchell 275 of 311).
- **Cost.** About 1.7–1.85× output tokens and seconds for the same nominal calls. On Mitchell, 4 vs 1 truncations
  at 4,096 output tokens, and that is what lost a region. Evidence wrappers push dense chunks over the output limit.
- **Quality and completeness.** Short pairs: −0.061 (grafton), 0, +0.075 (pepco) raw F1, with no nested record loss
  on any path. The frozen gate reports "loss observed" (grafton). Mitchell is not comparable as a pair.
- **Uncertainty.** One execution per cell. The short pairs are deterministic reproductions, so they add no
  replication. The only new evidence is one medium document, and its A3 cell is incomplete. **No winner. A0 stays
  the reference; production defaults stay.**

Error analysis (for later work only; nothing was changed during the run):

- Overproduction is the dominant record error: mission has 20 spurious line items in both arms, and Mitchell A0 has
  18 spurious and 9 duplicated vehicles. Preserving candidates exposes it rather than fixing it.
- Root scalar conflicts across chunks stay unresolved: pepco 10 / 8, Mitchell 15 / 12.
- "Missed as absent" is large on Mitchell (52 / 54).
- Truncation with recovery depth 1 is the completeness risk for evidence-bearing output on dense pages.
- Wrong field assignment is a minority among wrong values: values matching another gold field were 5 of 170 (A0)
  and 3 of 104 (A3) on Mitchell, and 2 of 28 on mission. That count is the private example classification.

## 5. Next step (proposed, not executed)

1. **Minimal FREE annotation task.**
   - Pick 2 FREE catalogues: 1 short (≤ 5 pages) and 1 medium (≥ 12 pages, with a table that crosses a page).
   - A reviewer labels every catalogue record (`record_scope: "records"`, declared `entry_no` key) with values,
     explicit absences, and the page plus line ids that state each value.
   - Leave unknown fields unannotated, and mark 3–5 repeated identical-looking rows explicitly.
   - Roughly 2–4 reviewer hours. Keep it out of public reports.
2. **Later validation.**
   - Precondition: either fix `merge.cluster`'s join of keyless candidates that repeat every field (it folds two
     identical rows of one reply) with a test, or freeze `merge.keys: true` with the declared `entry_no`. Otherwise
     the validation would measure that defect on exactly the repeated rows the annotation marks.
   - Freeze A0 vs A3 on those catalogues. Under `records` scope each record carries its own citations, which is what
     this screen could not test.
   - Raise recovery depth or `max_tokens` only as a separately frozen arm.
   - Request a fresh allowance sized from Mitchell's measured 166 (A0) and 249 (A3) s per call.

## Artifacts and reproduction

Public, in this directory:

- `contract.json` (frozen)
- `summary.json` (counts)
- `supplementary.json`
- `study.json`, `freeze.py`, `run.py`, `analyze.py`, `supplementary.py`, `test_screen.py`

Private (ignored) items:

- Run root `.scratch/extractbench-v4-evidence-screen/`: cells, cache, request and auxiliary journals,
  `errors-private.json`, logs, tunnel times.
- dataset-v3 and the diagnostics in `.scratch/extractbench-evidence-screen-2026-10-01/`:
  - `preflight-replay/` (historical replies, diagnostic only)
  - `diagnostic-root/` (a dry run of the frozen scripts on historical replies; not results)
  - `superseded-freeze-1/` (re-frozen before any request, to count unannotated collections per path)
  - `server-verification-pre-freeze.json`

From `prototypes/parsing_service` with `PYTHONPATH=src:.`:

```bash
E=../../docs/research/2026-09-30-extractbench-validation/evidence-screen; R=../../.scratch/extractbench-v4-evidence-screen
unshare -rn $H -m experiments.harness extractbench ../../docs/research/2026-09-30-extractbench-selection.json ../../.scratch/extractbench-source NEW_V3   # pdfs/ pre-linked
unshare -rn $H $E/freeze.py NEW_V3 ../../.scratch/extractbench-schema-fidelity-2026-09-30/dataset-v2 NEW_ROOT   # also rewrites $E/contract.json
timeout --signal=INT 10800 $H $E/run.py $R --groups 1          # smoke (spent)
timeout --signal=INT <deadline-now> $H $E/run.py $R            # main (spent; the clock is past its cutoff, so it refuses)
unshare -rn $H $E/analyze.py COPY_OF_R; unshare -rn $H $E/supplementary.py COPY_OF_R ../../.scratch/extractbench-v3-corrected-development
$H -m pytest -q tests/test_harness_*.py $E/test_screen.py -m 'not live_model'
```

These commands grant no new spending.
