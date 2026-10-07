# Fixed-upstream grounding comparison — R5 protocol, 2026-09-28

This protocol governs registration of a separate grounding study. The concrete
manifest, source archive and result receipts establish its actual execution state.
It does not change or replace frozen R1/R2a/R3/R4. Tasks and completion gates are
tracked in the extraction-span-grounding change.

## Question and corpus

Does span selection plus selective verification reduce grounding work while
retaining source validity and claim coverage? The six collagen papers are
development gold for extracted values. The other nine Article sources from R1
are unannotated. No source is independently held out and no existing model link
is an independently reviewed entailment label. Generic/recipe Catalog is outside
this Article-only comparison.

Use each source's sealed R1 **bounded** artifact as the upstream reference. All
15 such cells are already sealed; use the same choice for every arm, regardless
of its score or how successful its previous grounding was. Do not freeze upstream
from the quoted arm or choose a different extraction result per treatment.

## Freeze before grounding

Pin the original manifest, canonical generation/files, schema, inventory, returned
record values, contexts, value contexts, conflicts and upstream failure records.
Recover per-value origins from exact captured upstream replies, preserving the
mapping through reconciliation. Identity-bound fields retain inventory citations.
First establish exact original replay using the original frozen source and saved
tokenizer probes. Then require identical upstream records and requests when
constructing the new immutable bundle. Fail on an unexplained mismatch.

The grounding runner must enter the same serving verification/policy/scheduling
code at this fixed boundary. It must not generate document, inventory or record
calls. Capture reuse here establishes fixed inputs; only new grounding replies
are fresh inference. Keep upstream costs separate from grounding costs. Do not
count replay duration as extraction speed or describe this as an end-to-end
pipeline accuracy experiment.

Use a copied, pinned schema for every arm of each source. For collagen, explicitly
mark node ID `collagen.field_statuses` as `evidencePolicy=derived`, including its
absence/ambiguity diagnostics. Preserve all other fields and descriptions. The
metadata is present in all arms; only the policy factor enables pruning. Other
schemas retain the default quoted policy unless an explicit, recorded annotation
is justified before registration. No runtime name matching is allowed. A policy
arm with no eligible schema difference is a declared zero-treatment comparison.

## Method matrix

| Method | Grounding | Schedule | Schema policy | Routing |
|---|---|---|---|---|
| quoted | quoted | all | off | canonical order |
| spans | spans | all | off | canonical order |
| spans_unresolved | spans | unresolved | off | canonical order |
| spans_policy | spans | all | schema | canonical order |
| spans_unresolved_policy | spans | unresolved | schema | canonical order |
| spans_routed | spans | unresolved | schema | origin_lexical |

Declare and validate single-setting contrasts: quoted→spans; spans→spans_unresolved;
spans→spans_policy; spans_unresolved→spans_unresolved_policy;
spans_policy→spans_unresolved_policy; spans_unresolved_policy→spans_routed.
The middle four arms also expose scheduling × policy interaction. Report the
requested cumulative stack separately from these contrasts.

Quoted→spans compares the implemented methods: it changes reply representation,
prompt, span granularity and initial batch cap (4 versus 32). It does **not** isolate
ID spelling or batching alone. Both methods retain actual input-token admission
and a 2,048-token output reserve. More span labels can enlarge input/schema tokens
and force smaller admitted batches; the 32-claim cap is not a promised batch size.
Measure this rather than extrapolating the earlier 18-versus-144 Wang calls.

Routing orders every complete unit, grouping claims sharing a next candidate.
Unsupported/invalid/missing/failed decisions continue; refused units remain gaps.
It stops after positive support, so a false positive may prevent finding a later
contradiction. No dense retriever or separately trained verifier is included.

## Execution and measurement gates

Before generation, pin all bundles, source code/archive, protocol, schemas,
provider/model/context and decoding settings. Register 90 cells (15 sources × six
methods), one greedy execution each, randomized with seed 20260928, with at most
two concurrent cells. Preserve the 12,288-token context ceiling and 2,048-token
grounding output reserve. Stop admission of new calls once a cell has accumulated
10,800 seconds of reported grounding model time. Reused replies count toward the
same budget; an in-flight reply can exceed it. Budget exhaustion is a retained
terminal failure, not a successful partial result or an automatic retry. This
model-time bound sums captured request durations, including provider queuing and
network time. It is not a wall-clock SLA or the product's execution deadline;
report actual wall time and any overshoot separately.

Preflight evaluates an explicit scripted all-NONE scenario with actual rendered
token counts; it is neither a fresh model outcome nor guaranteed eventual cost.
Save every tokenizer probe, including split/refused batches, in the cell's cache
with the provider identity. Serving drift, missing offline probes or changed
requests must fail replay visibly. No upstream generation is permitted.

Begin fresh inference only after the existing R1→R3→R4 chain settles and its
supervisor has been audited. Do not change the provider, run competing generation
or duplicate a sealed cell. Preserve exact requests/replies, refused and failed
decisions, unknown prior completions and terminal receipts. No automatic retry
may replace an unfavorable result. Replaying a captured cell is not repetition.

Report each document and paired document-level differences before aggregates:

- Grounding calls, input/output tokens, wall/model time and admitted claim batch
  sizes; distinguish fresh, replayed and uncertain work and provider contention.
- Every all-leaf denominator alongside policy-eligible leaves and skipped reasons.
  Include failures, missing decisions, refusals and unvisited units in accounting.
- Exact substring/offset/cell validity and source precision, independently checked
  against pinned canonical inputs. These are location diagnostics, not entailment.
- Origin/preferred/fallback attempts, late support, supported paths and remaining
  units. No claim of retrieval recall without independently reviewed evidence sets.
- A review queue for changed, dropped and newly added links, stratified by prose,
  table, subject, header, unit and qualifier. Existing generated quotes may assist
  inspection but cannot serve as semantic gold. Unsupported-link rate, semantic
  precision and evidence recall remain unavailable until independent review.

Recompute records and their existing value scores to prove invariance; a changed
score indicates broken input isolation. Use document-level uncertainty, not scalar
leaves as independent samples. A single greedy run does not measure serving or
model variability. Report this development study and the original study separately.

## Commands

From the implementation's Parsing Service directory, create each bundle using
the source's successful original HTTP-disabled replay receipt:

```sh
python -m experiments.extraction.fixed_upstream R1_OUTPUT SOURCE REPLAY_RECEIPT BUNDLE_JSON
python -m experiments.extraction.grounding_study R1_OUTPUT BUNDLE_DIRECTORY R5_OUTPUT
python -m experiments.extraction.study validate R5_OUTPUT/manifest.json R5_OUTPUT
python -m experiments.extraction.study preflight R5_OUTPUT/manifest.json R5_OUTPUT
python -m experiments.extraction.study run R5_OUTPUT/manifest.json R5_OUTPUT --cell CELL_ID
```

Freeze the registered code before preflight and generation. The serving entrypoint
and experiment both call `kie.extract.assembly.ground_records`; policy and scheduling
must not have a separate benchmark implementation. Registration replays every
bundle's upstream again and rejects changed values, origins, requests or diagnostics.
Only the four declared grounding options may differ from the frozen upstream options.
