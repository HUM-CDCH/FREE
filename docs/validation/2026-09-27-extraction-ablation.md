# Modular extraction ablation — execution record

Status: **implementation verified; live study running; results pending**.

The [execution plan](../plans/2026-09-27-modular-extraction-ablation-study.md) and
[stage documentation](../../prototypes/parsing_service/docs/extraction-experiments.md)
describe the implementation. This record must be completed from terminal study artifacts;
the old reference accuracy below is a scorer regression check, not a new study result.

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
