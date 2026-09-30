# Reproduction, 2026-09-30

The original twelve cells executed at
`2a2b6d4586179919accbae7800d5071a7df6cb00`; use that revision in a separate
checkout for the same implementation bytes. Final tests use
`677ec96f6fc0765d0396df977098b0d373ac0edb`. Its only pinned-source difference
is the failed-request unknown-usage counter. Results are nondeterministic even
with the recorded seed; hashes identify implementations, not a promise of identical
new generations. Do not merge or reset the stacked research branch to reproduce.

Run at the harness worktree's Parsing Service directory. Use its locked Python
plus the optional `experiments` dependencies. The commands below explicitly
activate that environment; system `python` is not a substitute.
The recorded execution used the already-installed repository `.venv`, whose
versions are in each output manifest. Set `PYTHONPATH=src:.` and choose
`HARNESS_DATA` on a filesystem with quota; do not use an unverified `/tmp` cache.

```bash
export PYTHONPATH=src:.
export HARNESS_DATA="$PWD/../../.scratch/extractbench-reproduction"
mkdir -p "$HARNESS_DATA/snapshot" "$HARNESS_DATA/tmp"
export TMPDIR="$HARNESS_DATA/tmp"
export UV_CACHE_DIR="$HARNESS_DATA/uv-cache"
uv sync --python 3.13.12 --frozen --extra experiments
source .venv/bin/activate
python -m pytest -q tests/test_harness_*.py -m 'not live_model' \
  --basetemp="$HARNESS_DATA/pytest"
```

Download the three **pinned** JSONLs using the committed selection manifest. Their
annotation columns remain evaluator-only; the adapter never decodes held-out gold.
No additional evaluation package is installed.

```bash
python - <<'PY'
import json, os, urllib.request
from pathlib import Path
selection = json.loads(Path('../../docs/research/2026-09-30-extractbench-selection.json').read_text())
cache = Path(os.environ['HARNESS_DATA']) / 'snapshot'
for source in selection['dataset_files']:
    path = cache / source['path']
    if not path.exists():
        urllib.request.urlretrieve(source['url'], path)
PY
python -m experiments.harness extractbench \
  ../../docs/research/2026-09-30-extractbench-selection.json \
  "$HARNESS_DATA/snapshot" "$HARNESS_DATA/smoke" --smoke
cp ../../docs/research/2026-09-30-extractbench-validation/study-smoke.json \
  "$HARNESS_DATA/smoke/study.json"
python -m experiments.harness run "$HARNESS_DATA/smoke/study.json" \
  "$HARNESS_DATA/smoke/out" --split dev
```

The saved provider URL is a loopback SSH tunnel to the existing deployment Qwen
server, not a paid API. Re-establish that route to the recorded model/revision and
confirm the server identity before execution; a different server is a new study.
No deployment service is restarted. The original route was loopback port 18080 to
`extraction_model:8000` on the existing deployment network. No credential is saved
in study artifacts. The provider identity includes the observed model snapshot,
container image, vLLM, torch and transformers versions.

For the observed deployment, the route was established in a second terminal with
the following command. Check the current container IP and pinned deployment
identity first: an IP alone does not identify model bytes.

```bash
ssh -F "$HOME/.ssh/config" -o BatchMode=yes -N \
  -L 127.0.0.1:18080:172.18.0.7:8000 baratheon
```

```bash
python -m experiments.harness run "$HARNESS_DATA/smoke/study.json" \
  "$HARNESS_DATA/smoke/out" --split dev --execute
python -m experiments.harness compare "$HARNESS_DATA/smoke/study.json" \
  "$HARNESS_DATA/smoke/out" "$HARNESS_DATA/smoke/report-v2.json" --split dev
```

First verify the smoke gates in `protocol.md`. The remaining-development command
omits `--smoke`, which still selects only development representatives. Use a new
data/output directory, retain only the other nine cases in its study dataset, and
use the frozen second-phase study with its 400-call allowance. Never increase the
combined 500-call allowance to work around a failure. Failed native-text ingestion
or an over-budget projection is a reported gate failure. The adapter has no holdout
execution switch; the study leaves `final` unset.

The recorded screen did **not** open this second phase: one interrupted request's
usage remained unknown. Its conservative budget charge and attribution are in
`interruption-reconciliation.json`. Preserve that incident when auditing total
operational spending; replays do not erase it. The frozen 400-call second-phase
study is a reservation, not evidence that its nine cases ran.

Final provider test (synthetic test data, separate from development metrics):

```bash
KEI_EXTRACT_URL=http://127.0.0.1:18080/v1/chat/completions \
KEI_EXTRACT_MODEL=Qwen/Qwen3.8-27B-FP8 HARNESS_LIVE_COUNTER=vllm \
python -m pytest -q -s -m live_model tests/test_harness_live.py \
  --basetemp="$HARNESS_DATA/live-tests"
```

Original pilots are available in the operator's existing `free-harness-evidence`
archive, directories `harness-final2`, `harness-ids`, and `harness-big`. Copy only
the required study/dataset/canonical-source/cell files into task-owned storage;
originals remain immutable. Then, for each archive:

```bash
python -m experiments.harness compare PILOT/study.json PILOT/out \
  PILOT/report-evaluator-v2.json --split dev --rescore
```

Reports are write-once. This performs no provider calls. Integrity checks bind
cells to the original study, source, schema, gold and artifact hashes; reports record
current evaluator/code and original evaluation identities. `rescore-integrity.json`
records the preserved source hashes and new full-report hashes. A clean rerun uses
a new report path, not overwriting the historical result.

The two small scripts beside this note audit **this frozen smoke archive**; they
are not an alternative evaluator or a general dataset runner. From the service
directory at the final research/evidence commit on `feat/extraction-research-harness`,
whose source bytes equal `677ec96f` and which also contains these helpers and the
reference report, with the original ignored task data still available, run:

```bash
python ../../docs/research/2026-09-30-extractbench-validation/audit_smoke.py \
  ../../.scratch/extractbench-v2-smoke "$HARNESS_DATA/original-audit"
python ../../docs/research/2026-09-30-extractbench-validation/replay_check.py \
  ../../.scratch/extractbench-v2-smoke \
  ../../docs/research/2026-09-30-extractbench-validation/development-smoke-report-v2.json \
  "$HARNESS_DATA/compatibility"
```

The first recomputes scores and verifies saved request/configuration hashes, input
equivalence, gold roundtrips, evidence fields, sealed artifacts and all-attempt
budgets. It makes no model requests. The second obtains the same served identity
and tokenizer, but blocks cache misses and direct completion calls. It compares
all prediction properties except call/token/cost bookkeeping and separately
compares every quality count. It fails unless all twelve cells reproduce with
zero fresh completions and the only pinned source difference is `model.py`.
Use new destination directories: both preserve existing evidence. Neither command
erases the original interruption, opens development expansion, or reads holdout data.

The committed smoke report was generated before the accounting correction; a
fresh audit on the final code truthfully reports that execution/current source
aggregates differ. Evaluator bytes and quality counts are unchanged. The execution
manifest, final replay record and `verification.json` retain both identities.
