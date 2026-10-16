# Slopo embedding benchmark

This harness benchmarks four local embedding model families against a fixed
snapshot of the repository's production source code. It calibrates thresholds
on three clone families, evaluates four held-out families, runs Slopo across the
full corpus, and records manually reviewed top-20 cluster precision. Generated
databases and downloaded models live under `work/` and are intentionally ignored.
Every GGUF and the Voyage projection are pinned by repository revision and
SHA-256 in `benchmark.py`; both fresh downloads and cache hits are verified.
Commit this harness and its `results/` artifacts so Git preserves comparisons
between reruns. Retain `work/model-cache/` separately only if avoiding future
model downloads matters.

## Operational FREE pipeline

Run the complete source-only pipeline from the repository root:

```powershell
.\tools\slopo-benchmark\pipeline.ps1 all
```

The command synchronizes Slopo's index, embeds with the three discovery models
selected by the benchmark, embeds with Voyage as a confirmation-only model,
runs Slopo analysis independently at each calibrated threshold, and fuses the
top-50 cluster rankings. `llama-server` is started in embedding mode on an
ephemeral local port for each model and stopped before the next model starts.

Stages may also be run independently. `embed` always synchronizes the index
first, while `analyze` synchronizes it and refuses stale embeddings if source
code changed:

```powershell
.\tools\slopo-benchmark\pipeline.ps1 index
.\tools\slopo-benchmark\pipeline.ps1 embed
.\tools\slopo-benchmark\pipeline.ps1 analyze
.\tools\slopo-benchmark\pipeline.ps1 status
```

Add `-NoCache` to `embed` or `all` to recompute native embeddings. Add
`-DryRun` to inspect the command without changing pipeline state. Generated
state is ignored under `.slopo/pipeline/`. Shared review state is tracked in
`tools/slopo-benchmark/ignores/` and `operational-adjudications.json`; every
embed or analysis run copies the canonical per-model ignores into Slopo's
native run directories. Reviewed negative consensus clusters are excluded from
the operational ensemble while benchmark scoring remains unchanged. The main
outputs are:

- `.slopo/pipeline/results/summary.md` — run summary and per-model counts.
- `.slopo/pipeline/results/consensus.md` — high-confidence queue supported by
  at least two models; review this first.
- `.slopo/pipeline/results/expanded.md` — consensus plus exploratory
  single-model discoveries.
- `.slopo/pipeline/runs/<configuration>/report/` — native Slopo reports for
  each embedding configuration.

The root `slopo.conf.yaml` now provides a Qwen 1024d standalone fallback for
manual Slopo commands. The merged pipeline does not call stock `slopo embed`:
pplx requires its documented tanh/INT8 transform and Voyage requires a learned
projection, neither of which Slopo 0.5.0 can express in YAML. It still uses
Slopo's indexing, database schema, clustering, reranking, ignore files, and
report writer.

Run from the repository root through the checked-in PowerShell entry point:

```powershell
.\tools\slopo-benchmark\rerun.ps1 benchmark
```

It selects Slopo's `uv` Python environment, refreshes the source-only corpus,
runs the four model families, rebuilds the ensemble, and runs the harness tests.
Use `-DryRun` to inspect every command without embedding, `-NoCache` to force
new native embeddings, or `-PythonPath` if Slopo's environment moves. The
wrapper requires Slopo 0.5.0 by default; an intentional runtime upgrade must be
made explicit with `-ExpectedSlopoVersion`. New summaries record the Python,
Slopo, NumPy, and llama.cpp versions. The run produces `results/summary.json`,
`results/summary.md`, and the ensemble reports.

To run only the tests:

```powershell
.\tools\slopo-benchmark\rerun.ps1 test
```

This produces `results/ensemble-summary.json`, `results/ensemble-summary.md`,
and `results/ensemble-review-candidates.md` without re-embedding the corpus.
The fusion keeps every model's clustering independent, matches cluster member
sets, and never unions similarity edges transitively. `consensus_only` is the
recommended high-precision result; `support_first` appends lower-confidence
single-model discoveries when the goal is to surface more clusters.

Start every future blind validation with a new, descriptive ID. For an
installed distribution whose source is already available locally:

```powershell
.\tools\slopo-benchmark\rerun.ps1 validate `
  -ValidationId starlette-2026-08 `
  -SourceRoot path\to\site-packages\starlette `
  -SourceDistribution starlette `
  -SourceVersion 1.0.0
```

The wrapper refuses to reuse an ID, so an old freeze, queue, or result cannot be
silently overwritten. If model execution is interrupted after preparation,
resume it without changing the freeze:

```powershell
.\tools\slopo-benchmark\rerun.ps1 resume -ValidationId starlette-2026-08
```

Review `results/blind-validation-starlette-2026-08-review-queue.md` and fill in
`results/blind-validation-starlette-2026-08-decisions.json`, without opening the
unscored ranking. Then score the frozen run:

```powershell
.\tools\slopo-benchmark\rerun.ps1 score -ValidationId starlette-2026-08
```

For a Git checkout, omit the distribution and version options; the runner pins
the current commit and records whether the checkout is dirty. Omitting all
source options validates the Slopo distribution installed in the selected
Python environment.

The validation workflow freezes the existing per-model thresholds and 0.60 fusion
cutoff before embedding the holdout. Its randomized review queue is the union
of the pplx and consensus top-20 candidates and hides model identity, support,
rank, and similarity. The frozen acceptance gate is at least 20 consensus
candidates and at least 90% precision after every consensus top-20 candidate is
reviewed. Queue entries contain only source locations; inspect their copied code
under `work/blind-validation[-<id>]/corpus/`. Holdout vectors and copied package
source stay under ignored `work/`.

The production-only FastAPI holdout failed (25% consensus P@20 versus the
precommitted 90% gate). The full Slopo repository passed at 95%, but 92 of its
138 files were tests and 54 were fixtures excluded by the production config.
See `results/blind-validation-conclusion.md`: the ensemble is supported as a
FREE-specific calibrated workflow, not as a universal threshold configuration.

Useful entry points:

- `benchmark.py prepare` refreshes the source-only corpus and Slopo index.
- `benchmark.py run` reuses cached native embeddings and rebuilds all metrics.
- `benchmark.py all` performs both steps, downloading and embedding as needed.
- `show_cluster.py <cluster-id>` prints the exact indexed bodies used for review.

Committed evidence includes `labels.json`, `adjudications.json`,
`results/review-candidates.md`, and `results/model-sources.md`. The latter pins
the model revisions and hashes and distinguishes vendor behavior from external
GGUF conversion claims.

Reduced-dimensional Qwen, pplx, and Voyage rows are not all direct stock-Slopo
configurations. The installed llama.cpp build returns native-width vectors even
when the OpenAI request contains `dimensions`, while pplx and Voyage also need
documented output transforms. See the deployment table and verified Qwen config
fragment in `results/summary.md`.
