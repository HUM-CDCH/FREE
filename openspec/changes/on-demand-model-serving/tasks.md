## 1. Model Gateway service

- [ ] 1.1 Scaffold `prototypes/model_gateway` (FastAPI, httpx, docker SDK, pytest), Dockerfile, and a `model_gateway` service in `compose.gpu.yaml` on the `app` network with the Docker socket and the cache volume read-only
- [ ] 1.2 Cache discovery: scan `HF_HUB_CACHE` for complete generation-model snapshots; test with a fixture cache holding generation, OCR, layout and incomplete repos
- [ ] 1.3 Launch profiles: load `FREE_MODEL_PROFILES` YAML, merge over `default`, validate `extra_args` against an allowlist, estimate budgets for unprofiled models; tests for merge, rejection and estimate
- [ ] 1.4 Server lifecycle: create/start/stop labelled containers (offline env, read-only cache, GPU request, no published ports); health polling; `failed` with retained log tail and backoff; adopt or remove labelled containers on boot
- [ ] 1.5 Admission: budget sum with reserve, LRU eviction of idle non-pinned servers past minimum residency, one start at a time, `model_capacity_exhausted` and `unservable`; unit tests with a fake Docker client
- [ ] 1.6 Idle stop timer and pinned models started at boot
- [ ] 1.7 OpenAI-compatible surface: `GET /v1/models` with state, streaming proxy for chat/completions with in-flight counting, `404 model_not_found`, `503 model_starting` + `Retry-After`, `503 model_failed`
- [ ] 1.8 Safety test: request fields, headers and malformed ids never reach argv, image, mounts or env; only labelled containers are touched

## 2. Parsing Service (kei)

- [ ] 2.1 `kie/extract/models.py`: registry keyed by repo id from the gateway listing (adapter derived from `/nuextract/i`), defaults from `FREE_MODEL_DEFAULT`/`FREE_MODEL_DEFAULT_FIELDS`; keep the env-only registry when no gateway URL is set
- [ ] 2.2 Map saved `instruct`/`nuextract` choices to repo ids at run admission and record the repo id on the run
- [ ] 2.3 Extraction model calls: on `503 model_starting` wait durably (`DBOS.sleep`, `Retry-After`) up to the start timeout, then fail with the gateway code; no substitution
- [ ] 2.4 `/api/extraction-models`: list gateway models with roles, `serving` and `state`; tests

## 3. Studio

- [ ] 3.1 `api/_deployment_models.ts`: one reserved *Deployment model cache* vLLM connection from `FREE_DEPLOYMENT_MODEL_GATEWAY_URL`, default route from the gateway default; legacy `FREE_DEPLOYMENT_INSTRUCT_*` fallback when unset; tests
- [ ] 3.2 Discovery for that connection returns gateway models with state; contract updates in `shared/modelConfig.contract.ts` and `shared/extraction.contract.ts`
- [ ] 3.3 Provider calls: Schema Suggestion and edit-proposal workflows wait durably on `model_starting`; capacity and failure codes surface as operation failures
- [ ] 3.4 Assistant: loading state while the routed model starts, then send; no substitution
- [ ] 3.5 `ModelsTab.tsx`: state labels, stopped/starting/failed selectable with first-use note, `unservable` disabled, NuExtract only for fields; component tests and an e2e case against a fake gateway

## 4. Deployment and docs

- [ ] 4.1 `compose.gpu.yaml`: replace `extraction_model`/`nuextract_model` with `model_gateway`; wire `KEI_MODEL_GATEWAY_URL`, `FREE_DEPLOYMENT_MODEL_GATEWAY_URL`, `FREE_MODEL_*`; dependencies on the gateway's health instead of the model servers
- [ ] 4.2 Ship default profiles for Qwen3.8-27B-FP8, Qwen3.8-27B-NVFP4 (MTP, pinned) and NuExtract3-FP8 with measured budgets
- [ ] 4.3 `scripts/free.mjs` and `pnpm test:safety`: render and validate the gateway config; assert no other service mounts the Docker socket and no nginx location reaches the gateway
- [ ] 4.4 Update `README.md` (safety contract), `docs/operations/deployment.md` (budgets, profiles, rollback) and `CONTEXT.md` (Model Gateway, Deployment model cache)
- [ ] 4.5 Baratheon cutover: deploy, verify each cached model starts on first use and evicts as specified, then retire the `free-model-nvfp4` project and the `free-dev-nvfp4.yaml` overlay
