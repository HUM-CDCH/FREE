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
- `DEFAULT_CATALOG_POLICY` was flipped after the Beier runs and reverted
  the same day: with coverage evaluated over a shared denominator, the
  candidate fails G4 on Herredsvejen and Hojbakkegaard, and G2 on Hvissinge
  (3 calls against 6). The candidate is `CATALOG_POLICY_V1`, opt-in through
  `FREE_CATALOG_POLICY`. The frozen hashes of `catalog.ts` and `module.ts`
  no longer match (default revert, batch validation and routing-key fixes),
  so the roots are closed; every run passed its policy explicitly and the
  fixes do not change a successful batch's prompt or result.
- The review also corrected the checks: `report.py` evaluates coverage and
  the wrong-anchor rate from the labelled sheet, counts only single calls
  for a slice a rejected batch already carried as fallbacks (the recorded
  runs have none), and `suite.py` refuses an input whose hash differs from
  the frozen one.


## Revision 2: per-record against the candidate on the Danish schema

Pre-registered 2026-09-09 before the first run. The failed transfer gates
were measured with the Beier schema on Danish reports, a schema mismatch.
Astra's `models-policy-v2` root ran the candidate under a Danish grave
schema but never ran the per-record policy, so the gates stay unresolved.

- Input: the five parsed Danish reports frozen in
  `artifacts/catalog-lab/models-policy-v2/inputs/<doc>/baseline/`.
- Schema: `danish` from `models-policy-v2/schemas.ts` (`run.ts --schema danish`,
  now a frozen file).
- Arms: `baseline` (per-record, today's default) and `batch-group-field`
  (`CATALOG_POLICY_V1` exactly). One repetition: Qwen at temperature 0 gave
  byte-identical outputs across repetitions in every recorded run.
- Scoring: `score_danish.py` applies Astra's frozen `references-v1.json`
  and `adjudications-final.json` through `models-policy-v2/score.py`
  unchanged; values or links without a decision are listed as pending and
  adjudicated against the source text in a new decisions file before the
  gates are read. Katrinesminde is reported but excluded from the gates:
  its reference credits eleven graves that the schema tells the model to
  exclude.
- Gates: G1 and G2 as before; G4 on the fixed denominator: correct units
  and supported-link units of the candidate at least the baseline's minus
  5% of the denominator, no more wrong-record or wrong-passage links, no
  more unsupported values.
- Roots: `artifacts/catalog-lab/policy-v1-danish/<doc>/`, frozen per document.

### Revision 2 deviations, recorded after the runs

- The candidate's values on the Danish schema differ from Astra's run of
  the same policy, input and model by one unit on Herredsvejen and
  Hvissinge; local Ollama is not bit-reproducible across processes, so a
  second repetition would have measured that noise, not the policy.
- The two-record batch on Katrinesminde was rejected (the model returned
  `R1` for both records); both records re-ran one per call with the same
  values. G1 would fail there (2 fallbacks of 1 batch), but Katrinesminde
  is not gated.
- The 66 decisions for the per-record arm were made by the agent that ran
  the comparison, with arm labels visible, applying the rules recorded in
  Astra's adjudications (body deposition counts as a stated rite; stones,
  human remains and find inventory numbers are not grave goods; values on
  an unbound record are unsupported).
- `pnpm lint` failed on two unused bindings in `models-policy-v2/run.ts`;
  fixing them changed a file frozen in that root, which was already
  complete (88 of 88 runs, final report written), so that root is closed.
