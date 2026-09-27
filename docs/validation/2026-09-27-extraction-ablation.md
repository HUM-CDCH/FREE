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
later-finishing cells from being accidentally classified as unannotated. Five focused
regressions pass, and regenerated accounting records the script and analysis hashes.

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
