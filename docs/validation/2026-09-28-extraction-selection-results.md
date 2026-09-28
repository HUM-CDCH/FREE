<!-- Generated from the sealed R2a cohort; the main execution report explains interpretation and paired output changes. -->

This is the complete **conditional fixed-reply selection comparison**, with
grounding disabled in both arms. Budgets count included captured requests;
recorded durations are historical. The [main execution report](2026-09-27-extraction-ablation.md#selection-replay-complete-registered-cohort)
records the full-cohort interpretation and review queue. All thirty results and
fifteen original controls passed an HTTP-disabled replay with unchanged saved
artifacts and exact used-request receipts (`verification-final-offline.json`).
No new model or tokenizer calls were made during that acceptance check.

# extraction-selection-replay-20260927-r2a — result tables

Snapshot: **30/30 sealed cells**; **0 missing**.

A sealed cell can contain failed calls, refused input or incomplete grounding. This is a development-corpus comparison; gold is non-exhaustive and no held-out accuracy is estimated.

## Registered coverage

| Method | Sealed / registered | Processing incomplete | Processing status unreported |
| --- | --- | --- | --- |
| all_units | 15/15 | 0 | 0 |
| selected | 15/15 | 0 | 0 |

## Scored development cells

Correct/total counts use the frozen gold projection. Populated-field accuracy is a lower bound: unresolved review items stay in its denominator. Empty-field correctness is shown separately. Unscored extra records are not assumed false positives.

| Cell | Populated correct/total | Needs review | Empty correct/total | Gold identities matched/total | Duplicate identity groups | Unscored extra records |
| --- | --- | --- | --- | --- | --- | --- |
| Akita--all_units--0 | 125/187 | 10 | 41/55 | 11/11 | 0 | 9 |
| Akita--selected--0 | 125/187 | 10 | 41/55 | 11/11 | 0 | 9 |
| Harvey--all_units--0 | 3/9 | 0 | 8/10 | 1/1 | 0 | 4 |
| Harvey--selected--0 | 3/9 | 0 | 8/10 | 1/1 | 0 | 4 |
| Mizuta--all_units--0 | 39/66 | 0 | 72/72 | 6/6 | 0 | 6 |
| Mizuta--selected--0 | 39/66 | 0 | 72/72 | 6/6 | 0 | 6 |
| Sousa--all_units--0 | 27/52 | 1 | 8/38 | 2/4 | 0 | 2 |
| Sousa--selected--0 | 27/52 | 1 | 8/38 | 2/4 | 0 | 2 |
| Wang--all_units--0 | 15/49 | 0 | 54/64 | 3/5 | 2 | 0 |
| Wang--selected--0 | 15/49 | 0 | 54/64 | 3/5 | 2 | 0 |
| Zelechowska--all_units--0 | 10/11 | 1 | 8/8 | 1/1 | 0 | 1 |
| Zelechowska--selected--0 | 10/11 | 1 | 8/8 | 1/1 | 0 | 1 |

## Exact representation and document metadata

Populated fields only; normalized sample scores are above. Exact projected matches retain the frozen alignment/projection gates but distinguish case, whitespace, list order, JSON types and integer/float distinctions. This is a supplementary representation diagnostic, not source-span correctness. Repeated document metadata receives credit only when every eligible sample row passes; pending semantics receive no exact credit.

| Cell | Sample exact/total | Document normalized/total | Document exact/total |
| --- | --- | --- | --- |
| Akita--all_units--0 | 125/187 | 1/4 | 1/4 |
| Akita--selected--0 | 125/187 | 1/4 | 1/4 |
| Harvey--all_units--0 | 3/9 | 2/4 | 2/4 |
| Harvey--selected--0 | 3/9 | 2/4 | 2/4 |
| Mizuta--all_units--0 | 34/66 | 3/4 | 3/4 |
| Mizuta--selected--0 | 34/66 | 3/4 | 3/4 |
| Sousa--all_units--0 | 21/52 | 0/4 | 0/4 |
| Sousa--selected--0 | 21/52 | 0/4 | 0/4 |
| Wang--all_units--0 | 15/49 | 0/4 | 0/4 |
| Wang--selected--0 | 15/49 | 0/4 | 0/4 |
| Zelechowska--all_units--0 | 10/11 | 4/4 | 4/4 |
| Zelechowska--selected--0 | 10/11 | 4/4 | 4/4 |

## Paired effects

Effects are treatment minus control. Accuracy uses annotated document pairs; call/token effects use all available registered document pairs. These denominators can differ. Intervals resample documents and are descriptive with this small corpus; a zero-width interval does not establish equivalence. No interval is displayed with fewer than two documents.

| Comparison | Factor | Gold pairs / expected | Accuracy Δ pp | 95% interval pp | All pairs / expected | Mean calls Δ | Mean input tokens Δ |
| --- | --- | --- | --- | --- | --- | --- | --- |
| all_units → selected | article.selection | 6/6 | +0.00 | [+0.00, +0.00] | 15/15 | -2.13 | -8,623 |

## Cell diagnostics and costs

Linked/populated leaves measure source-link coverage, not semantic correctness. The denominator includes status/diagnostic fields requested by the schema. Inspect per-field accounting before interpreting a change as lost measurements. Call totals are artifact call records, including pre-inference refusals.

| Cell | Records | Linked/populated | Calls | Failed calls | Input tokens | Output tokens |
| --- | --- | --- | --- | --- | --- | --- |
| Akita--all_units--0 | 20 | 0/940 | 66 | 0 | 408,874 | 34,719 |
| Akita--selected--0 | 20 | 0/830 | 57 | 0 | 386,658 | 31,559 |
| Harvey--all_units--0 | 5 | 0/324 | 28 | 0 | 185,944 | 11,675 |
| Harvey--selected--0 | 5 | 0/249 | 23 | 0 | 173,545 | 9,523 |
| Mizuta--all_units--0 | 12 | 0/374 | 28 | 0 | 171,373 | 11,418 |
| Mizuta--selected--0 | 12 | 0/374 | 28 | 0 | 171,373 | 11,418 |
| Sousa--all_units--0 | 4 | 0/144 | 14 | 0 | 93,916 | 4,363 |
| Sousa--selected--0 | 4 | 0/144 | 14 | 0 | 93,916 | 4,363 |
| Wang--all_units--0 | 7 | 0/268 | 18 | 0 | 108,927 | 7,607 |
| Wang--selected--0 | 7 | 0/268 | 18 | 0 | 108,927 | 7,607 |
| Zelechowska--all_units--0 | 2 | 0/78 | 8 | 0 | 43,696 | 2,440 |
| Zelechowska--selected--0 | 2 | 0/78 | 8 | 0 | 43,696 | 2,440 |
| 1790-06-17-1--all_units--0 | 13 | 0/61 | 14 | 0 | 9,964 | 2,056 |
| 1790-06-17-1--selected--0 | 13 | 0/61 | 14 | 0 | 9,964 | 2,056 |
| Age--all_units--0 | 3 | 0/94 | 25 | 0 | 170,825 | 4,036 |
| Age--selected--0 | 3 | 0/85 | 17 | 0 | 125,673 | 3,454 |
| Zhang--all_units--0 | 4 | 0/195 | 18 | 0 | 114,393 | 6,636 |
| Zhang--selected--0 | 4 | 0/195 | 16 | 0 | 106,011 | 6,242 |
| Hamburg--all_units--0 | 3 | 0/115 | 20 | 0 | 125,171 | 5,143 |
| Hamburg--selected--0 | 3 | 0/84 | 16 | 0 | 108,202 | 3,772 |
| Brondbylund_3_TAK_1506--all_units--0 | 1 | 0/32 | 2 | 0 | 8,185 | 533 |
| Brondbylund_3_TAK_1506--selected--0 | 1 | 0/32 | 2 | 0 | 8,185 | 533 |
| Herredsvejen_SBM1694--all_units--0 | 2 | 0/87 | 6 | 0 | 41,371 | 1,777 |
| Herredsvejen_SBM1694--selected--0 | 2 | 0/67 | 5 | 0 | 36,090 | 1,430 |
| Hojbakkegaard_TAK_1177--all_units--0 | 1 | 0/37 | 4 | 0 | 24,216 | 876 |
| Hojbakkegaard_TAK_1177--selected--0 | 1 | 0/37 | 4 | 0 | 24,216 | 876 |
| Hvissinge_Ost_TAK_1728--all_units--0 | 2 | 0/95 | 9 | 0 | 69,515 | 1,931 |
| Hvissinge_Ost_TAK_1728--selected--0 | 2 | 0/75 | 7 | 0 | 54,875 | 1,557 |
| Katrinesminde_SBM1116--all_units--0 | 2 | 0/115 | 6 | 0 | 38,078 | 2,106 |
| Katrinesminde_SBM1116--selected--0 | 2 | 0/81 | 5 | 0 | 33,768 | 1,600 |

## Recorded stage totals

Saved fresh/reused response counts: 0/500.

Totals cover this snapshot across methods. Recorded durations include shared-provider contention and historical durations of reused replies; they are not fresh replay latency or DBOS/HTTP end-to-end time. Unknown token counts are listed rather than treated as measured zeroes.

| Stage | Calls | Failed | Input tokens | Output tokens | Unknown input/output calls | Recorded seconds |
| --- | --- | --- | --- | --- | --- | --- |
| document | 56 | 0 | 308,608 | 3,668 | 0/0 | 821.4 |
| inventory | 78 | 0 | 522,808 | 23,086 | 0/0 | 4,289.6 |
| record | 366 | 0 | 2,268,131 | 158,992 | 0/0 | 25,758.6 |

## Issue ledger

| Cell | Issue counts |
| --- | --- |
| Akita--all_units--0 | conflicting_document_values: 3; conflicting_values: 20 |
| Akita--selected--0 | conflicting_document_values: 3; conflicting_values: 16 |
| Harvey--all_units--0 | conflicting_document_values: 2; conflicting_values: 5; duplicate_inventory_record: 7 |
| Harvey--selected--0 | conflicting_document_values: 2; conflicting_values: 5; duplicate_inventory_record: 7 |
| Mizuta--all_units--0 | conflicting_document_values: 1; conflicting_values: 23 |
| Mizuta--selected--0 | conflicting_document_values: 1; conflicting_values: 23 |
| Sousa--all_units--0 | conflicting_document_values: 2; conflicting_values: 4 |
| Sousa--selected--0 | conflicting_document_values: 2; conflicting_values: 4 |
| Wang--all_units--0 | conflicting_document_values: 1; conflicting_values: 5; partial_identity: 4 |
| Wang--selected--0 | conflicting_document_values: 1; conflicting_values: 5; partial_identity: 4 |
| Zelechowska--all_units--0 | conflicting_values: 2; duplicate_inventory_record: 2 |
| Zelechowska--selected--0 | conflicting_values: 2; duplicate_inventory_record: 2 |
| 1790-06-17-1--all_units--0 | partial_identity: 1 |
| 1790-06-17-1--selected--0 | partial_identity: 1 |
| Age--all_units--0 | conflicting_values: 3 |
| Age--selected--0 | conflicting_values: 2 |
| Zhang--all_units--0 | conflicting_document_values: 1; conflicting_values: 4; partial_identity: 8 |
| Zhang--selected--0 | conflicting_document_values: 1; conflicting_values: 4; partial_identity: 8 |
| Hamburg--all_units--0 | conflicting_document_values: 1; conflicting_values: 3 |
| Hamburg--selected--0 | conflicting_document_values: 1; conflicting_values: 3 |
| Katrinesminde_SBM1116--all_units--0 | partial_identity: 2 |
| Katrinesminde_SBM1116--selected--0 | partial_identity: 2 |

## Missing cells

| Cell | Last recorded status |
| --- | --- |

## Interpretation boundaries

- Development corpus, no independently annotated held-out test set.
- Human gold is not exhaustive; extra predictions are unscored, never assumed false positives.
- Intervals resample documents; small-sample descriptive uncertainty, not proof of generalization.
- Greedy decoding; repeats would measure serving variability, not independent document samples.
- Conditional one-factor effects; combined changes are not attributed to a single technique.
- Exact projected match is a supplementary representation diagnostic, not the primary normalized score or a source-span metric. It retains frozen alignment/projection failures and distinguishes case, whitespace, list order, JSON types and integer/float distinctions. Pending semantics receive no exact credit.
- Direct model calls: no DBOS queue, authenticated HTTP, or deployment latency measurement.
- Unannotated PDFs have operational metrics only; no fabricated accuracy or block F1.

Interaction estimates, observation-level review queues, localization diagnostics and grounding comparability remain in the pinned analysis/accounting JSON. These tables do not replace adjudication.

## Reproduction pins

| Input | Path | SHA-256 |
| --- | --- | --- |
| manifest | /home/gennaro/projects/FREE/artifacts/extraction-ablation/20260927-r2a-selection/manifest.json | 519e3db05bfdb1091ff1bf660d7015d2adb3bd03f0b7d9a52a24cd789c60e54d |
| analysis | /home/gennaro/projects/FREE/artifacts/extraction-ablation/20260927-r2a-selection/analysis-final.json | 23f591d3c43d16ed2d5a3f773dcb02619f3c43d6ecbf15ff244ce26b9b89ef26 |
| accounting | /home/gennaro/projects/FREE/artifacts/extraction-ablation/20260927-r2a-selection/accounting-final.json | f2da5256ffc756e6880d0a66beb7e1e08377a7204fa57e74f39eb878e0bc0a46 |

Renderer SHA-256: `1f74752a1035bc88ab476937345cc9c3b38c6c671080ea4ce8a3caa94c09213e`.
