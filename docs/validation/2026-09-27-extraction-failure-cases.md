# Extraction study: source-level case review

Status: partial review during the registered study. These are descriptive checks by
the coding assistant against pinned source text, **not independent human annotations**,
exhaustive error rates or held-out evaluation. The registered methods remain unchanged.

## Katrinesminde: duplicate candidates and omitted shared context

Artifacts: `artifacts/extraction-ablation/20260927-r1/cells/Katrinesminde_SBM1116--bounded--0/`
and the `all_units` / `selected` cells for this source under
`artifacts/extraction-ablation/20260927-r2a-selection/cells/`.
The manifest pins the schema and canonical generation; both R2a results record successful
exact replay of the original bounded control.

### Partial identity remains unresolved after value extraction

The schema requests one record for the excavation site and investigation, combining
results across pages. The first inventory candidate has complete keys
`site_name=Katrinesminde, report_id=SBM1116`, supported by `p1_s0` and `p1_s3`.
The second has only `site_name=Katrinesminde`, with support in the later discussion
(`p16_s4`, `p18_s5`, `p20_s3`, `p20_s4`, `p20_s6`, `p21_s13`). The conservative
rule intentionally does not merge this partial key into the complete identity.

Both extracted records subsequently contain the same complete site/report keys.
Thus the ambiguity protection also leaves an apparent duplicate for this schema.
The current pipeline exposes provisional identities but has no post-extraction
identity reconciliation stage. This is a concrete recall/duplication trade-off,
not evidence that partial-key merging is universally safe.

### Zero lexical score does not mean irrelevant source

The first candidate's value input has two units. The selector keeps unit 0 for
identity support and drops unit 1 (46 passages from `p16_s4` to `p23_s1`). Both
unit scores are exactly zero. The English schema's only retained lexical terms
matching the Danish source are `grave` and `museum`; both occur in both units:

| Unit | grave frequency | museum frequency |
| --- | ---: | ---: |
| 0 | 35 | 7 |
| 1 | 23 | 1 |

The registered inverse-frequency factor is `log((N+1)/(df+1))`. With two units
and `df=2`, both terms get zero weight. The positive-score rule therefore selects
no additional shared-context unit. Language mismatch and this weighting rule
make schema relevance ineffective in this example.

Yet omitted passage `p19_s5` explicitly discusses one high-status woman, six
middle-rank graves, four modest graves including one certain child grave, and six
approximately certain women's graves. `p18_s6` discusses A21 as a certain child
grave. The all-unit first record returns seven grave-count observations; selection
retains only the earlier totals of 11 Roman-period graves and two possible graves.
It also reduces that record's periods, burial forms and notable finds. This is
observable lost source detail, without claiming every all-unit candidate is correct.

The second candidate retains both units and remains unchanged, so some dropped
information survives in an apparent duplicate. A document-wide value union would
hide the first record's omission and the identity problem. Report per-record
observations and candidate identities alongside aggregate metrics.

The conditional pair uses six versus five model calls, 38,078 versus 33,768 input
tokens, and 2,106 versus 1,600 output tokens: one call, 4,310 input tokens and 506
output tokens avoided under fixed recorded replies. These are counterfactual
request costs, not measured fresh runtime savings or an accuracy improvement.

### Interpretation

Do not promote this lexical selector from this evidence. Cross-language retrieval,
different relevance weighting and post-extraction identity reconciliation are
separate future hypotheses requiring separately registered comparisons. Changing
them after inspecting this case would invalidate attribution to the current arm.

## Wang: completed identities diverge from provisional reconciliation

Artifacts: R1 `Wang--bounded--0`, plus R2a `Wang--all_units--0` and
`Wang--selected--0`. Scoring and supplementary observation accounting regenerated
successfully in the `analysis-partial-02.json` / `observations-partial-02.json`
snapshots. The fixed scorer reports 15/49 populated sample fields correct and
54/64 empty sample fields correct; its identity alignment has three matched gold
records and two `duplicate_identity` groups. These are one arm's development
results, not a completed paired comparison against the live reference arm.

The inventory has seven candidates. Candidates 0 and 1 have complete keys for
`Sebastes mentella`, skin, isolated collagen, ASC/PSC. Candidates 5 and 6 repeat
skin/isolated-collagen/ASC or PSC but omit `scientific_name`. Conservative
inventory reconciliation therefore retains them. Subsequent value extraction
supplies `Sebastes mentella` for both, leaving duplicate complete ASC and PSC
identities in the final records. The three remaining candidates describe raw
skin, scale and bone.

The frozen scorer refuses to choose between duplicate matching identities.
Consequently, many scored failures reflect identity ambiguity rather than a
demonstration that each candidate's local measurement is wrong. Its unscored-extra
list is empty here; that alone does not mean there are no duplicate predictions.
The identity-alignment diagnostics must accompany the projected field score.

Selection omits no value unit for any of the seven candidates. Both replay arms
have identical records, 18 calls, 108,927 input tokens and 7,607 output tokens.
This is a valid zero-intervention case and stays in the registered denominator;
it does not estimate the effect of actually removing context. Together with
Katrinesminde, it illustrates why cost changes, context omissions, identity
alignment and field accuracy must be reported separately.
