# Synthetic PDF benchmark

Generate source documents from known structured values, then measure FREE's actual
parsing, extraction, grounding and reconciliation. This is a small development
benchmark, inspired by [VAREX's reverse annotation](https://arxiv.org/abs/2603.15118v2)
and its [implementation](https://github.com/udibarzi/varex-bench). It uses explicit,
reviewable schema-to-template mappings rather than model-generated annotations.
Its scores are not VAREX scores: unlike VAREX's
[scorer](https://github.com/udibarzi/varex-bench/blob/main/evaluation/score.py), this
pilot uses exact typed values and explicit record identities, without fuzzy
matching or numerical/string coercion.

All commands below run from `apps/parsing_service`. Generated inputs and result
receipts belong in the ignored `artifacts/` directory, never in tracked files.

```sh
uv sync --frozen --group benchmark
uv run --no-sync python -m experiments.synthetic_pdf --help

uv run --no-sync python -m experiments.synthetic_pdf generate \
  experiments/synthetic_pdf/pilot.json ../../artifacts/synthetic-pdf-benchmark/dataset
uv run --no-sync python -m experiments.synthetic_pdf validate \
  ../../artifacts/synthetic-pdf-benchmark/dataset
uv run --no-sync python -m experiments.synthetic_pdf parse \
  ../../artifacts/synthetic-pdf-benchmark/dataset

# An existing vLLM/OpenAI-compatible instruction model; do not start a second server.
export FREE_BENCH_BASE_URL=http://127.0.0.1:8002
uv run --no-sync python -m experiments.synthetic_pdf run \
  ../../artifacts/synthetic-pdf-benchmark/dataset ../../artifacts/synthetic-pdf-benchmark/results
uv run --no-sync python -m experiments.synthetic_pdf evaluate \
  ../../artifacts/synthetic-pdf-benchmark/dataset ../../artifacts/synthetic-pdf-benchmark/results \
  ../../artifacts/synthetic-pdf-benchmark/recomputed.json
uv run --no-sync python -m experiments.synthetic_pdf replay \
  ../../artifacts/synthetic-pdf-benchmark/dataset ../../artifacts/synthetic-pdf-benchmark/results \
  ../../artifacts/synthetic-pdf-benchmark/replay.json
uv run --no-sync python -m experiments.synthetic_pdf report ../../artifacts/synthetic-pdf-benchmark/results

# Optional benchmark dependencies and checks stay outside the normal fast suite.
PYTHONPATH=src:. uv run --no-sync pytest -q --import-mode=importlib tests/benchmarks/synthetic_pdf.test.py
```

`overlap-study.json` registers three independently generated long documents and
two live repeats for each of full Article, bounded Article at 8,192 tokens with
zero overlap, and the same bounded method with one passage of overlap: 18 cells.
Each document's PDF and canonical parse are shared across its methods and repeats.
Length, layout, record count, and one reprinted entry are fixed; there are no
contradictions. The primary contrast is overlap one versus zero, conditional on
this reprint profile. Overlap may move the window boundary as well as repeat source
passages. Inspect actual **value** contexts and the reprint's primary context in
the receipts; a bounded run with fewer than two value contexts is a degenerate
contrast. Full Article may fall back to bounded reading if its serving context is
exceeded.

Generate, parse and run this configuration with the same commands above, using
fresh dataset/result directories. Then preserve descriptive paired differences:

```sh
uv run --no-sync python -m experiments.synthetic_pdf compare \
  ../../artifacts/synthetic-pdf-benchmark/overlap-study/dataset \
  ../../artifacts/synthetic-pdf-benchmark/overlap-study/results \
  bounded-8k-ov0 bounded-8k-ov1 \
  ../../artifacts/synthetic-pdf-benchmark/overlap-study/overlap-comparison.json
```

Pairs share document, provider and repeat. Every registered pair retains its
terminal status; scoring failures have unavailable quality outcomes and retain
observed inference cost. The report also compares hashes of records, evidence,
disagreements and quoted support across fresh repeats, excluding clocks and call
statistics. It checks all registered repeats are present. Two identical repeats
remain one document observation; the three seeds do not support confidence
intervals or broad causal conclusions. Seconds remain descriptive because serving
load and prefix caching are uncontrolled.

The model in `pilot.json` is an example deployment choice. Change the model and
declared serving context before generating a dataset. `base_url_env`, optional
`model_env`, and optional `api_key_env` name environment variables; keys enter
only in-memory request headers. Each provider runs both extraction roles. The
endpoint must expose `/v1/models`, `/v1/chat/completions` and `/tokenize`, reporting
the configured `max_model_len`. This initial runner supports production
`OpenAIChat` instruction models; mixed role providers, NuExtract and GLiFormer
are future extensions.

## Production boundaries

Parsing calls `kie.stages.ocr.resolve` and `kie.runner.convert`, the same code as
the Markdown CLI and worker. Native PDFs use FREE's Docling layout/table path;
scanned PDFs use the configured production OCR adapter. Results are published
and validated through the canonical page files and `kie.passages.load`.
Extraction calls `kie.extract.run.extract`, shared with the existing research
harness and serving dispatch. There is no benchmark implementation of extraction,
grounding, token admission or merge logic. Generation and scoring live entirely
in this experiment directory. The benchmark does not exercise authentication,
DBOS recovery, persistence or Studio.

The existing harness's `manifest.write_new`, `study.Capture` and
`replay_reference.Captured` preserve requests/replies and refuse replacement.
The runner observes `OpenAIChat.complete` only during a sequential extraction;
it preserves exact adapter instances, including production whitespace recovery.
It saves HTTP request bodies and every admission token probe, including probes
for refused contexts. Replay checks logical requests, HTTP bodies, saved token
probes, generation and output equality, except top-level wall-clock fields. It
performs no generation or tokenizer HTTP calls. Replay time is not model speed.

This is an independent end-to-end synthetic study. It does not reuse or change
the registered Article-only fixed-upstream comparison in
[grounding-protocol.md](../extraction/grounding-protocol.md), whose historical
grounding links are not semantic gold.

## Ground truth and difficulty

The [article](templates/article.json) and [catalogue](templates/catalog.json)
templates share a [record schema](templates/record-schema.json). Each synthetic
object has a stable printed `record_id`; nested observation rows have `sample_id`.
Article returns one document object containing `items`; Catalog returns the same
objects as separate records, with document-scoped metadata. The expected records
are exported in FREE schema shapes in `truth.json` under `expected`, and the schemas,
original values, identities and evidence placements are retained in `truth.json`.

At each draw, the renderer records the field path, value, page, quote and value
bounding box in top-left PDF points. Validation checks FREE's schema plus its
strict JSON schema, coverage of every populated field, and independent PDFium
text extraction inside every recorded box. Rendering uses ReportLab's invariant
mode and a local seeded RNG; identical settings and pinned dependencies produce
identical PDF bytes. Missing values are explicitly null and have no value
placement. Annotation `placement` is `primary`, `reprint` or `conflict`; reprints
retain their identity and do not add gold records or primary cross-page records.
This truth format is version 2; the PDF drawing operations are unchanged.

| Document setting | Effect |
| --- | --- |
| `template`, `seed`, `records` | Reusable article/catalogue template and deterministic objects |
| `layout: single/columns` | One or two columns with the same field semantics |
| `cross_page` | First object's details continue on a new page |
| `repeat_values` | Shared institution and identical counts in different rows/objects |
| `missing_year_every: N` | Every Nth object's year is unrecorded |
| `repeat_entries: N` | N reprinted entries with the same Object IDs |
| `padding_pages: N` | Background pages increasing length and token windows; actual page count is recorded |
| `contradiction` | Conflicting document edition statements, null expected edition and both alternatives |
| `raster_dpi`, `blur_radius` | Image-only PDF at controlled resolution/blur; retain native PDF and its evidence |

Window overlap is an extraction setting: Article's production `overlap_passages`
or the Catalog method's own discovery/window settings. A selected bounded method
may still have only one context on a small document; inspect `cost.value_contexts`
and actual requests. [stress.example.json](stress.example.json) supplies longer,
contradictory and scanned cases. OCR runs additionally require `FREE_BENCH_OCR_URL`
pointing to the configured OCR model's existing completions endpoint. The pilot
does not measure OCR quality; scan generation is tested independently of OCR.

## Metrics and interpretation

Report each document before any aggregate. A wrong non-null value adds both a
false positive and false negative; null expected fields do not inflate recall,
and filling them adds a false positive. Strings ignore whitespace and Unicode
composition only. Types and case remain significant. Missing/unrecognized IDs
cannot be matched by position or fuzzy similarity. Unique object/row IDs and
scalar array values make array order irrelevant. Duplicate IDs/items remain
additional predictions. Within a duplicate ID group, the whole candidate with
the most exact field/array-member matches is aligned to gold; no fields are pooled
across copies. Nested same-ID rows follow the same rule. Ties prefer an exact
normalized subtree, then canonical content, citation count and canonical citation
content, independently of input order and citation correctness. All emitted
copies remain in prediction denominators. IDs never match across different groups.

* **Fields:** precision, recall and F1 for common object fields, excluding document
  metadata so Article and Catalog have the same denominator. **Metadata** is
  scored separately; Catalog repeats it per record.
* **Records:** identity precision/recall and exact record recall, including all
  object fields, required structure and arrays. Wrong IDs cannot gain field credit.
  Exact recall credits finding a complete gold object even alongside an extra copy;
  `exact_unique_recall` additionally requires that object's identity occur once.
* **Arrays:** multiset item precision/recall and fraction of gold arrays exactly
  complete. Observation identity completeness and count correctness are separate.
* **Evidence:** returned-link precision and coverage of gold populated claims.
  A link must address the correct value/identity/field and independently mapped
  physical location. **Source validity** alone checks canonical page, segment,
  box, cell and, when present, quote/offset validity. It does not attest entailment.
  Table claims require cell support when parsed cells exist; ambiguous coarse
  passages are counted separately and receive no attribution credit. Evidence
  recall includes gold lost during parsing; `parse_gold_coverage` exposes this
  separate bottleneck. Metadata copies may share their document-level citation.
  Version 2 preserves schema-shaped end-to-end evidence scores, whose Catalog
  metadata denominator repeats per record. For strategy comparisons, use
  `objects` (common object claims), `document_metadata` (each document field once)
  and `unique_claims` recall (their union). `conditional_grounding.precision`
  considers only links whose claim path and value align to gold, separating
  grounding failures from value/duplicate errors. Missing-path links are excluded
  from that conditional denominator; malformed citations to recognized correct
  claims remain false positives. All links remain in end-to-end precision.
  Source validity also describes citations of a printed conflicting value while
  its confident scalar prediction remains a value error. The summary displays
  the scripted oracle's object-evidence recall beside the model's, exposing the
  evaluator/parse attribution ceiling.
* **Merge:** duplicate object/array items, complete cross-page objects and recall
  of contradictory alternatives. In the initial implementation, alternative
  scoring reads Article's public `disagreements`; generic Catalog does not expose
  that representation. A conflicting scalar chosen without alternatives remains
  a false positive. The value-only score remains an end-to-end representation
  diagnostic. `eligibility` distinguishes absent representation, one value
  context, verified placement of gold alternatives across primary value contexts,
  and unverified/unsplit placement. `eligible_recall` is unavailable unless every
  gold conflict has verified split placement. Alternative citation entailment is
  not scored. Spurious disagreement fields are counted separately.
* **Cost:** actual calls, failed calls, input/output tokens, wall time, summed
  reported call duration, stages and separate source/value context counts. Value
  contexts are taken from the production `value_contexts`, not the source plan.
  Call duration includes network
  and provider queuing; it is not GPU compute time. Parsing has its own receipt.
  No monetary cost is inferred without prices.

Every completed cell also includes `controls.json`: schema-shaped oracle values
and predictions corrupted by wrong values, missing/duplicate records, an omitted
observation and a source-valid citation to another object. Those are scorer
diagnostics, never model accuracy. A source-valid repeated value from the wrong
record is also a unit test. Positive oracle evidence may be limited by parsing;
the extraction value denominator always remains the full generated truth.
If a coarse or incomplete parse provides no distinct source locations for the
wrong-record control, that diagnostic is explicitly skipped; extraction and
evidence scores are still reported.

## Reproducibility and limits

`inputs.json` pins PDFs, truth, configuration, source code, lockfile, Python and
dependency versions. `parses.json` pins the shared canonical parse generation and
debug/progress artifacts. Each run registers the full document × provider ×
method × repeat matrix and shuffles it with the experiment seed, serially.
Every cell records settings, serving identity/context, requests, replies, token
probes, raw production artifact, metrics, diagnostics and a terminal receipt.
`seal.json` detects later changes. Failed cells retain their full gold denominator
and visibly unavailable inference cost. Extraction failures and scoring failures
have distinct terminal states. A scorer crash retains the real artifact and cost,
records its phase and traceback, and leaves quality metrics unavailable; it never
substitutes empty predictions. Replay still checks those completed predictions;
score recomputation verifies the preserved scoring failure. Nothing automatically retries or replaces
an unfavorable result; use a new output directory for a fresh repetition.
Changed code/dependencies/inputs require a new dataset revision. Preserve the
checkout matching `inputs.json` when archiving results. Each dataset also archives
its pinned source files in `source-code/`, so subsequent benchmark edits cannot
erase the producing implementation.

The initial pilot has three synthetic documents, one model, three methods, one
greedy execution per cell. It is a pipeline and measurement check, not a held-out
estimate of research-document accuracy. Small records and explicit labels are
easier than real sources. Greedy model execution is not guaranteed deterministic;
model IDs do not prove identical weights, hardware or server versions. Server
settings beyond FREE's explicit request are not controlled. There is no semantic
paraphrase gold, human adjudication study, uncertainty estimate or modality-only
causal comparison. PDF/parse hashes, raw results and strict denominators make
those limitations inspectable.

Next experiments: paired length/overlap ablations with observed multiple contexts;
seed and layout replication; contradictions in separate value contexts; controlled
OCR degradation with paired native/scanned inputs; and a second instruction model
on the same frozen parse. Register each change and include failed cells before
drawing conclusions.
