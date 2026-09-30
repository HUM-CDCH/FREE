# Corrected-schema A0–A3 development comparison, 2026-09-30

**Status: partially completed within limits.** Run `extractbench-v3-corrected-development`
(parent `extractbench-v2-development`, closed and untouched). Frozen tooling `0834a7d1`,
contract `a24b87e7`, both on top of the reported checkpoint `c394bc97`. No
development-supported challenger was found: **the evidence is insufficient**.

**One protocol deviation, affecting accounting only.** The contract said `/tokenize` and
`/models` requests would be journalled separately, but the runner journals completions
only. The server's access log for 18:02:30–19:51:00Z recovers them: **43** `POST
/v1/chat/completions`, 94 `POST /tokenize` and 3 `GET /v1/models`. One of the `/models`
requests was the manual pre-run reachability check. This gives a fourth, independent
completion count. It also shows that no other client ran completions on this engine
during the run.

- Eligible: 9 cases in 9 source groups (36 cells). The 12 registered development groups
  lose 2 to native-text failures. DD1155 is also excluded, because it needs 68 calls per
  arm and the unchanged cell cap is 60. The 8 held-out groups were not read or run.
- Executed: 3 complete four-arm groups (grafton, pepco, mission), all short documents.
- Incomplete: caterpillar has 3/4 arms sealed. A2's first call was truncated and its
  recovery half was refused at the admission cutoff.
- Not run: 5 groups (lancaster, uillinois, viega, mitchell, erie). Mitchell is the only
  case with the 14 unannotated `equipment_adjustments` lists, so the annotation mask was
  never exercised: every scored cell has `unannotated_fields = 0`.

## Budget and ledger

| Item | Value |
| --- | --- |
| Clock start (persisted before the first request) | 18:03:08Z |
| Admission cutoff / hard deadline | 19:48:08Z / 20:03:08Z |
| Runner finished | 19:50:17Z (107.2 min elapsed) |
| SSH tunnel | 18:03:01Z – 19:50:42Z |
| Completion attempts | **43 of 240** (smoke 4 + compare 39); 197 unused, not carried forward |
| Failed / unknown-usage attempts | 0 / 0 |
| Truncated (`length`) attempts | 1 (caterpillar A2) |
| Recovery halves dispatched | 0; 3 refused at the cutoff |
| Replayed calls | 0; the cache was fresh and no checkpoint was reused |
| Tokens | 67,640 input / 49,617 output |
| Mean seconds per call | 149 s (maximum 529 s) |

Reconciliation holds: 43 journal starts = 43 journal finishes = 43 fresh calls in the
cell attempts = 43 calls the runner reported. Time was the binding limit, not calls.
Only chat-completion requests count as attempts. `/tokenize` admission counts and one
`/models` identity check per invocation were auxiliary requests and were not counted.

## Paired results (3 complete groups, identical cases in every arm)

| Arm | Mean group raw F1 | Mean group canonical F1 | Pooled raw / canonical F1 | Records: predicted / matched / missing / spurious (gold 13) | Annotated page grounding | Schema-valid replies | Calls | Input / output tokens |
| --- | ---: | ---: | --- | --- | ---: | --- | ---: | --- |
| A0 base | .495 | .572 | .431 / .509 | 41 / 10 / 3 / 26 | n/a (no evidence) | 9/9 | 9 | 14,383 / 5,055 |
| A1 continuation | .528 | .591 | .495 / .552 | 11 / 5 / 8 / 3 | n/a | 9/9 | 9 | 14,716 / 5,569 |
| A2 quote evidence | .477 | .567 | .420 / .505 | 42 / 10 / 3 / 27 | .644 (of 104) | 9/9 | 9 | 14,716 / 10,967 |
| A3 ID evidence | .475 | .553 | .418 / .496 | 42 / 10 / 3 / 27 | .635 (of 104) | 9/9 | 9 | 14,590 / 9,362 |

The value denominator is 105 annotated gold fields per arm, and none are unannotated.
Strictly correct records were 0 in every arm.

Per-group raw F1 for A0 / A1 / A2 / A3:

| Group | A0 | A1 | A2 | A3 |
| --- | ---: | ---: | ---: | ---: |
| grafton (1 chunk) | .830 | .830 | .769 | .769 |
| pepco (5 chunks) | .297 | .297 | .301 | .297 |
| mission (3 chunks) | .359 | .458 | .359 | .359 |

The paired raw-F1 deltas against A0 are:

- A1: +.033 (1 win, 0 losses)
- A2: −.019 (1 win, 1 loss)
- A3: −.020 (0 wins, 1 loss)

With three groups these are descriptions, not inference.

Caterpillar, which is not paired, scored raw F1 0 for A0, 0 for A1 and .361 for A3.
`report.json` is the harness's own `compare_study` output. It pairs each arm with A0 over
every group both arms sealed, so it includes caterpillar for A1 and A3 but not for A2.
That makes the denominators unequal, and its A3 +.076 canonical delta comes entirely from
the caterpillar artifact described below. Do not read that number as an effect.

## Error analysis (complete groups)

1. **The document root is split per chunk, giving spurious records.** This affects every
   arm. Gold has one root: pepco is 1 bill + 1 meter, mission is 1 invoice + 8 line items.
   The predictions return one root per chunk: pepco gives 4–5 roots, and mission gives 3
   roots with 5 + 11 + 12 line items. This produces 26–27 of A0/A2/A3's spurious records.
   Most "wrong" values in the private example list sit on those extra roots, so they are
   copies, not misreadings. Precision falls to about .2–.3 on the multi-chunk documents.
   It is a merge/assignment failure, not a value failure.
2. **A1's gain comes from lost records, not better extraction.** On mission, A1's
   continuation merge collapsed the three roots into one with **zero line items**. The
   scorer then sees fewer wrong values (precision .29→.76) and fewer found values (recall
   .48→.33); 8 of 9 gold records are missing. On pepco the merge did nothing (same 4
   roots). On grafton it cannot act (one chunk), so A1 equals A0 there. The cached A1
   replies were checked: the three chunk replies contained 12 + 5 + 11 line items, but
   the sealed artifact has 0. The merge dropped them; the prompt did not suppress them.
3. **Missing values answered as absent:** 15–16 in A0/A2/A3 and 7 in A1.
4. **Format-only differences:** 6–12 per arm are raw-wrong but canonically right (dates,
   and numbers such as `1415` vs `1415.0`). Some remaining "wrong" values are also
   format-like but not covered by canonicalization, such as a street that differs from
   gold only by a comma.
5. **Substantive wrong values:** 6–7 per arm on scored records, apparently mostly wrong
   field assignment. The examples below come from all wrong outcomes. It was not
   separately verified whether each one sits on the paired root or on an extra root. On pepco, the account and invoice fields take other identifiers printed on
   the bill, `utility_provider` takes the third-party supplier instead of the utility,
   and `previous_balance` takes another amount. On mission, `unit_price` takes extended
   amounts. On grafton, a line-item description drops its leading payee/role prefix (a
   partial value). Every value cited here occurs in the source text after number and
   punctuation normalization: it was copied from the document but put in the wrong field
   or truncated. Exact values and passage IDs are in the ignored `errors-private.json`.
6. **A record-matching cascade (caterpillar, unpaired).** A0/A1 appended "specifications"
   to the product title. With only one other root field shared, the root record did not
   pair (`min_matches = 2`), so all 35 specification rows became unmatched. A3's title was
   exact, so 27 rows matched. One top-level string decides between F1 0 and .36. This is a
   scorer sensitivity, not evidence that A3 extracts specifications better.

Schema validity was 100% in every arm, which shows that it does not measure accuracy.
Evidence was compared only between A2 and A3, under the same alignment. A0 and A1 cite
nothing by design. Two measures are reported separately:

- Passage selection (`page_hit`, the cited page is a gold page): 1.0 / .786 / 1.0 on
  grafton / pepco / mission for both A2 and A3.
- Annotated page joint (correct value on the gold page): .644 for A2 and .635 for A3,
  differing only on grafton (.889 vs .852).

Refined literal localization is unavailable: `raw_span_hit` and `joint` are undefined for
native-line input. A2 used about 17% more output tokens than A3, and both used about
twice A0's. Semantic support and exact localization remain unavailable with native-line
input.

## Decision

The frozen rule (`contract.json` / final-protocol-proposal) required at least 3 complete
groups, a mean paired raw-F1 gain, a majority of wins, canonical strict records ≥ A0 and
region failures ≤ A0. No arm passed: A1 won 1 of 3, and A2 and A3 did not improve.
**The evidence is insufficient**, and A0 remains the reference.

The completeness guard was vacuous. Strict records were 0 in every arm, so "≥ A0" passed
for A1 even though A1 lost 8 of 9 mission records. Only the majority-of-wins clause
rejected A1, and one more favorable group would have let it pass. Next protocol: guard on
matched and missing repeated-record counts. That guard is proposed only and was not
applied here. Production defaults, the
live workflow, mandatory human review and the held-out groups were not changed.

Next hypotheses, proposed and not applied:

- (a) Root fragmentation across chunks is the dominant error, and neither A1 nor
  evidence mode addresses it. A root-singleton merge rule (a fixed document root takes
  one record) is a candidate for a separately frozen run.
- (b) A1's continuation merge drops nested lists on mission. Add a regression case before
  any A1 rerun.
- (c) Root-pairing cascades make record metrics fragile. Report specification rows paired
  independently of the root title as a scorer sensitivity check. Do not change the
  frozen scorer.
- (d) At about 150 s per call and one worker, 120 minutes covers only 3–4 short groups.
  A comparison that reaches medium documents needs more time or approved concurrency.
  Do not add calls.

This does not transfer to FREE. An in-domain decision still needs the human-reviewed
FREE catalogue gold described in the
[methods audit](../../2026-09-30-extraction-harness-methods.md). That audit covers
repeated rows, fixed document roots and page-level evidence. The next step is to
annotate those catalogues and then freeze A0 against at most one challenger on them.

## Reproduce

Run from `prototypes/parsing_service` with
`PYTHONPATH=src:.` and `H=/home/gebbaro/Progetti/FREE/prototypes/parsing_service/.venv/bin/python`.

```bash
R=../../.scratch/extractbench-v3-corrected-development
C=../../docs/research/2026-09-30-extractbench-validation/corrected-comparison
# freeze.py also overwrites $C/contract.json: run it only from a copy of this directory
unshare -rn $H COPY_OF_C/freeze.py ../../.scratch/extractbench-schema-fidelity-2026-09-30/dataset-v2 NEW_ROOT
$H $C/run_paired.py $R --groups 1   # smoke (spent); rerunning resumes the same clock, which is now past its cutoff
$H $C/run_paired.py $R              # compare (spent)
unshare -rn $H $C/analyze.py COPY_OF_R   # offline rescoring; refuses to overwrite existing outputs
$H -m pytest -q $C/test_run_paired.py
```

These commands record what was run and grant no new spending. The persisted clock is past
its cutoff, so `run_paired.py` now refuses to dispatch. Public outputs are in this
directory: `contract.json`, `summary.json` and `report.json`, which hold counts, ids and
field names only. Private outputs stay under the ignored run root: cells, cache, request
journal, `errors-private.json`, and the superseded `analysis-v1/`. That first analysis
pass pooled error categories over unpaired cells; it was replaced so that categories
cover paired groups only, and no scores changed.

## Erratum (2026-09-30, offline repair pass)

The tables above are unchanged. These corrections come from
[the offline assembly repair](../assembly-repair/README.md):

- **The record column omits duplicated records and mixes scopes.** Every partition holds:
  - A0: 41 = 10 matched + **5 duplicated** + 26 spurious.
  - A1: 11 = 5 + 3 + 3.
  - A2 and A3: 42 = 10 + 5 + 27.

  "Gold 13" is 3 document roots plus 10 nested items. Scope-separated counts are in the
  repair report.
- **Mission A1's line items were withheld, not deleted.** `merge._field` treated three
  differing object lists as a scalar conflict. The field became `unresolved` with value
  None, and the 28 items stayed in its `alternatives`.
- **Caterpillar A3 matched 26 specification rows plus the root** (27 records in all), not 27
  rows. The pairing failure in A0 and A1 follows from 2 predicted roots: the fixed-root
  shortcut needs exactly one.
- **The strict-record guard used all-scope strict records.** The frozen rule text says
  "repeated-record count". Both were 0, so the verdict is unaffected and not revised.
- **Reproduction at later commits.** From `e4c9c906` on (evaluator 3), `analyze.py` stops at
  `verify_output` with "evaluation changed". It refuses rather than relabel the run.
  Reproduce with a `git archive` of `2024b85c`. `run_paired.py` also refuses on the harness
  hash; that refusal is intended.
