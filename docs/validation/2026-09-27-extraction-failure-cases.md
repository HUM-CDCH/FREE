# Extraction study: source-level case review

Status: partial review during the registered study. These are descriptive checks by
the coding assistant against pinned source text, **not independent human annotations**,
exhaustive error rates or held-out evaluation. The registered methods remain unchanged.

The defects below describe the frozen R1 implementation. The separately versioned
[structure and grounding fixes](2026-09-27-extraction-structure-fixes.md) implement
typed rendering, structural grouping and the quoted-output repair; their fresh
accuracy comparisons remain pending.

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

### First live grounding pair: more calls without resolving identity ambiguity

The later `Wang--quoted--0` result completes the registered bounded semantic versus
bounded quoted comparison for this one paper. Both arms retain seven records,
three matched gold identities and two duplicate-identity groups. Both score 15/49
populated and 54/64 empty sample fields correct. Gold-page localization also stays
at 15 overlapping and 34 missing links for the 49 reported record fields. These
are development diagnostics for one pair, not a study-wide effect estimate.

The quoted arm uses 162 total calls versus 36: grounding accounts for 144 versus
18 calls. Total reported input tokens rise from 259,837 to 1,017,403, and output
tokens from 13,273 to 29,253. Quoted verification records four unsupported-quote
issues and still reports partial grounding. More verification calls do not resolve
the inventory's duplicate identities.

All 18 upstream request captures are identical between arms, and the reconciled
inventory is identical. Nevertheless, regenerated value replies differ: all seven
records differ in `field_statuses`, and one record each differs in `notes`,
`amino_acid_data` and `thermal_data`. Supplementary accounting correctly marks
upstream comparability false. The small link-rate change (55.22% to 55.64%) has
different candidate denominators, 268 versus 275 populated leaves, and must not
be presented as a pure grounding improvement. Greedy decoding did not provide
identical upstream responses in these separate live executions.

Evidence: R1 `analysis-partial-07.json`, `accounting-partial-07.json` and the
paired cells' request/reply captures. A bootstrap interval from this sole paired
paper has no useful between-document uncertainty information; defer aggregate
interpretation until the registered comparison is complete.

## Mizuta: selection retains every unit

R1 `Mizuta--bounded--0` finishes with 12 records, 54 calls, no failed calls and
partial grounding. The frozen scorer matches six gold records and reports 39/66
populated sample fields and 72/72 empty fields correct. Six additional records
remain unscored, and 23 record-value conflicts are retained for inspection.
The matched schema control is pending; other completed methods change additional
factors and cannot isolate the effect of bounded context.

R2a passes exact original-control replay. Both grounding-disabled arms retain
all value units and identical records, using 28 captured calls, 171,373 input
tokens and 11,418 output tokens. Like Wang, this is a zero-intervention result
that stays in the selector comparison denominator. Neither a cost saving nor a
quality improvement occurred in this conditional replay. Evidence: R2a
`analysis-partial-05.json`, `accounting-partial-05.json` and the paired cells.

## Harvey and Hvissinge: cost reduction needs field-level interpretation

R1 `analysis-partial-09.json` / `accounting-partial-09.json` seal 33/79 cells.
Harvey now has a bounded-versus-full-schema pair. Populated correctness is 3/9
versus 7/9, while calls rise from 12 to 63 and input tokens from 286,539 to
505,178. Both return five records. Overlap also scores 3/9, with 61 calls.
These are one paper's pipeline outcomes, not a study-wide effect or proof that
the new structural grouping fixes the loss. A one-document bootstrap interval
does not provide useful between-document uncertainty.

R2a `analysis-partial-07.json` / `accounting-partial-07.json` seal 18/30 cells.
Harvey's conditional selector reduces 28 calls to 23 and input tokens from
185,944 to 173,545. Both arms score 3/9 populated and 8/10 empty gold fields
correct. The 324-to-249 populated-leaf reduction consists entirely of
`field_statuses` entries; every other record field is identical. It must not be
described as 75 lost measurements. Repeated absence explanations from omitted
units inflate the general leaf count, illustrating why it is diagnostic only.

Hvissinge has no gold annotations. Selection reduces nine calls to seven and
input tokens from 69,515 to 54,875. Unlike Harvey, it changes substantive arrays:
`grave_counts`, `burial_forms` and `notable_finds`. The first returned record loses
the eight-person observation and `hocker` / `rygleje`; the eight-person observation
survives in the second record. This compares recorded outputs, without adjudicating
each value's correctness. A document-wide union would obscure some per-record
omissions. The selector stays an experimental factor, not a demonstrated quality
preserving default; historical reply durations are not measured fresh savings.

Akita's overlap cell also finished with 121 calls and 19 records. Its one failed
record call reached the 4096-token output limit (`finish=length`), with 8050 input
tokens inside the 12288 context budget. It is an output truncation, distinct from
the quoted JSON failures below. The arm scores 125/187 populated fields correct
and has eight unscored extras; the matched bounded arm is still pending, so no
overlap effect is claimed for Akita.

## Evidence blocks: preserved storage, weaker model-facing structure

The user's DocTags question prompted a wider audit than the original whole-table
partition checks. `artifacts/extraction-ablation/evidence-block-audit-20260927.json`
records all 16 sources and exact primary-passage ownership for the completed
Article cells. Canonical IDs, labels, table objects and source order survive;
the bounded partitioner does not split a table passage. Native conversion,
the evidence reader and its text renderer are unchanged from repair `6e641b6`.

However, preserving those objects is not the same as showing their structure to
the model. Inventory renders `[passage_id] plain text`; value extraction joins
plain passage text. Neither renderer exposes the block label or structured cell
row/column spans. Grounding does use cell candidates and row/header context.
Thus structure reaches the later verifier more fully than the stages that decide
identities and values. This limitation predates the modular refactor.

Mizuta's `p7_s2` illustrates the loss: its canonical table has 135 cells with
row/column positions, header roles and spans. Plain text shows `Muscular part`
and `Vertebral part` on one header line and six PSC/Major/Minor columns on the
next, without explicit group spans. That makes the grouping less explicit to
inventory and value extraction. This is a representation weakness, not proof
that it caused a particular scored error.

The older FREE-technical DocTags route at `67ea4dc` converted OTSL tables to
Markdown, rendered section headings and captions, and heuristically joined
table continuations across page breaks. It did not simply feed raw DocTags to
the model. Its simplifier was also incomplete: it parsed `ched`, `fcel` and
`ecel`, and inferred some continuation/header behavior. Reusing its structural
idea does not justify treating that parser as lossless.

The new context partitioner groups whole passages by rendered token budget; it
does not keep sections or a table's separate footnotes together as a semantic
group. Caption text in native table HTML is retained, but external qualifiers
can land in another unit. A `Table` label alone also does not guarantee cells:
the pinned Akita OCR result has two such blocks and zero structured table objects.

Follow-up must distinguish **structure-preserving prompt rendering** from
**structure-aware grouping**, retain canonical evidence IDs, and register each
factor before measuring it. Do not describe R1 as a DocTags replication or alter
its frozen inputs mid-study. Current evidence proves preservation of source
objects and reveals underuse of their structure; it does not establish which
rendering or grouping is most accurate.

## Quoted grounding: control characters invalidate entire reply batches

R1 `analysis-partial-08.json` contains 26 sealed cells. A read-only audit of
their saved provider replies finds 33 strict JSON failures: 24 in Akita
`full_quoted`, seven in Zelechowska `quoted`, and two in Zelechowska
`full_quoted`. Every reply has `finish=stop`; none records a provider-format
fallback. These are not output truncations or interrupted requests.

The first rejected characters are literal tabs in all 24 Akita replies and
U+0006, U+0000 or U+000E in the nine Zelechowska replies. For example,
`Akita--full_quoted--0/calls/reasoning-0003.reply.json` contains a literal tab
inside the quote `Pro\t103`, also present in its evidence request. Zelechowska's
`quoted` reasoning-0005 copies U+0006 between `6.4` and `0.13%` from the request.
The provider adapter retains message content, and `parse_json` rejects these
unescaped control characters. The malformed batch loses all of its grounding
decisions, including claims whose individual values did not contain them.

Diagnostic decoding with control characters allowed makes all 33 responses
schema-valid; this does not establish semantic support or authorize replacing
the strict study results. They contain 131 claim decisions across rejected
batches, not 131 unique fields proven correct. Of 37 quote strings containing
control characters, 33 occur verbatim in the corresponding request. Source
matching alone would still not establish correct subject attribution.

Akita `full_quoted` retains 11 matched records, 154/187 populated gold fields
correct, 11 requiring review, and 55/55 empty fields correct. Its 90 calls cost
1,451,207 reported input tokens; 77 are grounding calls and 24 fail parsing.
Processing remains incomplete and only 155/283 populated record leaves have
links. Its second execution attempt reused 46 replies, generated 44 fresh
replies, and records one unknown prior completion. The matched schema control
is still pending, so this is a failure analysis, not a grounding effect estimate.

The quoted prompt also appends an object-output instruction to the semantic
prompt's original label-string instruction. Its response schema requests objects;
that instruction inconsistency is a design defect, although these observed
responses have the requested object shape. Its causal effect has not been
measured. A future revision should use one coherent response instruction and
test escaped source characters without changing canonical text or evidence
offsets. The current registered results retain their original outcomes.

Evidence: `artifacts/extraction-ablation/quoted-json-audit-20260927.json` and
the adjacent `audit-quoted-json-20260927.py`, which pins the 26-cell analysis,
its own source, and each audited request/reply. The audit reads captures only;
it neither repairs artifacts nor makes model calls. The server-side reason for
malformed JSON despite a constrained request remains unestablished. R3 changes
upstream rendering with grounding disabled and therefore does not test this
grounding-protocol issue.

## Sousa: completed process with an incomplete extraction

R1 `Sousa--unverified--0` has a valid sealed result and process exit code zero,
but `completion.processing=false`. Record 3's value call used 7,214 counted
input tokens under a 12,288-token context and returned 4,096 output tokens with
`finish=length`. The pipeline records `call_failed` with "the reply was cut off"
and does not treat that reply as a successful extraction. The recorded call
duration is approximately 539 seconds under shared serving contention.

This is output truncation despite successful input admission, not an infrastructure
interruption requiring resume. Keep the incomplete artifact and its cost in the
registered denominator; do not rerun to replace an unfavorable model outcome.
No comparison yet establishes that disabling grounding caused it: that factor
does not change the upstream value prompt, and these live arms regenerate replies.

## Age: bounded admission succeeds while record semantics fail

R1 `Age--bounded--0` visits five inventory contexts and completes 48 calls without
a call failure, using 381,083 reported input tokens and 8,698 output tokens.
Processing and model grounding are marked complete, while record recall remains
explicitly unmeasured. Full-source inventory was over the served context in
preflight; that admission result does not make the bounded records correct.

The supplied schema requests one record for the source paper itself and explicitly
excludes cited studies and bibliography entries. The bounded output instead has
three distinct `study_title` values:

- The paper title, supported by `p1_s4` (SectionHeader) and its authors at `p1_s5`.
- "It's Complicated - the Relationship Between Age and Disease in Palaeopathology".
  Passage `p8_s6` identifies this as a **2022 symposium theme**, thanking the working
  group that produced the paper; it is not this paper's title.
- "International Journal of Paleopathology 53 (2026) 1-11". This is the text of
  repeated canonical **PageHeader** passages, including `p5_s0` and `p9_s0`, with
  author running text beneath. It is a journal citation, not a study title.

Thus the final records violate the schema's source-paper-only scope. Complete
grounding flags cannot establish correct identity semantics, and correctly labelled
page furniture can still become an inventory candidate. This is a source-backed
case review, not an independently annotated record-precision estimate.

R2a passes exact original-control replay. Its all-unit and selected arms both
disable grounding: 25 versus 17 calls, 170,825 versus 125,673 input tokens, and
4,036 versus 3,454 output tokens. Selection omits eight value units across the
three candidates. The first two records remain identical; the third changes its
research question, methods, findings and limitations. Its erroneous journal-citation
identity remains. These conditional savings do not establish a semantic improvement,
and the 48-call R1 result must not be used as R2a's cost control because it also
includes verification.

## Status declarations enter the grounding denominator

The approved collagen schema represents absence/ambiguity declarations as the
ordinary record array `field_statuses`, containing a relative field path, status
and reason. Generic grounding therefore visits those strings too. A declaration
such as `not_reported` is not a measured source value, and a missing quote for it
does not establish a false scientific observation. A link to its reason also
does not independently prove absence throughout the document.

The read-only `accounting-fields-01.json` report, derived from R1's sealed
`analysis-partial-09.json` snapshot, makes this denominator visible:

| Cell | All populated leaves | Status leaves | Linked status leaves | Grounding calls |
| --- | ---: | ---: | ---: | ---: |
| Harvey bounded | 324 | 156 | 3 | 35 |
| Wang quoted | 275 | 123 | 5 | 144 |
| Akita full quoted | 283 | 6 | 3 | 77 |
| Mizuta bounded | 374 | 69 | 3 | 26 |

Quoted verification starts with at most four claims per batch and may split
again for admission; every request includes its required source and record
context. Status fields contribute claims, but these leaf counts cannot assign
shared input cost to them or predict savings from excluding them. Akita has only
six status leaves yet spends 1,243,740 input tokens on grounding. Status metadata
alone does not explain the long runs.

Supplementary accounting now exposes populated and linked counts for every
top-level field without interpreting field names. All 33 R1 and 18 R2a snapshot
totals reconcile exactly with the registered aggregate diagnostic; all earlier
accounting fields remain identical. Eight focused tests cover the counting rules.
This is descriptive reporting added after observing outcomes, not a revised
primary metric, extraction policy, or estimate of semantic grounding accuracy.
An explicit schema policy for derived diagnostic fields would be a separate
design change; do not hardcode collagen field names into the generic verifier.
