## Context

`compose.gpu.yaml` runs one vLLM server per model as a static Compose service: `ocr_model` (Surya), `nuextract_model` and `extraction_model` (Qwen FP8). The Parsing Service's registry (`kei_exp/kie/extract/models.py`) builds two entries from env, `instruct` and `nuextract`. Studio's `deploymentModels` (`api/_deployment_models.ts`) builds two read-only vLLM connections from `FREE_DEPLOYMENT_*`. On baratheon (GB10, 121 GiB unified memory) the operator ran NVFP4+MTP as a separate Compose project and pointed the stack at it with a hand-written overlay. Choosing a different model meant editing that overlay and redeploying.

Every server reserves a fixed memory budget (weights plus `--kv-cache-memory-bytes`). FP8 27B and NVFP4 27B plus NuExtract and Surya fit together today, but every new cached model would need more.

## Goals / Non-Goals

**Goals:**
- Every complete generation model in the cache is selectable for Extraction roles and for Schema & chat, with its state shown.
- Memory is shared dynamically: a model loads when it is used and unloads when idle or evicted.
- One safety boundary: only the gateway holds Docker access, and it launches only cached models with operator argv.
- Studio and kei change as little as possible: both keep talking OpenAI-compatible HTTP to one base URL.

**Non-Goals:**
- Downloading models from the UI (the cache is operator-managed; offline mode stays on).
- On-demand OCR models. `ocr_model` stays static, and the Ingestion Model Choice is unchanged.
- Multi-GPU or multi-host placement, request queueing across models, or fair scheduling between researchers.
- Running several models in one vLLM engine (vLLM serves one model per engine).

## Decisions

**1. A gateway that proxies by `model` and returns 503 while a model is cold, rather than holding requests open.**
Studio's deployment connection and kei's registry each point at one base URL (`http://model_gateway:8000/v1`) and keep sending ordinary OpenAI-compatible requests. A cold start takes minutes (weights plus CUDA graph capture; NVFP4 with MTP is slower), which would outlive HTTP and proxy timeouts if held. So the gateway answers `503 model_starting` + `Retry-After` immediately, and callers that are already DBOS workflows (kei extraction, Studio Schema Suggestion and edit proposals) wait durably with `DBOS.sleep` between retries.
*Alternatives:* hold the request open (simple, but breaks nginx and client timeouts, and a dropped connection loses the wait); a separate start API that callers must call first (two calls on every path, and they race the idle-stop timer). LiteLLM or another router would proxy requests but does not start or stop vLLM containers or know GB10 memory.

**2. Docker API with labelled containers, not Compose services with `scale: 0`.**
The gateway creates containers through the Docker Engine API (Python `docker` SDK). Each container gets the label `free.model-gateway=<project>`, the read-only cache volume, `HF_HUB_OFFLINE=1`, the `app` network, no published ports, GPU device requests, and argv from the profile. Compose cannot add services at runtime for models it does not know at deploy time.
*Alternative:* vLLM's sleep mode or dynamic LoRA. That only offloads within one engine and model, so it cannot serve different base models.

**3. Discovery from the cache, profiles from the operator.**
The listing is scanned from `HF_HUB_CACHE` on each request (cached briefly): `models--*/snapshots/<ref>/config.json` with a generation architecture, and every shard named by `model.safetensors.index.json` present. Launch profiles live in an operator YAML file (`FREE_MODEL_PROFILES`) keyed by repo id and merged over a `default` profile. The file sets `memory_budget`, `max_model_len`, `kv_cache_bytes`, `max_num_seqs`, `speculative_config`, `extra_args` (an allowlisted set of vLLM flags), and `pinned`. Without a profile, `memory_budget` is estimated as weight bytes on disk plus `kv_cache_bytes` plus a fixed overhead.
*Alternative:* list only profiled models. That is safer, but the user asked for every cached model; the estimate plus `unservable` covers the rest.

**4. Admission by declared budgets, not live free memory.**
On GB10 the GPU shares system memory, so "free VRAM" is not reported separately and includes page cache. The gateway sums declared budgets of servers it runs plus the operator reserve (`FREE_MODEL_RESERVED_BYTES`, covering Surya, Postgres and the apps) against `FREE_MODEL_MEMORY_BYTES`, evicts idle LRU servers to fit, and starts one server at a time. In-flight counts come from the proxy itself.
*Alternative:* `nvidia-smi` or `/proc/meminfo` probing. That is not reliable on unified memory and races other starts.

**5. Model keys become repo ids.**
kei's registry entries are keyed by repo id. The adapter is `nuextract` when the id matches `/nuextract/i` (fields role only), otherwise `instruct` (both roles). Defaults come from `FREE_MODEL_DEFAULT` (reasoning, and fields when no NuExtract is configured) and optional `FREE_MODEL_DEFAULT_FIELDS`. `/api/extraction-models` keeps its shape and fills `serving` and the new `state` from the gateway listing. Saved choices `instruct`/`nuextract` map to the configured defaults when a run is admitted, so frozen methods stay reproducible by repo id.

**6. The gateway is a new small Python service.**
`prototypes/model_gateway`: FastAPI + httpx streaming proxy + docker SDK, one process, state in memory (reconstructed from labelled containers on boot). It needs no database: losing the LRU timestamps on restart only delays one idle stop.

## Risks / Trade-offs

- [Docker socket is root-equivalent] → Only the gateway mounts it. Argv is built from profiles, repo ids must match a listed cache entry (validated as `^[\w.-]+/[\w.-]+$` and found on disk), flags in `extra_args` are allowlisted, and no gateway route is exposed through nginx. A socket proxy (e.g. a read/write-filtered `docker-socket-proxy`) limiting it to container create/start/stop/inspect with the label is a follow-up hardening task.
- [Cold start of minutes in the Assistant] → The UI shows loading state. The default model is pinned so the common path is always warm.
- [Thrashing when two researchers alternate between two large models] → Eviction only takes idle servers, and a minimum residency (`FREE_MODEL_MIN_RESIDENCY`, default 5 min) protects a just-started server.
- [Declared budgets wrong → OOM on GB10] → Profiles for known models carry measured budgets. Estimated budgets add headroom, and a start failure marks `failed` with logs instead of retrying in a loop.
- [Extraction run reproducibility] → The run records the repo id it was admitted with. A model that disappears from the cache fails the replay with `model_not_found` instead of substituting.
- [Gateway restart drops in-flight proxied streams] → `restart: unless-stopped`, DBOS steps retry, and running model containers are adopted rather than restarted.

## Migration Plan

1. Ship the gateway behind the GPU overlay, with profiles for the three current models (NVFP4 profile carries MTP, `pinned: true` for the default).
2. Studio reads `FREE_DEPLOYMENT_MODEL_GATEWAY_URL`. kei reads `KEI_MODEL_GATEWAY_URL` and `FREE_MODEL_DEFAULT`. The old `FREE_DEPLOYMENT_INSTRUCT_*`/`KEI_EXTRACT_*` stay honoured for one release when no gateway URL is set (non-GPU and external-endpoint deployments).
3. On baratheon: stop the separate `free-model-nvfp4` project and drop `~/Projects/free-dev-nvfp4.yaml`, because the gateway now launches NVFP4 itself from the same cache volume.
4. Rollback: redeploy the previous image set with `compose.gpu.yaml` from before the change. The gateway's labelled containers are removed by `docker rm -f $(docker ps -aq --filter label=free.model-gateway)`.

## Open Questions

- Should researchers see who is holding a model busy when admission fails, or only that capacity is exhausted? (Privacy between accounts.)
- Should the Assistant prefer waiting, or offer to switch to a serving model? The spec currently forbids substitution.
- Is a per-account limit on starts needed to stop one researcher from cycling models?
- Should the OCR server join the gateway later to free Surya's memory while no scan is processing?
