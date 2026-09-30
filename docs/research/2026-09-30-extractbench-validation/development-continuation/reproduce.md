# Reproduce or audit the continuation

Run from this branch's `prototypes/parsing_service`, with `PYTHONPATH=src:.`.
The installed interpreter used for execution was
`/home/gebbaro/Progetti/FREE/prototypes/parsing_service/.venv/bin/python`.
The environment and 100 source-file hashes are in [launch-manifest.json](launch-manifest.json).
Production source, model and parser settings were unchanged during the continuation.

The commands below describe recorded operations; they do not authorize additional
generation or a fresh budget. Preserve existing outputs. The original twelve-group
population and eight held-out groups remain in the parent [selection](../../2026-09-30-extractbench-selection.json).
The derived [selection](selection.json) contains exactly its nine non-smoke
development representatives, not replacements chosen from predictions.

## Offline verification and final audit

```bash
export PYTHONPATH=src:.
export HARNESS_PYTHON=/home/gebbaro/Progetti/FREE/prototypes/parsing_service/.venv/bin/python
export HARNESS_RUN="$PWD/../../.scratch/extractbench-v2-development"
export TMPDIR="$PWD/../../.scratch/tmp"

"$HARNESS_PYTHON" -m pytest -q tests/test_harness_*.py \
  ../../docs/research/2026-09-30-extractbench-validation/development-continuation/test_run_bounded.py \
  -m 'not live_model' --basetemp="$TMPDIR/continuation-tests-repeat"

"$HARNESS_PYTHON" \
  ../../docs/research/2026-09-30-extractbench-validation/development-continuation/audit_continuation.py \
  "$HARNESS_RUN" "$PWD/../../.scratch/continuation-audit-repeat"
```

Choose a new audit output path. The audit sends **zero model or tokenizer requests**.
It reuses evaluator v2, checks the source/configuration/provider pins, reconstructs
every permitted request from inference-only inputs, reconciles the request journal
with cached responses, and reports actual usage for unfinished cells separately
from scores for sealed cells. Recovery halves are checked against their exact
source-only construction, rather than being mistaken for a configuration change.
Raw/refined evidence counts remain separate and semantic support remains unavailable.
The output also includes all 48 development cells in one CSV: blocked, unrun and
unsealed cells keep empty scores. Population counters distinguish scored results
from complete source-region coverage. No pooled ranking uses unequal completed subsets.

The audit refuses an active run. A watcher's `runner_exited` record proves that its
pidfd observed exit. A `terminated_at_wall_cap` record proves only signal delivery;
if that occurs, first confirm exit in the runner's **host process namespace**, then
save `runner-exit-confirmed.json` with `runner_exited: true`, the observed PID and
timestamp. Do not infer exit merely because a sandbox cannot see the host PID.
Never restart inference to repair an interrupted report.

Free-text error details remain in ignored raw artifacts; the public report retains
error codes and hashes. Source PDFs, native text, gold, model replies and request
caches remain under ignored task storage. Both raw and public-report hashes are
recorded. Missing results stay missing; the audit does not turn partial caches
into completed predictions.

## Recorded preparation and execution

The adapter was invoked with the derived development-only manifest and the already
verified pinned JSONL cache. This downloads no held-out PDFs:

```bash
"$HARNESS_PYTHON" -m experiments.harness extractbench \
  ../../docs/research/2026-09-30-extractbench-validation/development-continuation/selection.json \
  ../../.scratch/extractbench-source "$HARNESS_RUN"
```

The same native-line PDFium parser ingested seven sources and rejected two for
pages without native text. The seven gold-as-prediction checks are preserved in
[gold-roundtrips.json](gold-roundtrips.json). The preflight constructed all nominal
requests, counted them using the existing server's `/tokenize`, and sent no
completion requests:

```bash
"$HARNESS_PYTHON" \
  ../../docs/research/2026-09-30-extractbench-validation/development-continuation/preflight.py \
  "$HARNESS_RUN"
```

A supplemental [parser check](parser-reproduction.json), recorded after ingestion,
pins 51 installed parser files including `libpdfium.so`. Re-parsing all twelve
development PDFs (218 pages) reproduced every saved native-source hash and parser
metadata record exactly, including both failures. No held-out PDF was read. To
repeat that source check without extraction:

```bash
"$HARNESS_PYTHON" - <<'PY'
import hashlib, json
from pathlib import Path
from experiments.harness.extractbench import parse_native
from kei_exp.canonical import canonical_json
for phase in ('smoke', 'development'):
    root = Path('../../.scratch/extractbench-v2-' + phase)
    manifest = json.loads((root / 'adapter-manifest.json').read_text())
    for record in manifest['documents']:
        pdf = root / 'pdfs' / (record['source_id'].replace('/', '--') + '.pdf')
        assert hashlib.sha256(pdf.read_bytes()).hexdigest() == record['pdf_sha256']
        passages, parser = parse_native(pdf)
        assert hashlib.sha256(canonical_json(passages)).hexdigest() == record['source_sha256']
        assert parser == record['parser']
print('All twelve development native sources reproduced; no inference.')
PY
```

For this preparation, `study.json` pointed at the seven-case `dataset.json`.
Preflight wrote the six-case `admitted-dataset.json`; the excluded DD1155 source
needed 68 calls per arm, above the unchanged 60-call cell cap. The committed
[study.json](study.json) is the resulting execution study, copied locally as
`execution-study.json`. The launch manifest pins that file, preflight, runner,
resolved dataset, source, evaluator, environment and provider. The runner refuses
any pin mismatch before generation.

The SSH route used for this execution was:

```bash
ssh -F /home/gebbaro/.ssh/config -o BatchMode=yes -o ExitOnForwardFailure=yes -N \
  -L 127.0.0.1:18080:172.18.0.4:8000 baratheon
```

That address is an observed container IP, not a model identity. The model snapshot,
image ID and server versions must match the launch manifest. The route connects
to the existing local server; no deployment/container settings are changed.

The initial command, launched as an independent host process with logs in the task
directory, was:

```bash
"$HARNESS_PYTHON" \
  ../../docs/research/2026-09-30-extractbench-validation/development-continuation/run_bounded.py \
  "$HARNESS_RUN" --hours 8
```

The later user answer superseded that default with a two-hour wall cap measured
from the original start. The independently running [timer](enforce_runtime_cap.py)
stops new requests at 105 minutes and allows a 15-minute drain; see the exact
[amendment and command](runtime-cap-amendment.md). It does not reset the 400-call
allowance, refund the historical 37 smoke calls, reorder cases, change requests,
or open the holdout. The full 24-cell admitted matrix is not guaranteed to finish.
