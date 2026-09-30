# Cumulative cell-budget fix, 2026-09-30

Status: verified reproducibility fix; production strategy selection remains
incomplete. Production defaults, extraction methods, evaluator, adapter,
dataset selection and all eight held-out groups are unchanged. No development
extraction was run. The prior two-hour continuation remains closed.

## Frozen implementation

- Stacked base: `16819c72cf1ef54bfdf73d4159c5ee65dce048f8`.
- Prior audit checkpoint: `7c18adca3514d926e2998d5ec387aab5a777b5cd`.
- Implementation: `6e540f5fc464dfbdca47e02f69bd7166b0dd06ee`.
- Source digest: `e92370ea9c1ba7c0ff9d8362ad0bb0c8cd183e4fbc367f4db0d0972ba3222663`.

[Verification](verification.json) pins all 100 source files and the test sources.
Only `experiments/harness/model.py` and `study.py` differ from the continuation's
source manifest. The complete code diff was reviewed. Direct optional
`scipy`/`jsonschema` experiment dependencies remain declared and installed.
All 107 previously pinned private development artifacts still match their
original hashes; historical manifests and scores were preserved.
Those scores retain their original code attribution; this revision adds no
benchmark results. Future execution must register the changed code fingerprint.
The [pinned dataset manifest](../../2026-09-30-extractbench-selection.json)
remains the same 12-development/eight-held-out source-group selection.

## Behavior and verification

The executor used to recreate the entire cell allowance on each attempt. It now
subtracts prior fresh calls and token charges while retaining per-attempt usage
and replays separately. Finished attempts persist their token charge, including
reservations retained after unknown usage. Partial usage preserves the existing
conservative charge: reported tokens plus the unresolved full reservation.

Legacy known usage remains chargeable without rewriting its files. A legacy
attempt with unknown usage and a configured token cap refuses resumption when
its reservation was not recorded. An unfinished attempt likewise requires
reconciliation. A cell whose own budget is exhausted may seal a partial artifact;
coverage and budget errors remain visible, as before.

Five regression cases failed before the fix, each sending two new requests on
resume instead of the permitted one. They pass after the fix, including a new
provider reading the persistent cache. Four additional cases cover legacy and
unfinished attempts. The frozen implementation passed **169 fast checks and
two live-provider tests**. The bounded synthetic smoke made **four fresh calls,
617 input / 854 output tokens**, no unknown usage, and one verified replay;
wall time was 110.895 seconds. These calls are separate from benchmark spending.
The existing Qwen model, revision, image and served context matched prior pins.
The temporary SSH tunnel was closed afterward.

## Implication for production

Retain FREE's current schema-guided workflow with canonical source evidence and
human review, following the [product contract](../../../../README.md). No new
research arm is ready to replace the current path on this evidence.

The [paired smoke results](../README.md) cover only three groups: A2/A3 had
pooled raw F1 .4549/.4444 versus A0 .4085, but every arm had zero completely
correct repeated records. Illinois adds only A0, so its .57 raw/.78 canonical
F1 cannot establish an ablation effect. Long-document truncation, schema fidelity,
native-text ingestion failures and transfer to FREE catalogues remain unresolved.
The accounting fix makes future spending enforceable; it adds no quality evidence.

Continue under the existing [final protocol proposal](../final-protocol-proposal.md):
resolve development task validity and ingestion, collect paired development
evidence, then freeze A0 versus one challenger before a separately authorized
holdout comparison. The [human-gold plan](../../2026-09-30-extraction-harness-methods.md)
is still needed for FREE catalogue suitability. A new development time/call cap
must be agreed before more inference; unused historical calls do not renew time.
The withdrawn pilot and guidance proposals in the earlier
[sparring decision](../development-audit/sparring-decision.md) remain withdrawn.
Its adapter conclusion was subsequently superseded by the
[schema-fidelity correction](../schema-fidelity-fix/README.md), which documents
the audit's incorrect prose-only Illinois vocabulary premise.

## Reproduction

From `prototypes/parsing_service` with the locked experiment environment:

```bash
export PYTHONPATH=src:.
export HARNESS_PYTHON=/home/gebbaro/Progetti/FREE/prototypes/parsing_service/.venv/bin/python
"$HARNESS_PYTHON" -m pytest -q tests/test_harness_*.py \
  ../../docs/research/2026-09-30-extractbench-validation/development-continuation/test_run_bounded.py \
  -m 'not live_model' --basetemp=/tmp/extractbench-budget-repeat
```

The live tests require the same verified local server and its temporary route;
this command records a reproduction recipe, not new spending authorization:

```bash
KEI_EXTRACT_URL=http://127.0.0.1:18080/v1/chat/completions \
KEI_EXTRACT_MODEL=Qwen/Qwen3.8-27B-FP8 HARNESS_LIVE_COUNTER=vllm \
timeout --signal=INT --kill-after=15s 12m "$HARNESS_PYTHON" \
  -m pytest -q -s tests/test_harness_live.py -m live_model \
  --basetemp=/tmp/extractbench-budget-live-repeat
```

Recorded execution additionally enforced four calls and 3,080 maximum combined
output tokens in an ignored temporary wrapper. Logs, JUnit files and the wrapper
remain ignored; their hashes and sanitized usage are in `verification.json`.
The earlier counterexample helper remains frozen with its original assertions;
use the regression tests above to check the repaired revision.
