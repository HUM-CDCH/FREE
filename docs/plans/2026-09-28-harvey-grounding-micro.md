# Harvey grounding micro-pilot — 2026-09-28

Status: complete; 12 cells sealed and exactly replayed offline, including four
cells with explicit budget refusals. Generation took 103.53 seconds and 12 calls.
See the [report](../validation/2026-09-28-harvey-grounding-micro.md). The registered
pre-generation protocol remains unchanged in the artifact directory.
This is a bounded follow-up to the user's small-pilot preference. The full R4/R5
matrix remains deferred. No existing cell is rerun or overwritten.

## Question and selection

Can compact span labels admit difficult, structurally faithful table/prose requests,
and what evidence do they select for these fixed claims? Do identical repeated
requests agree? This is an engineering diagnostic, not a document-accuracy estimate.

Use the registered Harvey canonical source, schema, upstream records and source
contexts from R5. Retain the full record JSON and complete selected source unit.
Select only these existing scalar leaves using the verifier's full-path skip set:

- Amberjack record 4, original context 0 (includes Table 1 with 48 canonical cells):
  scientific name; sequence-derived imino-acid value 18.6; the separate
  measured-composition basis and value 15.6 already present in the fixed record.
  This deliberately includes a conflicting value and row/basis attribution risk.
- Cod record 0, original context 1: sequence-derived composition basis; the TGA
  experimental-condition string; DSC peak 126 °C and its condition string.
  These include prose result support and information that may occur in another unit.

Selection was made from fixed fields and source structure before new model replies.
The document is development-exposed. The labels above are case-selection rationale,
not human semantic annotations. A NONE for one selected unit is not proof of absence
from the entire document. No synthetic claim or repaired upstream value is introduced.

## Controlled arms

Three arms: generated quotes under frozen R5; original span IDs under frozen R5;
compact span labels under the separately frozen version 2 code (runtime 684723f7).
The latter two differ only by label transport/prompt version. Quoted changes the
proof representation too. Use two independent fresh repeats of each case/arm:
12 cells, 48 selected claim–unit decisions including explicit refusals.

Both runtimes precede the concurrent architecture integration; their complete
80-file maps remain pinned. This tests those frozen implementations, not the
latest remote PR heads. Repeats are intentionally fresh, never captured-response
reuse. Within each case/arm, their complete requests must match.

Provider: existing Qwen/Qwen3.8-27B-FP8 endpoint at loopback port 18012, temperature
zero, thinking off, served context 32,768. Study context stays 12,288, including a
2,048-token output reserve. No model-weight digest is available. No new provider,
budget enlargement, source truncation or service restart.

## Preflight and bounds

| Case / arm | Calls per repeat | Attempted / selected | Refused | Input tokens per repeat |
|---|---:|---:|---:|---:|
| Table / quoted | 1 | 4/4 | 0 | 9,017 |
| Table / original spans | 0 | 0/4 | 4 | 0 |
| Table / compact spans | 3 | 4/4 | 0 | 30,451 |
| Prose / quoted | 1 | 4/4 | 0 | 8,438 |
| Prose / original spans | 0 | 0/4 | 4 | 0 |
| Prose / compact spans | 1 | 4/4 | 0 | 9,952 |

The all-NONE preflight predicts 12 total fresh requests across both repeats. The
original span refusals remain outcomes. Compact spans are more expensive than
quotes for this selected table batch; the experiment does not assume cost savings.

Use a fixed seed 20260928 for cell order and at most two workers. Stop admitting
generation HTTP calls after 600 wall seconds or 24 calls, whichever comes first.
An admitted request can run for at most the configured 120-second client timeout
beyond the admission deadline. Preserve timeouts/missing replies as failures and
do not retry a cell automatically. Existing adapter fallback for unsupported
structured output, if triggered, consumes the same HTTP-call cap and is reported.

Clarification, 2026-09-28 (after generation; the registered protocol above is
unchanged): the 120-second value is a client timeout, not a hard backend
termination deadline. The "concurrent architecture integration" above is
#145/#146, since merged as `2ce78e4c`; see the
[merged replay](../validation/2026-09-28-merged-grounding-replay.md).

## Artifacts and acceptance

New isolated root:
`/home/gennaro/projects/FREE/artifacts/extraction-ablation/harvey-grounding-micro-20260928/`.
Before generation, `registration.json` must pin config, protocol, both helper
scripts, all six preflights and their tokenizer probes. Config pins the original
manifest, canonical files, schema, upstream bundle, complete code maps and selected
claim values. Each worker validates these pins and provider identity.

Capture every request/reply, failure/refusal, actual provider metadata and process
identity. Seal completed cell results; replay them with HTTP blocked and cached
token counts. Report exact location validity separately from semantic inspection.
Retain all 48 decisions in the denominator, including 16 expected v1 refusals.
Report calls, input/output tokens, durations, table-cell/parent precision, selected
proofs, missing claims and repeated-request disagreement. With only two repeats,
do not estimate a stable disagreement rate or causal semantic effect.

Do not claim whole-document recall, held-out accuracy, v2 semantic equivalence or
completion of the original study. Publish all outcomes, including partial runs.
