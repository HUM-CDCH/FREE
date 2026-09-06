# Completion validation — 2026-09-05

The experiment is complete. No production integration, automatic acceptance,
new reranker sweep, push or merge was performed.

- **95 Python tests pass:** `python-tests.log`.
- **10 Node tests pass:** `node-tests.log`.
- **Freeze verification passes:** 17 code/schema/instruction/development-data
  hashes and all four original PDF hashes. Full request bindings and pinned
  model/version/configuration checks are in `REPRODUCIBILITY.md`.
- **Label integrity passes:** 2,687 distinct blind claims cover all 2,709
  populated values across six usable typed outputs, including two diagnostic
  failures. Both independent passes, all 326 adjudications, anchor IDs and
  final label coverage validate. Five judgments remain unresolved. Actor and
  artifact hashes are in `labeling_runs.json`; machine checks are in
  `validation.json`. Labels are model-generated, not human ground truth.
- **Gold isolation passes:** frozen E inputs contain only unlabelled claims;
  their paths and typed values match raw emissions exactly. Predictions omit
  label-dependent outcome fields. No holdout labels changed thresholds,
  features, risk coefficients, schemas, prompts or quote matching.
- **Failure ledger passes:** eight physical calls, four runner-valid
  completions and four failed attempts, all retained. No retry or source
  substitution. Beier loses untouched status because of prior record overlap.
- **Pruning completes negatively:** all nine warmed rotated runs succeed;
  16,764 anchors preserve original IDs/text/order/scoring context. Retain E.

Natural-output validation results are intentionally distinct from code tests:

| Family | Baseline | Quote |
|---|---|---|
| Beier | Pass | Expected failure: 25 records |
| Bosch | Expected failure: 21 records | Expected failure: incomplete, output limit |
| Wiermann | Pass | Expected failure: incomplete, output limit |
| Kirsch | Pass | Pass |

The `natural-validation-*.log` files retain all warnings and errors. Complete
typed over-limit emissions are fully labeled without changing failed metadata.
The two truncated outputs have no usable label set and remain explicit
missing-label/incomplete-output errors. No usable output has missing labels.
Unsupported lexical prevalence is a distribution statistic for natural output;
the stricter selection condition still applies to constructed challenge sets.

Core scoring timers exclude risk-sidecar computation and outcome serialization.
`WORKFLOW_TIMINGS.md` and `workflow-timings.json` preserve broader observed
file-boundary spans and their hashes, including that overhead. They are
reconstructed phase sums with explicit exclusions, not production request
measurements. Sample counts accompany all p50/p95/p99 figures.

Re-run implementation checks from `prototypes/grounding_lab`:

```powershell
.venv/Scripts/python.exe -X utf8 -m unittest discover -s tests
node --experimental-strip-types --test scripts/dump-anchors.test.mts scripts/quote-extraction.test.mts scripts/diagnostic-output.test.mts
.venv/Scripts/python.exe -X utf8 -m grounding_lab.holdout_evaluation experiments/2026-09-05 verify
.venv/Scripts/python.exe -X utf8 -m grounding_lab.holdout_report experiments/2026-09-05
```

Keep archived workflow timestamps when moving or cloning the artifacts;
filesystem modification times need not survive a clone. No frozen input or
blind packet should be overwritten to make a validation failure disappear.
