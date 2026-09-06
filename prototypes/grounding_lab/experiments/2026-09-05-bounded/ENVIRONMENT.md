# Observed environment

Recorded during the 2026-09-05 bounded Conrad development runs:

- Local grounding: NVIDIA GeForce RTX 4090, 24,564 MiB, driver 616.64.
- Windows 11 build 26200; Python 3.13.15; PyTorch 2.13.0+cu130; CUDA available.
- Node 24.19.0; frozen Nemotron repository/revision from the prior freeze.
- Extraction: Spark Ollama 0.32.14 and pinned qwen3.8:27b digest are checked
  before each attempt. Exact configuration, source/schema/code hashes,
  requests, usage and finish status are stored with each attempt.

Attempt 3 discovery began after attempt 2's last Spark response was saved.
Attempt 2 was finishing its local E replay at that point; the Spark and local
grounding devices are separate. No two extraction calls from these attempts
were deliberately run concurrently on Spark. This is one development source,
not a warmed repeated latency benchmark; model load/warmup is included in
each arm's E replay timer. Cache state and external Spark workload are not
controlled. Report observed sample counts, not production tail estimates.
