## Why

The DGX Spark's Hugging Face cache holds several generation models (Qwen3.8-27B-FP8, Qwen3.8-27B-NVFP4 with MTP, NuExtract3-FP8), but a researcher can choose only the one instruction model and the one NuExtract server the operator wired into the environment (`KEI_EXTRACT_*`, `FREE_DEPLOYMENT_*`). Switching models today means an operator hand-editing a Compose overlay and redeploying, and every server the operator wants selectable must stay resident in the GB10's shared 121 GiB, even while idle. Researchers comparing models on the same sources need every cached model to be selectable, while the hardware can keep only a few of them loaded at a time.

## What Changes

- A new **Model Gateway** service owns the deployment's generation-model vLLM servers. It discovers the generation models in the shared Hugging Face cache, starts a model's server when a request names that model, admits starts against an operator memory budget, stops idle servers, and proxies OpenAI-compatible requests to the right server by the request's `model` field.
- The gateway is the only component with Docker access. It launches only cached models (offline, no downloads), from one operator-configured vLLM image, with argv built from operator launch profiles (e.g. MTP speculative decoding for NVFP4). Nothing a researcher sends reaches the command line or the image choice.
- While a model is cold, the gateway answers `503 model_starting` with its progress instead of holding the connection. Extraction and Schema Suggestion workflows wait durably for it; the Assistant shows the researcher that the model is loading.
- kei's extraction-model registry lists every gateway model instead of one `instruct` entry plus NuExtract. A run's Extraction Model Choice names a cached model (by repo id) for each role; a NuExtract model takes only the `fields` role.
- Studio's deployment connections gain one read-only *Deployment model cache* vLLM connection whose discovery lists every cached model with its serving state. Schema & chat and the Assistant can route to any of them; the NuExtract protocol is still derived from the model id.
- The Model Configuration page shows each cached model's state (serving, starting, stopped) in the *Schema & chat* and *Extracting data* steps. A stopped model is selectable; a model larger than the whole budget is shown but cannot be selected.
- **BREAKING (operators)**: `compose.gpu.yaml` replaces the static `extraction_model` and `nuextract_model` services with `model_gateway`. `KEI_EXTRACT_URL`/`KEI_EXTRACT_MODEL`, `KEI_NUEXTRACT_*` and `FREE_DEPLOYMENT_INSTRUCT_*`/`FREE_DEPLOYMENT_NUEXTRACT_URL` are superseded by the gateway URL and a default-model setting. The OCR server (`ocr_model`) stays static.

## Capabilities

### New Capabilities
- `on-demand-model-serving`: the Model Gateway: cache discovery, launch profiles, memory admission and eviction, idle stop, proxying by model id, cold-start status, and its safety boundary (Docker access, offline cache only, fixed image).

### Modified Capabilities
- `model-connection-configuration`: deployment vLLM connections come from the Model Gateway (one connection that lists every cached model with its state) instead of fixed `FREE_DEPLOYMENT_*` servers; the *Schema & chat* and *Extracting data* steps list cached models with serving state and allow stopped ones.
- `capability-route-resolution`: the unset-route default becomes the gateway's default model; a route to a cold gateway model waits for it (or reports `model_starting`) rather than failing as unreachable.

## Impact

- **New service**: `prototypes/model_gateway` (container with the Docker socket, private `app` network only), plus `compose.gpu.yaml`, `scripts/free.mjs` (GPU overlay wiring), `docs/operations/deployment.md` and `README.md` (deployment and safety contract).
- **Parsing Service**: `kei_exp/kie/extract/models.py` (dynamic registry from the gateway), `kei_exp/api.py` (`/api/extraction-models` lists gateway models and their state), the extraction step's model-wait handling, `kei_exp/kie/extract/llm.py` defaults.
- **Studio**: `api/_deployment_models.ts`, `api/_provider.ts` (cold-start handling), `api/extraction_models.ts`, `shared/modelConfig.contract.ts` / `shared/extraction.contract.ts` (serving state), `src/providerConfig/ModelsTab.tsx` and the Assistant UI.
- **Operations**: GPU memory is now shared dynamically, so a cold start can evict an idle model. A first request to a stopped model waits minutes (weights load plus CUDA graph capture). Existing saved Extraction Model Choices that name `instruct`/`nuextract` need mapping to repo ids.
- **Security**: Docker socket access is equivalent to root on the host. It is confined to the gateway, which accepts only cached model ids and builds argv itself.
