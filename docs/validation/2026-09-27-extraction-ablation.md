# Modular extraction ablation — execution record

Status: **implementation merged; R1 execution complete; R3 running; final replay and results pending**.

The [execution plan](../plans/2026-09-27-modular-extraction-ablation-study.md) and
[stage documentation](../../prototypes/parsing_service/docs/extraction-experiments.md)
describe the implementation. This record must be completed from terminal study artifacts;
the old reference accuracy below is a scorer regression check, not a new study result.

## Current execution recovery

Latest checkpoint, 2026-09-28 07:47 CEST (05:47 UTC): R1 has all **79/79 sealed
results**. Its recovery parent exited normally, and full frozen-input validation
passed for all 79 cells and 16 sources. Eight cells retain partial processing;
their failures remain in the study. The existing supervisor validated frozen R3
and started the rendering comparison, which now has three of twelve seals.
R4 remains queued. R2a has all 30/30 results and a complete offline acceptance
check, described below. R5 remains separately queued after original collection.

Sixty R1 cells have earlier exact replay acceptance from 1,945 saved replies with
HTTP disabled. Increment `replay-verification-20260927/increment-60-offline.json`
adds thirteen cells to the disjoint earlier verification sets. The final collector
below still owns all-cell replay and corrected analysis. Sealed execution does
not establish that final acceptance or semantic correctness. The handoff receipt
is `span-grounding-20260928/r1-complete-r3-handoff.json`; live process identities
must be refreshed from the integration pointer and `/proc` before any action.

The [complete R1 failure audit](2026-09-27-extraction-failure-cases.md#complete-r1-failure-audit)
retains 71 failures among 3,355 artifact call entries: 64 literal-control JSON
failures, three truncated replies and four refusals before inference. Saved-capture
inspection independently confirms those categories; it does not repair predictions
or replace final replay. Interrupted attempts and unknown prior work remain separate
in the final cost accounting.

Disk exhaustion at 21:28–21:29 UTC interrupted Harvey's quoted and reference
attempts. Their logs explicitly record `ENOSPC`; sixteen immediately following
commands exited 120 with empty logs and no cell artifacts. Those sixteen are
unexecuted infrastructure gaps, not extraction outcomes. At recovery inspection,
22.8 GiB was available without this recovery deleting files. The two interrupted
attempts retain 136 replies and two requests with no saved reply; their prior
completion is unknown and must remain in cost accounting.

`resume-20260928-3/disk-interruption-audit.json` pins the retained files, failed
command logs, process identities and available disk space. The explicitly audited
recovery resumes only these eighteen ended commands, in original order, with one
worker beside the still-live Akita quoted worker. It validates all frozen pins,
preserves saved replies and refuses to admit another cell below 5 GiB free.
The waiting R3/R4 scheduler was stopped before it had any children or generated
results, then replaced by `free-ablation-followups-resume-3`, whose controls are
under `followups-resume-20260928-3/`. It waits for the new recovery parent and
requires all 79 seals. The new parent also waits for the earlier Akita launcher
and selection follower to exit. No inference worker was stopped or duplicated.

Final collection is scheduled separately under
`artifacts/extraction-ablation/final-collection-20260928/`, owned by user service
`free-ablation-final-collection-20260928`. It waits for the exact replacement
R3/R4 scheduler, then requires every R1/R3/R4 artifact seal and execution receipt.
It never launches fresh model generation. It replays the captures with separately
cached tokenizer probes, repeats acceptance with HTTP disabled, and generates
corrected `analysis-final.json`, `accounting-final.json`, `tables-final.md` and
`grounding-workload-final.json` for those three studies. R2a's existing final
verification and reports are retained and checked. Do not write these reserved
final paths in parallel with the collector.

Reporting is also frozen: 75 source files, the corrected analyzer and four helper
scripts are preserved in `reporting-code.zip`, SHA-256
`43058e46665ae3b69e8f8ce7d709f368702f867b834992a8e6e23b29a2a8d426`.
The replay cache retains 1,455 previously observed tokenizer probes. Acceptance
checks regenerated all 30 R2a metrics/accounting/table contents identically,
apart from provenance paths and dependent hashes, and replayed Herredsvejen
bounded with HTTP and fresh generation disabled. Absent-parent and incomplete-
study checks refuse collection before launching commands. Receipts are under
`acceptance-r2a/`; `waiting-verification.json` confirms the collector is waiting
with no child commands. `collection-complete.json`, when present and validated,
will establish generated reports, not reviewed scientific conclusions or goal
completion. A missing cell or failed command stops collection without retry.

The following paragraphs retain the earlier checkout-recovery record; their
counts and scheduler identities are historical.

The implementation stack merged into `feat/kei-exp-parser` at `377cd050` after
all three pre-merge heads passed CI. Its tree matches tested full-stack `a6c5612`.
This does not change the frozen methods or complete their evaluation.

The primary checkout moved away from the registered R1 source at 18:23–18:27 UTC.
Thirty-five queued commands failed their code-pin check before execution; they
are missing results, not measured model failures. The original worker and its
captures are retained. `artifacts/extraction-ablation/resume-20260927-2/checkout-drift-audit.json`
records the reflog evidence, rejected commands and recovery policy.

R1's original 71-file archive is restored at
`artifacts/extraction-ablation/frozen-execution/r1`; it validates all 79 cells and
16 sources. R2a's 73 registered files are frozen at the sibling `r2a` directory
and validate all 30 cells and 15 sources. Its recovery archive is
`resume-20260927-2/r2a-code.zip`, SHA-256
`b00cde1b7fcb4b2c151220969c2ad97c76557b27b6af01f26c6149c2ab2200ad`.
No manifest, result or captured response was rewritten.

The `free-ablation-r1-resume-2` user service waited for the recorded original
launcher and follower identities to disappear, then audited seals and resumed
35 missing cells with two workers in registered order, retaining all 44 existing
results. The first two workers' `/proc` working directories and `PYTHONPATH`
pointed to frozen R1, and both passed all input/code pins. Their receipt is
`resume-20260927-2/handoff-verification.json`. Its saved waiting and
execution plans are under `resume-20260927-2/`. The corresponding selection
follower uses frozen R2a; the scheduler under `followups-resume-20260927-2/`
requires all 79 R1 results before running frozen R3, then R4. These are scheduled
dependencies, not completed study results. Consult the artifact root's
`INTEGRATION-POINTER.md` and actual processes for current state.

At the next verification checkpoint, 45 R1 results and 24 R2a results are sealed.
All 45 R1 cells replay exactly from 1751 saved calls with HTTP disabled. The
incremental reports through `replay-verification-20260927/increment-45-offline.json` cover disjoint
cell sets. Akita unverified and Sousa bounded contribute
89 calls; initial verification obtained 306 separate tokenizer probes before
the offline check. Sousa crossed the checkout-change interval but still replays
exactly under registered code. Akita bounded subsequently finished in 9087
seconds with 126 calls and partial grounding; it also replays exactly, using
253 separate tokenizer probes before its HTTP-disabled check. Ellekilde's
generic Catalog result adds 14 calls, with no extra tokenizer probes required.
The replay coverage proves reproducibility, not independent semantic correctness.
Frozen launchers still use their historical
analyzers; final reports must be regenerated with the corrected analyzer below.

## Frozen protocol

- Branch: `feat/modular-extraction-ablation`, based on pushed repair `6e641b6`.
- Manifest: `artifacts/extraction-ablation/20260927-r1-manifest.json`.
- Manifest SHA-256: `9ae6df46ff51c594030ffe7b44f17bb44d9e209a623764b16be1319de1cdea11`.
- Code snapshot: `artifacts/extraction-ablation/20260927-r1-code.zip`.
- Snapshot SHA-256: `a6be4f62aac7c4715b759384d86f77d35f84774fb06045dc6051292cae630303`.
- Captures/results: `artifacts/extraction-ablation/20260927-r1/`.
- 79 cells on 16 pinned canonical sources: six collagen development papers and ten examples.
- Eight Article methods: reference, conservative identity, schema prompt, bounded context,
  bounded quoted grounding, full-source quoted grounding, preceding overlap, and grounding off.
- Ellekilde: generic Catalog reference, recipe Catalog, no overlap, and verification off.
- Nine declared one-factor comparisons and one context-by-grounding interaction.
- Qwen/Qwen3.8-27B-FP8 for both roles; greedy decoding, thinking disabled; served context 32,768.
- Seeded cell order, two concurrent cells. Runtime dependencies, provider container image/args,
  model server version and execution order are saved. Model weights digest is unavailable.

No new OCR is mixed into a method comparison. The existing final canonical revisions are
pinned, including repaired Akita, Hamburg and Katrinesminde conversions. Model requests
receive source, schema and method settings; gold and scorer are read only by analysis.

The exact registered inputs are also preserved in
`artifacts/extraction-ablation/input-preservation-20260928.zip`, SHA-256
`04b23eb27142aca009c7c1fb6f91ab9119403a0cd2348d25cced3295af32b957`.
It contains all four manifests and an index mapping 276 referenced paths to
274 distinct content objects, including PDFs, canonical files, schemas and
evaluation inputs. Every archived member passed CRC and registered SHA-256
verification; the original files remain unchanged. The matching JSON receipt
records these checks. This is a local recovery copy; model weights and the
Python environment are outside it, and source-code archives remain separate.

## Estimands and limits

The primary accuracy unit is a document: correct populated sample fields divided by eligible
populated sample fields under the unchanged adjudicated scorer. Report each paper and the
mean paired treatment-minus-control change. Bootstrap the document differences with seed
20260927 and 10,000 draws. With six development papers, intervals describe a small observed
sample; they cannot establish unseen-document performance. No hypothesis-test p-values or
significance claims are planned.

Report empty fields, record alignment, unscored extras, links, refusals, calls, tokens and
timing separately. The gold is non-exhaustive: unmatched predictions are an adjudication
queue, not automatically false positives. The ten example PDFs have no independently
annotated field gold, so they do not acquire an accuracy score from their own outputs.

Grounding modes change links, not raw record fields. Any raw-value difference between
grounding arms comes from regenerated upstream replies. Report whether those upstream
records match before interpreting grounding differences. Exact source quotes and model
attribution do not constitute independent semantic entailment. Catalog glossary and heading
effects are not estimable on the supplied grave excerpt; those switches have contract tests.

These are controlled adaptations of researched techniques, not reproductions of complete
published systems. Coordinate encoding, learned retrieval/routing, supervised training,
stochastic voting and VLM crop rereading are outside this matrix.

Timing is direct extraction through shared model endpoints and includes possible serving
contention. It is not isolated model throughput, DBOS queue latency, authenticated API
latency, or deployment validation. No deployment was performed.

## Selection replay: complete registered cohort

R2a has all 30 sealed cells across fifteen paired documents. All fifteen
original bounded controls and both selection arms reproduce with HTTP disabled;
the thirty receipts match the exact reused request subsequences, totaling 500
saved replies and zero fresh model or tokenizer calls during acceptance.
The [complete result tables](2026-09-28-extraction-selection-results.md) include
per-document scores, request budgets, stage totals and issues.
Grounding is disabled in both R2a arms. Their budgets exclude verification calls
and do not estimate savings for the full grounded pipeline.

No annotated paper's primary gold score changes under selection; the paired mean effect is 0
percentage points across six documents. The zero-width descriptive bootstrap
interval does not establish equivalence or unseen-document accuracy.

| Six-paper captured request budget | All units | Selected units | Reduction |
| --- | ---: | ---: | ---: |
| Calls | 162 | 148 | 14 (8.6%) |
| Input tokens | 1,012,730 | 978,115 | 34,615 (3.4%) |
| Output tokens | 72,222 | 66,910 | 5,312 (7.4%) |

Among the six annotated papers, only Akita and Harvey omit calls (nine and five
respectively); four papers show no budget reduction. In this annotated cohort,
all record fields remain identical except diagnostic
`field_statuses` in Akita and Harvey and free-text `notes` in four Akita records.
The notes are outside the primary score; their changes are not adjudicated as
improvements. Thus unchanged gold scores do not imply that every output is equal.

This is a fixed-reply subsequence comparison with no fresh model generation.
The budgets describe included captured requests, and their saved durations are
historical. They are not measured fresh-model savings or replay execution latency.
The full registered cohort gives these operational effects:

| Fifteen-document captured request budget | All units | Selected units | Reduction |
| --- | ---: | ---: | ---: |
| Calls | 266 | 234 | 32 (12.0%) |
| Input tokens | 1,614,448 | 1,485,099 | 129,349 (8.0%) |
| Output tokens | 97,316 | 88,430 | 8,886 (9.1%) |

Eight documents omit calls; seven have no budget reduction. Both arms contain
81 records, but record count does not establish value coverage. Besides the
annotated differences above, selection changes substantive fields in five
unannotated documents: Age, Hamburg, Herredsvejen, Hvissinge and Katrinesminde.
These include shorter findings/methods lists, omitted grave-count observations,
and a previously conflicting/null research question becoming populated in Age.
For example, Katrinesminde's first record retains two of seven grave-count
observations. These differences have no independent semantic labels: they could
include lost evidence, removed duplication or resolved attribution conflicts.
They are retained in `selection-change-review-queue.json`; unchanged collagen
scores must not be described as lossless selection or corpus-wide equivalence.

Evidence is under the primary checkout's
`artifacts/extraction-ablation/20260927-r2a-selection/`: `analysis-final.json`
(SHA-256 `23f591d3c43d16ed2d5a3f773dcb02619f3c43d6ecbf15ff244ce26b9b89ef26`),
matching `accounting-final.json`, `tables-final.md`, `audit-final-pairs.json`,
and `verification-final-offline.json`. These use the corrected analyzer.
The earlier `*-six-gold-pairs` files remain unchanged historical checkpoints.
Completion of this conditional selection comparison does not complete R1,
R3/R4 or the full study.

## Grounding workload: diagnostic fields

A read-only capture audit at the 60-cell R1 checkpoint separates grounding
requests concerning `field_statuses` from other requested record fields. The
Article verifier visits every populated leaf for each source unit; quoted mode
starts with four claims per batch, then splits further if admission requires it.
It therefore asks the model to ground diagnostic assertions as well as source
measurements. This accounting describes the frozen implementation; no request,
schema, reply or method was changed.

Among the completed cells, Article grounding has 1,162 requests with saved
replies and 18,600 claim decisions. Of those decisions, 4,935 (26.5%) concern
`field_statuses`. There are 137 diagnostic-only calls (11.8% of these grounding
calls), using 832,883 input tokens (8.2%) and 17,751 output tokens. Another 367
calls mix diagnostic and other fields. These totals include unsuccessful model
outputs; they measure attempted verification, not correct or unique facts.
Claims recur across source units. Token attribution excludes mixed batches and
does not estimate the savings of an unrun alternative implementation.

The unfinished Akita quoted cell is a separate snapshot: 135 of its 447 saved
grounding calls concern diagnostic fields only. Harvey quoted has 56 such calls
among 143 saved grounding replies. Neither partial snapshot is pooled with the
completed-cell totals or represented as its final cost.

There is also a product execution boundary: at 00:27 UTC on September 28,
Akita quoted was still receiving replies more than four hours and fifty minutes
after its 19:36 UTC attempt start. The direct study harness does not apply
Studio/Parsing Service's documented three-hour extraction deadline. A terminal
research artifact therefore would not establish that this arm can finish within
the application's execution budget. Keep that distinction in the final cost and
adoption discussion; the frozen research attempt remains unchanged.

Evidence and the executable audit are in
`artifacts/extraction-ablation/grounding-cost-audit-20260928/`. Run `audit.py`
from the primary checkout with the study directory and a new output JSON path.
`snapshot.json` pins its script, manifest and all inspected request/reply files.
It maps each captured claim identifier to the exact embedded record's leaf
order. A second check parsed the displayed claim descriptions directly: both
methods found 20,886 decisions and 5,690 diagnostic decisions across all 1,752
inspected requests, including the two explicitly partial cells.

This exposes a follow-up design question: source values and extraction-status
assertions need different evidence requirements. Any change must preserve the
researcher's approved schema and separately measure value coverage, status
usefulness and cost. It is not part of the current frozen comparison.

## Failure accounting: 60-cell checkpoint

The sealed R1 artifacts contain 1,947 recorded calls, including 37 failures:
33 grounding replies rejected for literal control characters in JSON strings,
two output-truncated record replies (Akita overlap and Sousa unverified), and
two context refusals before inference (Age document and inventory). Each of
the 35 failed replies was independently matched to its saved capture by exact
finish reason, usage and duration. All 33 control-character replies end with
`stop` and satisfy the requested schema only when diagnostic decoding permits
literal controls. Frozen extraction outcomes remain unchanged.

The same artifacts contain 96 `unsupported_quote` diagnostics. These are
model-attribution or literal-substring rejections, not independently reviewed
false values. Active cells and interrupted attempts are excluded from this
sealed-cell summary; the infrastructure recovery receipts account for them
separately.

Reproduction: run `failure-audit-20260928/audit.py STUDY_DIR NEW_OUTPUT.json`
under `artifacts/extraction-ablation/`. The script pins the manifest and every
sealed result, checks artifact seals and finished receipts, and retains missing
cells and uncategorized failures. `r1-sealed-60.json` and
`independent-capture-check.json` preserve this checkpoint. Recompute after the
final collector finishes; this audit does not own its reserved report paths.

## Verification before inference

| Check | Evidence |
| --- | --- |
| Parsing Service suite | 995 passed, 72 skipped, 68 deselected |
| Extraction adapter suite | 68 passed |
| Typechecking | Passed |
| Exact reference replay | Six papers, all 88 requests/replies and stable artifact fields identical |
| Frozen scorer regression | Old captures reproduce 333/374 populated fields and ten unscored extras; offline only |
| OpenSpec | Strict validation passed |
| Bloat audit | No blockers; named reference and research controls are required by the study |

Unit tests cover partial identity collisions, conflicts, primary ownership, late evidence,
budget refusal, cancellation, quoted support, Catalog factors, changed pins, multi-factor
rejection, immutable publication, exact reply reuse, unknown prior completion and paired
document uncertainty. Worker/persistence behavior was not changed; no new lifecycle or
authenticated end-to-end result is claimed.

Real-tokenizer preflight admitted every bounded inventory unit. Full-source Age inventory
counts 34,873 tokens with the reference prompt and 34,699 with the schema prompt, before
output reserve, so those calls are expected to refuse. Bounded Age uses five units. Each
document, value and grounding request is independently counted again during execution.

## Reproduction and remaining work

From `prototypes/parsing_service`, use the commands in the stage documentation. `run` checks
all registered pins and retains completed cells. `--cell` selects a registered cell. Never
start a duplicate while the recorded launcher or cell process is still active.

Remaining: finish all registered cells; resolve infrastructure failures through exact
resumption; generate analysis; review extra predictions and failure cases; populate effect,
cost and refusal tables; verify regeneration from captures; finalize this record. Failed or
refused extraction is retained in the study denominators. The active goal is not complete.

### Exact replay of live captures

`docs/validation/extraction_capture_replay.py` verifies sealed fresh-call cells
against the registered source/code pins, artifact seal and execution receipt.
It uses the existing exact request/reply matcher, consumes every saved reply,
and compares the entire regenerated artifact except top-level `started` and
`seconds`. Recorded per-call durations and failed/partial outcomes must match.
It never creates model replies or modifies study cells. R2a uses its separate
conditional `selection_replay` command and original-control check.

R1 did not save tokenizer probes for partition candidates that never became model
calls. The verifier therefore uses captured input counts where available and
requires a separate token-count cache for other probes. `--allow-tokenize`
explicitly permits filling that cache from the registered provider; without it,
a missing count refuses verification. These are post-run tokenizer observations,
not newly discovered original captures. Cache entries record the request/provider;
the verification report pins each used entry. This does not attest loaded weights.

From the pinned R1 Parsing Service checkout, an example invocation is:

```bash
PYTHONPATH=src:. .venv/bin/python ../../docs/validation/extraction_capture_replay.py \
  ../../artifacts/extraction-ablation/20260927-r1 \
  ../../artifacts/extraction-ablation/replay-verification-20260927/replay-new.json \
  ../../artifacts/extraction-ablation/replay-verification-20260927/token-counts
```

Outputs are exclusive; choose a new report filename for another check. Repeated
`--cell ID` arguments pin the cohort when a study is still running. The first
completed cohort has **35 cells and 1,204 captured calls**, including the recipe
Catalog and all five incomplete-processing cases present in that cohort.
`replay-verification-20260927/initial.json` records the check with token probes
permitted; `offline.json` verifies exactly that cohort again with HTTP disabled
in the acceptance process and zero fresh tokenizer/model calls. Three focused
tests reject changed values, unused replies, missing offline counts and changed
provider cache entries. Remaining cells are not covered by this partial replay.

Bloat review accepts this verification CLI because registered studies need receipt
checks and unsent token probes beyond the earlier reference-fixture replay. It
reuses that fixture's matcher and changes no serving entrypoint or frozen module.

Supplementary observation accounting is provided by
`docs/validation/extraction_ablation_accounting.py STUDY_DIR ANALYSIS_JSON OUTPUT_JSON`.
It lists every output array item, whether the frozen gold projection selected it, exact
duplicates within its collection, and its available links/quotes. It also checks whether
grounding comparisons have identical upstream records and inventory. Three hand-calculated
regressions pass. The old Akita fixture exposes 20 thermal observations, nine unselected by
the projection. This is an offline validation of accounting, not a new accuracy result.

Supplementary accounting also groups calls, failed calls, reported input/output usage and
recorded duration by stage. Unknown usage is counted separately from reported zero usage.
Reused replies retain historical durations; stage sums are not fresh replay latency or
end-to-end wall time. The script consumes exactly the sealed analysis snapshot, preventing
later-finishing cells from being accidentally classified as unannotated. Six focused
regressions pass, and regenerated accounting records the script and analysis hashes.

Supplementary `record_field_links` also decomposes the populated/linked leaf
denominator by top-level schema field. This descriptive addition was made after
observing the 33-cell snapshot; it does not change the primary metric. For example,
absence declarations in the collagen schema's `field_statuses` are ordinary output
fields and therefore enter the verifier and overall link rate. They must not be
mistaken for measured scientific values or independently verified absence. Field
counts preserve this distinction without a schema-name heuristic in the pipeline.
Duplicate links count once; unverified fields and filename-derived values remain
excluded. Shared call costs cannot be attributed to individual fields from these
counts. Eight focused accounting regressions pass.

Human-readable tables are generated with the standard-library-only renderer:

```sh
python3 docs/validation/extraction_ablation_tables.py STUDY_DIR ANALYSIS_JSON ACCOUNTING_JSON OUTPUT.md
```

It requires the accounting's exact analysis hash, checks cell manifest pins and
registered/missing/paired denominators, and refuses to overwrite an output. Tables
show per-cell populated/empty accuracy, identity alignment, unscored extra records,
link coverage, issues, stage costs and the number of available versus registered
pairs. Accuracy and operational effects retain their different document sets.
One-document intervals are suppressed; zero-width intervals are explicitly not
equivalence evidence. Refused/failed outcomes remain observed cells, and missing
processing flags are reported as unknown rather than successful.

Six focused reporting tests pass. Real outputs are R1 `tables-partial-11-v2.md`
(36/79 cells, analysis/accounting `partial-11`) and R2a `tables-partial-07.md`
(18/30 cells, analysis `partial-07`, accounting `fields-01`). All stage call/failure
and token totals reconcile with their respective analysis snapshots. The older
R1 `tables-partial-11.md` remains as an explicitly hashed earlier renderer output.
The renderer is outside the inference code pin, adds no dependencies and does not
rescore, rerun or replace a study cell. Bloat review accepts its CLI as the
reproducible report-generation entrypoint; no obsolete report path was retained.

### Reporting correction and exact representation

The final analyzer now aggregates repeated document metadata with the frozen
scorer's rule: any incorrect eligible sample row makes the document field
incorrect, otherwise any pending row keeps it pending. The earlier dictionary
kept the last row and could hide a disagreement. Order-reversal regression tests
cover that case. This correction changes no primary sample score, gold label,
identity alignment, model request or saved prediction.

The planned exact-versus-normalized distinction is also explicit. Each scored
cell includes `exact_projected_match` for sample and document fields, split into
populated and empty groups. Exact credit requires the frozen alignment/projection
gates to pass and equal JSON representations of projected expected/actual values.
Case, whitespace, list order, JSON types and integer/float distinctions remain
visible. This is a descriptive representation diagnostic, not source-span
correctness, a new primary estimand or an adjudication of pending semantic text.
Tables show populated exact counts beside the normalized document summary;
normalized sample scores remain in their original table.

Analysis outputs record the analyzer's path/hash. The current table renderer
refuses older analysis lacking these corrected fields. Regenerate final analysis
from the corrected integration checkout, then run accounting and table rendering
against that exact output. Do not alter a running/frozen inference checkout.
Automatic `analysis-initial.json` reports from frozen launchers remain historical
outputs and must not be substituted for this corrected final analysis.

Twenty-three focused study/accounting/table tests pass. The R1 41-cell and R2a
20-cell `analysis-reporting-correction-v2.json`, matching accounting JSON and
`tables-reporting-correction-v2.md` snapshots regenerate successfully; all stage
call/failure/token totals reconcile. Comparison with the earlier 36/18-cell
snapshots preserves every shared primary score, diagnostic and execution receipt.
No document summary changes in those shared cohorts; the aggregation regression
is demonstrated by the adversarial fixture. The audit is
`artifacts/extraction-integration/reporting-correction-audit.json` in the current
integration checkout. These snapshots remain partial.

For reported record fields in the existing development gold, the frozen scorer already
compares candidate-link pages against annotated evidence pages. Supplementary accounting
summarizes `candidate_page_overlap`, `candidate_other_page` and `missing`, cross-tabulated
by value correctness. This retains wrong values that happen to cite the right page.
Document fields are excluded because Article does not verify them. Page overlap is a
coarse localization diagnostic, not semantic entailment or exhaustive evidence recall;
unannotated examples receive no such gold-based score.

## Separate selection comparison

Record-specific selection is implemented and pushed at `6b8d34d` on
`feat/extraction-evidence-selection`, isolated from R1's running source checkout.
It retains whole value units containing identity support, adjacent canonical passages,
and at most one positively ranked schema-relevant unit. It records selection reasons,
omitted units/passages and unmeasured relevance recall. Inventory, document-field extraction
and semantic verification retain their original bounded coverage.

R2a's manifest is `artifacts/extraction-ablation/20260927-r2a-selection/manifest.json`;
the protocol is `experiments/extraction/selection-protocol.md` in that branch's service
directory. Thirty cells cover the same 15 Article sources. Both arms disable grounding;
only value-unit selection differs. Inventory and retained requests use fixed R1 responses.
The original bounded artifact must first replay exactly. A request absent from the captured
subsequence, or identical requests with different replies, explicitly refuses replay.
Tokenizer probes are saved for subsequent offline replay.

This estimates candidate changes conditional on one recorded inventory and set of responses.
It is not fresh inference, an independent repetition, measured runtime savings or a test of
selector effects on semantic verification. Original reply timings remain historical values.
The initial R2 implementation canary was superseded by R2a's ambiguity guard; exclude it
from analysis. The selector itself and its outcomes were not tuned between these revisions.

Selector verification: 1007 unit tests passed, 72 skipped, 68 deselected; six-paper / 88-call
reference replay still matches. The first R2a source passed exact bounded replay and both
arms. Remaining sources depend on their R1 bounded captures. Partial analysis currently
verifies missing-cell accounting (R1 1/79, R2a 2/30); these are not final effect estimates.

Integration of the selector into the primary feature branch remains pending until R1's
pinned execution finishes. Both feature branches are pushed; no production deployment.

The [source-level case review](2026-09-27-extraction-failure-cases.md) records the first
observed failure mechanisms: unresolved partial identities yielding duplicate final keys,
and zero lexical relevance scores discarding a unit with reported grave subcounts.
This review supplies descriptive evidence, not independent annotation or a reason to
tune the registered selector during execution.

## Interim snapshot — 2026-09-27, approximately 11:30 UTC

R1 `analysis-partial-07.json` contains 22/79 terminal cells; R2a
`analysis-partial-05.json` contains 10/30. Their corresponding
`accounting-partial-07.json` and `accounting-partial-05.json` were generated from
those exact sealed snapshots. Later results may exist outside these snapshots.

The first gold-scored grounding pair is Wang: 36 versus 162 calls, unchanged
projected sample-field correctness, and differing upstream value replies despite
identical requests. The case review records why its small link-rate difference
does not isolate grounding quality. The other newly available R1 pair is
Brondbylund schema versus bounded context; it has no annotated field gold.
Mizuta's selector replay retains all units and produces identical records and
costs. These incomplete comparisons do not establish a preferred method.

## Execution interruption and recovery — 2026-09-27, 12:22 UTC

The local launcher, replay follower and SSH tunnel disappeared after the last
captured replies at approximately 12:04 UTC; the cause is unknown. Process and
exec-handle checks confirmed their absence. The remote model container remained
running and had no active or queued requests before recovery. All 79 manifest
cells still validated against their pins.

Recovery retains 23 sealed R1 results and 14 R2a results. The remaining 56 R1
cells use the original registered order and two workers. Two interrupted Akita
cells reuse saved replies; one unanswered request in each has unknown prior
completion and is counted accordingly. Local systemd user units supervise the
launcher, follower and tunnel. Recovery provenance, scripts and logs live in
`artifacts/extraction-ablation/resume-20260927-1/`; the original logs remain intact.

The 23 finished R1 cells alone contain 764 calls, of which 505 are grounding,
and 5,602,811 reported input tokens. This cost excludes the interrupted cells'
unfinished work. The four-claim quoted-verification batches amplify repeated
source context; Wang uses 144 grounding calls in that arm versus 18 in the
semantic control. This is an observed cost of the registered design, not merely
an observation delay. Do not change the frozen methods to reduce costs mid-run.

## Review stack and baseline integration — 2026-09-27

The implemented work is pushed as three draft PRs, in review order:
[Article repair #142](https://github.com/HUM-CDCH/FREE/pull/142),
[modular study #143](https://github.com/HUM-CDCH/FREE/pull/143), then
[structure/grounding fixes #141](https://github.com/HUM-CDCH/FREE/pull/141).
The first is based on the existing `feat/kei-exp-parser` foundation; the others
are stacked on the preceding extraction branch. No PR is merged or deployed.

Repair commit `93e1ea7` integrates foundation `299bfc6`. An isolated checkout
passed 983 parser tests, 34 disposable PostgreSQL workflow tests, 72 adapter
tests, typecheck and exact six-paper/88-call replay. The conflict resolution
retains one cancellation callback at grounding-batch boundaries, updates
upstream fixtures for the repaired Article stages and reconciles the durable
worker documentation with three-hour Article/Catalog deadlines.
See the repair report's integration check for scope and replay location.

The live R1 runtime has not been advanced to this integration commit. Its
79-cell source/code manifest still validates. A dry merge is conflict-free,
but complete-stack runtime verification remains a separate integration gate.
At this checkpoint 36 R1 and 18 R2a results are sealed. These counts are
execution progress, not successful semantic extractions or a completed study.

An extraction-only integration snapshot was subsequently checked at local
commit `f3714ae`: fix commit `1fa6a9b` plus repair integration `93e1ea7`, in
`/home/gennaro/projects/FREE-worktrees/extraction-stack-review`. It passed
**1060 fast parser tests** (72 skipped, 74 deselected) and **34 guarded workflow
tests**. The offline checks again decode all 33 source-control-character replies
losslessly and replay six sources/88 exact requests and extraction data, allowing
only the intentional v11-to-v12 prompt/fingerprint change and top-level clocks.
Script and report: `artifacts/extraction-ablation/stack-integration-20260927/`.

Meanwhile another workstream merged server-owned Studio ingestion into PR #141,
followed by publication-cancellation and service-fixture fixes. Its ongoing
evidence is in that branch's
`docs/validation/2026-09-27-ingestion-pr141-reconciliation.md`. The isolated
extraction snapshot predates those additions and does not certify them. A dry
merge of the broadened branch with `93e1ea7` has two Studio conflicts, in README
and Playwright configuration. No conflict resolution or branch rewrite was
performed on that concurrently edited checkout. Complete-stack integration
therefore remains open alongside study completion; inference pins are unchanged.

## Structured input follow-up — registered, no fresh inference yet

The Docling audit led to an independent Article rendering factor at `dbde989`
on `feat/extraction-structured-input`. `rendering=structured` exposes canonical
block IDs/labels/pages and existing table cell positions/spans/roles in document,
inventory and value requests. Plain requests remain exact, and the grounding
renderer remains unchanged. All actual prompts are token-counted. Missing cell
structure is not inferred. This does not implement semantic context grouping.

Verification: 1018 parser tests passed, 72 skipped, 68 deselected; six papers and
88 reference calls replay exactly. The offline round-trip audit preserved all
2755 passages and 799 structured cells across the 16 registered sources, including
source control characters. OpenSpec validation and manual bloat review passed.
The explicit rendering choice and reference path are required experimental
controls; no compatibility service or duplicate canonical representation was added.

R3 has twelve fresh cells over the six annotated development papers. The only
method factor is rendering; both arms use full source, schema prompts,
conservative identity reconciliation and disabled grounding. The protocol is
`experiments/extraction/rendering-protocol.md` in the structured-input checkout.
The registrar validates the same source/schema/gold/provider pins as R1. It
additionally pins the R3 protocol, code and parent manifest identity.

- Manifest: `artifacts/extraction-ablation/20260927-r3-rendering-manifest.json`.
- Manifest SHA-256: `201285dc9fa18753759eec6909178db78cf73269b84b959f6cf326024b9b4b9c`.
- Code archive: `artifacts/extraction-ablation/20260927-r3-rendering-code.zip`.
- Archive SHA-256: `266d18303e2ae1b9d2a9b22cef1152ff511874a7747a51465337b4a5a0ec4d9e`.
- Offline audit: `artifacts/extraction-ablation/structured-rendering-audit-01.json`.
- Replay: `artifacts/extraction-ablation/structured-rendering-reference-replay-01.json`.

Tokenizer preflight is saved in `20260927-r3-rendering/preflight.json`. Eleven
inventory calls fit. Harvey structured counts 28974 input tokens before its 4096
output reserve, exceeding 32768; preserve that refusal in the eventual comparison.
Document/value calls have their own admission checks. No R3 response generation
has run, and R3 will not compete with the unfinished R1 batch. This follow-up
was motivated by observed development failures; it is not a held-out evaluation.


## Interim snapshot — 2026-09-27, approximately 13:20 UTC

R1 `analysis-partial-08.json` and `accounting-partial-08.json` cover 26/79
sealed cells; R2a `analysis-partial-06.json` and `accounting-partial-06.json`
cover 14/30. All three supervised recovery processes retain their verified
identities, and R1 has fresh replies. R3 still has no generated responses.

The 26 R1 cells contain 910 calls, 7,403,314 reported input tokens and 235,759
output tokens. This includes captured replies reused after interruption, each
once in its artifact, and excludes work whose reply was never saved. Reply
durations remain shared-provider observations. Thirty-three grounding calls
fail strict JSON parsing because their quote strings contain unescaped source
control characters; the separate failure-case review and saved audit distinguish
these from the one output-truncated record call in this snapshot. Sealed process
results are not all complete extractions.

The seven R2a source pairs include four with no omitted value units and no
candidate changes: Mizuta, Wang, Brondbylund and 1790-06-17-1. The only two
gold-scored pairs currently available are Mizuta and Wang, both with zero
intervention. Their zero accuracy difference therefore supplies no evidence
that removing units preserves accuracy on the other sources. Keep these cases
in the denominator and defer aggregate conclusions until all pairs are terminal.
