# Catalog policy v1: protocol

Written before the first frozen run. The question: can the production Catalog
executor make far fewer model calls without losing values or evidence quality,
using only the call-structure changes both labs support? Nothing here accepts
a link automatically, scores a link, or tunes a threshold.

## Policy under test

`CatalogPolicy` in `packages/extraction/src/catalog.ts`, read by Studio from
`FREE_CATALOG_POLICY`:

- `recordBatchSize`: records per values call. Each slice sits under a
  `### Record R<n>` heading; the response must return every identity once, in
  order, or the batch falls back to one call per record.
- `lexicalLinks`: a claim whose value is a bounded token of exactly one
  candidate anchor in its record slice links in code (`verbatim: true`,
  `lexicalHits: 1`) and is not sent to the grounder.
- `groundingGroupSize`: records whose unresolved claims share one grounding
  call. Each claim is validated against its own record's anchors.
- `fieldAwareGrounding`: the grounder receives each claim's record, field
  name and schema description.

Discovery is unchanged. The default policy reproduces today's behaviour.

## Arms

| Arm | batch | lexical | group | field-aware | values model |
|---|---:|---|---:|---|---|
| baseline | 1 | off | 1 | off | qwen3.8 |
| batch-only | 5 | off | 1 | off | qwen3.8 |
| policy-v1 | 5 | on | 5 | on | qwen3.8 |
| policy-v1-b3 | 3 | on | 5 | on | qwen3.8 |
| policy-v1-nuextract | 5 | on | 5 | on | NuExtract3 Q4_K_M |

Two repetitions per arm, arm order rotated across repetitions, requests
serial. Discovery and grounding use `qwen3.8:latest` (27B Q4_K_M) on the
local RTX 4090 through the production Ollama adapter; the Spark server was
not reachable when the experiment started. NuExtract uses the production raw
adapter. Both are the models the production route uses, at their production
settings.

## Inputs

- Beier excerpt: `artifacts/catalog-lab/beier/parsed_document.json`, the
  frozen seven-field `schema.ts`, scored against `beier.reference.json` with
  `evaluate.py` (29 records, 203 values, 164 populated fields).
- Transfer set: the five Danish grave reports under
  `artifacts/catalog-lab/examples-transfer-v1/*/parsed_document.json` with the
  same schema, paired with their existing `prod-qwen-r2` production runs. No
  value reference exists; every populated value of both arms is labelled blind
  (labeller sees only the document text and an unlabelled sheet).

## Gates, fixed before running

- G1 identity: every boundary yields exactly one record in every batch run;
  single-record fallbacks at most 5% of batches.
- G2 calls: non-discovery calls at most 40% of the baseline arm's, on Beier
  and on each Danish document.
- G3 Beier: correct values at least baseline minus one (of 203), supported
  fields at least baseline (of 164), evidence precision at least baseline,
  29 of 29 records.
- G4 transfer: no link into another record; blind-labelled wrong-anchor rate
  at most the baseline's; supported-link coverage at least baseline minus five
  points.
- G5 lexical links: wrong-anchor rate among links made in code at most that
  of links made by the model. If G5 fails, rerun with `lexicalLinks: false`
  and gate again.

A failed gate keeps the default policy unchanged. Passing all gates flips
`DEFAULT_CATALOG_POLICY` to the winning arm; the env override stays.

## Freeze

`suite.py --freeze` records SHA-256 hashes of the harness, the scoring inputs
and the production files the executor imports (`FROZEN_FILES` in `run.ts`)
and refuses to run when any of them changes. Run directories are never
reused; failed runs stay. `report.py` generates `RESULTS.md` from
`result.json` and `evaluate.py`; no number in it is typed by hand.

## Deviations recorded after the runs

- The Spark route was unreachable; every arm ran on the local RTX 4090
  (`qwen3.8:latest`, NuExtract3 Q4_K_M). Seconds are therefore local
  figures, and the ablation arms below shared the GPU with the transfer
  suite, so their seconds are not comparable.
- The pre-registered policy arms failed G3 on Beier (lexical links linked
  the wrong passage on two traps and the remaining grouped claims drew a
  NONE cascade). Five exploratory arms were added to `suite.py` after
  inspecting those runs: `batch-group-field`, `batch-group`,
  `policy-v1-nofield`, `policy-v1-g1`, `policy-v1-g1-nofield`.
  `batch-group-field` passed every Beier gate and was confirmed with two
  further Beier repetitions and one run per Danish report before adoption.
- `DEFAULT_CATALOG_POLICY` was flipped after the runs; the frozen hash of
  `catalog.ts` no longer matches, so this root is closed. Every run passed
  its policy explicitly, so the default did not influence any result.

