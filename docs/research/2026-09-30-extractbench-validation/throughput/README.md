# Spark extraction-harness throughput comparison

2026-09-30. Synthetic inference performance experiment, separate from the
ExtractBench validation study. No benchmark source, annotations, saved responses,
study budgets or holdout are read by the benchmark or modified.

A [discarded setup attempt](setup-attempt/README.md) is preserved separately.
It detected an annotation-normalization difference at the request boundary;
the corrected complete comparison is not pooled with that attempt.

## Measured conclusion

**No material reduction in decode throughput was detected from the harness in this controlled synthetic comparison.** Bypassing the harness and starting a fresh bare `vllm serve` container both retain the observed 7.8–7.9 output tokens/sec regime. This finding applies to the pinned Spark build and checkpoint at concurrency one; it does not establish a particular hardware or kernel bottleneck.

Medians of three measured calls per condition (warmups excluded):

| Condition | Input / actual output tokens per call | Server TTFT (s) | Decode tokens/s | Client E2E (s) |
| --- | ---: | ---: | ---: | ---: |
| Direct HTTP, existing server | 530 / 429 | 0.299 | 7.821 | 55.060 |
| Direct HTTP, clean server | 530 / 429 | 0.292 | 7.806 | 55.177 |
| Full harness, clean server, no response cache | 530 / 429 | 0.288 | 7.806 | 55.320 |

The harness and clean direct median decode rates differ by only **+0.0044%**. The fresh direct server is **0.189% slower** than the existing server in these trials. Neither comparison provides evidence of an inference penalty attributable to the harness or existing container state. Three sequential samples do not support a statistical equivalence claim or a conclusion about tiny effects.

Harness median client E2E is **0.143 s higher (+0.259%)** than direct HTTP to the same clean server. Within individual harness calls, measured non-HTTP client work ranges from **0.046 to 0.379 s**, median **0.073 s** (mean 0.166 s). This includes two served-tokenizer admission/budget calls, harness processing, instrumentation and the synthetic artifact write. It is real client overhead, while decode remains approximately 54.8 seconds. The short experiment does not isolate those overhead components.

All 12 final requests have the same completion-body SHA-256 (`0e739561f285ba1952771921153326143a101b0e683533d13d3b00d977550d36`) and identical returned message content. All stop normally at **429 actual generated tokens**, below the 512-token cap. Each has 530 actual input tokens. All four full-harness artifacts contain one fresh call, zero replayed calls, one valid response and no issues. All measured requests have zero preemptions and zero cached prompt tokens/prefix-cache hits.

Final experiment spending: **12 fresh calls**, 6,360 input tokens and 5,148 output tokens; 3,861 output tokens belong to the nine measured requests and 1,287 to the three warmups. The separately archived setup attempt is excluded. No optimizations were applied or proposed on the basis of these small samples.

### Individual measured requests

| Condition | Trial | Actual output tokens | Server TTFT (s) | Decode tokens/s | Client E2E (s) |
| --- | ---: | ---: | ---: | ---: | ---: |
| Direct HTTP, existing server | 1 | 429 | 0.316 | 7.821 | 55.060 |
| Direct HTTP, existing server | 2 | 429 | 0.299 | 7.825 | 55.041 |
| Direct HTTP, existing server | 3 | 429 | 0.284 | 7.820 | 55.199 |
| Direct HTTP, clean server | 1 | 429 | 0.292 | 7.801 | 55.197 |
| Direct HTTP, clean server | 2 | 429 | 0.285 | 7.807 | 55.138 |
| Direct HTTP, clean server | 3 | 429 | 0.326 | 7.806 | 55.177 |
| Full harness, clean server, no response cache | 1 | 429 | 0.288 | 7.806 | 55.592 |
| Full harness, clean server, no response cache | 2 | 429 | 0.284 | 7.806 | 55.320 |
| Full harness, clean server, no response cache | 3 | 429 | 0.290 | 7.810 | 55.221 |

Warmups, excluded from the summary:

| Condition | Actual output tokens | Server TTFT (s) | Decode tokens/s | Client E2E (s) |
| --- | ---: | ---: | ---: | ---: |
| Direct HTTP, existing server | 429 | 0.885 | 7.820 | 55.636 |
| Direct HTTP, clean server | 429 | 0.849 | 7.799 | 55.786 |
| Full harness, clean server, no response cache | 429 | 0.281 | 7.806 | 55.176 |

Raw rows are in [measurements.csv](measurements.csv); all before/after counter values are in [all-results.json](all-results.json). Descriptive statistics are reproducible with `python summarize.py`; see [summary.json](summary.json). Measurement boundaries and pinned primary references are in [measurement-sources.md](measurement-sources.md).

## Deployment identity and model-name check

- Image: `sha256:8ca4c87cf4ec334bee35ac29c6bc30bf43760f17735b308ddff49dcb5fda2daa`. The fresh container uses this exact Spark-compatible image with an explicit `vllm serve` entrypoint, not a separately upgraded engine or image.
- vLLM: `0.29.1rc1.dev17+gd2d649e67.d20260913`; PyTorch: `2.13.0+cu130`; Transformers: `5.17.0`.
- Cached snapshot: `017b9c7af6b5689d5dd426a76e0bc077eb5ca20a`; same volume `free_parsing-models`, same resolved blob files and inodes. All safetensors files total 30,866,866,928 bytes; this includes components not exercised by text generation.
- Served context: **32,768 tokens**; `--max-num-seqs 4` retained on the server, actual request concurrency **1**. GPU-memory utilization 0.35, fixed 8 GiB KV cache, language-model-only and vLLM generation defaults retained.
- No explicit `--served-model-name` alias is configured. The model launch argument, API `id` and API `root` all equal `Qwen/Qwen3.8-27B-FP8`. Thus no vLLM served-name override was found. The cached config declares `Qwen3_5ForConditionalGeneration` / `qwen3_5` (`qwen3_5_text` inside text config). Architecture naming alone does not establish publisher provenance or justify relabeling the checkpoint; the cached revision and file identities are the comparison pins.

See [cache-and-version.json](cache-and-version.json), [clean-cache-and-version.json](clean-cache-and-version.json), [client-and-code.json](client-and-code.json) and the per-condition `*-models.json` files. The two cache/version manifests compare exactly equal.

## Restoration and evidence verification

[restoration-verified.json](restoration-verified.json) confirms all ten original
containers retain their IDs, images, entrypoints, arguments, mounts, restart
policies, device requests, IPC and shared-memory settings. All are running;
every configured healthcheck is healthy. Nginx responds with its HTTP 308 redirect, and the
experimental container has been removed. No original container was recreated.

The immediate automatic check in `restoration.json` returned false because
Docker changed the ordering of nginx's mount array. Each mount itself is
unchanged. The independent verifier compares mounts by destination and confirms
the deployment matches. [benchmark-executed.py](benchmark-executed.py) preserves
the exact script used for the final measurements. The current `benchmark.py`
also refuses a pre-existing experimental container name and removes only the
full container ID created by its invocation. These post-measurement corrections
change no captured results. Pre-review helper bytes and the original integrity
manifest are preserved in `helpers-before-review/` for attribution, not execution.

Verify readiness and recompute the summaries read-only with:

```bash
/home/gebbaro/Progetti/kei-exp/.venv/bin/python \
  docs/research/2026-09-30-extractbench-validation/throughput/verify_restoration.py
/home/gebbaro/Progetti/kei-exp/.venv/bin/python \
  docs/research/2026-09-30-extractbench-validation/throughput/summarize.py
```

Both commands print results without rewriting this archive. Their optional
`--output NEW_DIRECTORY` flag writes new copies and refuses an existing directory.
The summary command compares its recomputation with the saved summary; it never
regenerates an integrity manifest. Do not run archived pre-review helpers.

`integrity.json` records current top-level evidence-file checksums. The preserved
pre-review manifest distinguishes later helper changes from measured data.
`client-and-code.json`
pins the executed harness modules; their hashes were checked again after the
experiment. At measurement completion, this directory was the only worktree
change. Existing study records, benchmark datasets and holdout were unchanged.

## Protocol and reproducibility

Run from the extraction-harness worktree root with an environment containing
the parsing service's dependencies. The environment used here is
`/home/gebbaro/Progetti/kei-exp/.venv/bin/python` (Python 3.13).

For a repeat, choose a **new** directory at the same nesting depth. The command
below refuses to truncate an existing log. It is an example for a separate future
experiment; do not run it alongside the development study.

```bash
set -eC
export THROUGHPUT_RUN=docs/research/2026-09-30-throughput-repeat/run
mkdir -p "$(dirname "$THROUGHPUT_RUN")"
mkdir "$THROUGHPUT_RUN"
cp docs/research/2026-09-30-extractbench-validation/throughput/benchmark.py \
  "$THROUGHPUT_RUN/benchmark.py"
/home/gebbaro/Progetti/FREE/prototypes/parsing_service/.venv/bin/python -u \
  "$THROUGHPUT_RUN/benchmark.py" > "$THROUGHPUT_RUN/run.log" 2>&1
```

The script refuses an existing `deployment-before.json` and checks that its
experimental container name is unused before stopping anything. Its output
directory is its own location. If Docker creation fails without returning a full
container ID, no container is removed by name; inspect and reconcile the attempt.
The
deployment and image checks deliberately fail if the pins have changed.
`commands.log` records every actual remote command; SSH uses
`ssh -F /home/gebbaro/.ssh/config -o BatchMode=yes baratheon` to bypass a
local system SSH configuration permission error.

Conditions run serially: direct HTTP to the existing container; direct HTTP to
a new Docker container; the full `run_case` harness against that new container.
Each condition gets one warmup and three measured requests, concurrency one,
maximum 512 generated tokens. The fixed input is eight fabricated inventory
records. `synthetic.json` contains the source, schema and effective harness
configuration; `request.json` is the exact completion body.

The harness itself builds the prompts and reply schema, including the adapter's
removal of FREE-only `x-free-type` annotations. An offline preflight first captures
the full runner's exact HTTP body without sending a request. All completion requests
must compare equal to the saved body at the HTTP boundary, including temperature
zero, seed 20260930, `enable_thinking=false`, strict JSON-schema response format,
no logprobs, and no streaming. Requests use the same client dependency, machine
and SSH transport; they bypass nginx and Studio. Direct calls exclude harness
processing. Harness calls include served-tokenizer admission, budget accounting,
JSON/schema validation, evidence checks, merge and artifact assembly. Recovery
and subdivision are disabled so each trial sends exactly one inference request.

`NoResponseCache` overrides both `Provider.lookup` and `Provider.store`. Passing
`cache=None` alone would **not** disable the provider's in-memory cache. Each
trial asserts one fresh completion, zero replayed calls and no cached replies.
Server prefix caching retains the deployment default in every condition;
each warmup uses the identical prompt. Actual prefix hits are checked in the
saved metrics rather than assumed from repeated input. This preserves the
distinction between response replay and prefill reuse.
[vLLM prefix-cache documentation](https://docs.vllm.ai/en/latest/features/automatic_prefix_caching/).

Before inference, the script checks that resident model request queues are idle,
then stops app ingress, parsing workers and the two other vLLM containers.
After the existing-container measurements it stops that engine too, confirms
no `VLLM::EngineCore` remains, and starts the experimental container. Only one
inference engine is resident during a condition. Desktop display processes
remain. GPU process snapshots are preserved in `gpu-*.json`.

The new container runs the original entrypoint `vllm serve`, exact image ID,
GPU device access, 2 GiB shared memory and all original engine arguments. It
mounts the same Docker model-cache volume at the same path and adds the pinned
revision and offline Hugging Face flags. It downloads no weights and installs
no packages. The existing and clean cache manifests must compare equal,
including snapshot revision, resolved blob paths, file sizes, inodes and
config checksum. vLLM, PyTorch and Transformers versions must also match.

The `finally` block removes only the experimental container ID it created, then starts the
original containers without recreating them. `deployment-before.json`,
`deployment-after.json` and `restoration.json` record original IDs, image IDs,
arguments, mounts, restart policies and restored running state. Cold restarts
can take several minutes to become healthy; readiness is verified separately.

If the client is forcibly killed before `finally` can run, first inspect
`created-container.json` in that run directory and verify its full ID, image and
name against Docker. Use that ID for removal; do not remove a container by the
shared example name. Then restart only originals listed in that run's snapshot:

```bash
ssh -F /home/gebbaro/.ssh/config baratheon \
  docker start free-extraction_model-1 free-ocr_model-1 free-nuextract_model-1
ssh -F /home/gebbaro/.ssh/config baratheon \
  docker start free-parsing_service-1 free-parsing_worker-1 free-studio-1 free-nginx-1
```

The database and Phoenix containers are never stopped. These recovery commands
apply only to the containers listed as originally running in the snapshot.

## Measurement definitions

Responses remain non-streaming to exercise the real harness adapter unchanged.
TTFT is therefore **server TTFT**, not first-byte latency at the client, and is
obtained from the isolated request's increase in
`vllm:time_to_first_token_seconds_sum`. For a non-streaming completion the
client receives the answer after generation finishes; first response byte would
not measure first token.

Actual prompt/output token counts come from response `usage`, cross-checked
against `/tokenize` and the server's generation-token counter. Decode time is
the request's increase in `vllm:request_decode_time_seconds_sum`, from first
generated token to last generated token. Decode throughput is `(N-1)/decode_time`,
where N is actual generated tokens; the first token belongs to prefill.
`vllm-stats-source.py` records the deployed implementation behind these metrics.
These are engine timings, not a re-tokenization of displayed JSON. See also
[vLLM benchmark metric definitions](https://docs.vllm.ai/en/latest/benchmarking/cli/).

End-to-end latency is measured with the client's monotonic clock: direct request
start through complete response and minimal decoding; harness entry through
the complete prediction artifact. The latter currently includes writing its
small synthetic artifact to this evidence directory. A separate HTTP E2E timer
allows that overhead to be examined. Metrics polling, deployment startup and
warmup are excluded from measured-request E2E.

Every request preserves raw metric counters before and after. A trial fails
if there is not exactly one completion, one TTFT observation and one decode
observation, or if token totals disagree. Raw response, request hash,
finish reason and harness prediction artifacts are recorded per trial.
Results retain warmups separately; conclusions use only three measured calls
per condition and cannot establish long-context or concurrent serving behavior.
