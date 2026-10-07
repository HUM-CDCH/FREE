# Structured Article input — R3 protocol, 2026-09-27

Status: declared after the R1 evidence-block audit, before any R3 inference.
This is a development follow-up hypothesis, not a preregistered R1 hypothesis.

Hypothesis: exposing existing block labels and table cell positions/spans reduces
header and subject ambiguity relative to plain text. Markup increases input cost
and may cause context refusals; retain those outcomes in the comparison.

Use all six annotated collagen sources in the frozen R1 manifest, with unchanged
PDFs, canonical generations, schemas, identity dimensions and gold/scorer. Both
arms use conservative identity reconciliation, schema prompts, full-source
contexts, no value selection, and grounding off. The only method difference is
`article.rendering`: omitted for plain text, `structured` for typed blocks/cells.
Document, inventory and record-value calls use that rendering. No semantic
grouping, OCR repair or table reconstruction is introduced. All source text,
including furniture and separate footnotes, stays present in both arms.

The treatment wraps canonical text in block/cell markup. IDs, labels, pages,
cell row/column positions, spans and available roles come from the pinned source.
It preserves the exact passage text, including control characters; this is tagged
model input, not XML 1.0. A table without cells remains a labelled text block.
No geometry, heading depth, caption association or missing cell is inferred.

Twelve cells, one fresh greedy execution per arm/source, seeded order 20260927,
at most two concurrent cells. Use the same Qwen endpoint, model, tokenizer and
decoding settings as R1. R3 waits until R1 generation has ended. Preflight may
call the tokenizer before then; it does not generate model responses. Register
the final code/protocol pins before preflight and generation. Preserve exact
request/reply captures and all refused, failed and incomplete outcomes. Only
verified interruption recovery may reuse captured replies within a cell.

Primary outcome: paired document-level populated sample-field correctness under
the frozen scorer; report each paper, the mean treatment-minus-control difference
and the registered 10,000-draw document bootstrap. Also report empty-field fills,
identity alignment, all extra records/observations, conflicts, calls, reported
input/output tokens, refusal rates and shared-provider elapsed time. No p-values.
Grounding is disabled in both arms to isolate upstream extraction and avoid the
expensive verifier; R3 does not estimate grounding quality or deployment latency.

This is a six-document development comparison. Prior R1 results motivated the
hypothesis; it is neither blinded nor held-out. Do not compare the structured arm
with a different R1 method as an isolated rendering effect. Existing R1 replies
are not treatment data, and replay cannot evaluate changed prompts. Schema,
grouping, model and renderer changes after inspection require a new revision.

Registration from this service checkout:

```sh
python -m experiments.extraction.register_rendering R1_MANIFEST R3_MANIFEST
python -m experiments.extraction.study validate R3_MANIFEST R3_OUTPUT
python -m experiments.extraction.study preflight R3_MANIFEST R3_OUTPUT
python -m experiments.extraction.study run R3_MANIFEST R3_OUTPUT
python -m experiments.extraction.analyze R3_OUTPUT R3_REPORT
```
