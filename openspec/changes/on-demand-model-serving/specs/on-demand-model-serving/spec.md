## ADDED Requirements

### Requirement: The gateway lists the generation models in the deployment's cache
The Model Gateway SHALL list as available every model in the shared Hugging Face cache that has a complete snapshot and a generation architecture (a `*ForCausalLM` or `*ForConditionalGeneration` entry in its `config.json`), identified by its repo id. It SHALL NOT list OCR models served by the OCR server, layout or other non-generation models, or incomplete downloads. Each listed model SHALL carry its state (`stopped`, `starting`, `serving` or `failed`), its memory budget, and whether it uses the NuExtract protocol (repo id matches `/nuextract/i`). The listing SHALL be re-read from the cache, not frozen at boot.

#### Scenario: Cached generation models are listed
- **WHEN** the cache holds complete snapshots of `Qwen/Qwen3.8-27B-FP8`, `nvidia/Qwen3.8-27B-NVFP4` and `numind/NuExtract3-FP8`, plus `docling-project/docling-layout-heron` and `datalab-to/surya-ocr-2`
- **THEN** the gateway lists exactly the three generation models, each with its state and memory budget

#### Scenario: An incomplete download is not listed
- **WHEN** a repo's snapshot lacks `config.json` or a weight file named by its index
- **THEN** the gateway does not list it

#### Scenario: A model added to the cache appears without a restart
- **WHEN** an operator downloads a new generation model into the cache
- **THEN** the next listing includes it with state `stopped`

### Requirement: The gateway serves an OpenAI-compatible endpoint routed by model id
The gateway SHALL expose `GET /v1/models` (the listing) and proxy `POST /v1/chat/completions` and `POST /v1/completions` to the vLLM server that serves the request's `model`, streaming responses unchanged. A request for a model that is not listed SHALL fail with `404 model_not_found`. A request for a listed model that is not `serving` SHALL start it if admission allows, and SHALL answer `503 model_starting` with a `Retry-After` header and the model's state, without holding the connection open for the cold start.

#### Scenario: A serving model is proxied
- **WHEN** a chat completion names a model whose server is `serving`
- **THEN** the gateway forwards it to that server and returns its response, streamed when requested

#### Scenario: A stopped model is requested
- **WHEN** a chat completion names a listed model whose state is `stopped`
- **THEN** the gateway starts its server and answers `503 model_starting` with `Retry-After`
- **AND** a later request after the server becomes healthy is proxied

#### Scenario: An unknown model is requested
- **WHEN** a request names a model that is not in the listing
- **THEN** the gateway answers `404 model_not_found` and starts nothing

### Requirement: Launches use operator profiles, the cache only and one image
The gateway SHALL start each model in its own container from the single operator-configured vLLM image, with the cache mounted read-only and Hugging Face offline mode set, so that a start never downloads. The server argv SHALL come only from the operator's launch profile for that repo id, merged over a default profile (context length, KV-cache bytes, max sequences, speculative decoding such as MTP, and memory budget). No value from a request other than the selected listed repo id SHALL reach the image, argv, mounts or environment. Containers SHALL join only the private application network and publish no host port.

#### Scenario: A profile enables MTP for one model
- **WHEN** the operator profile for `nvidia/Qwen3.8-27B-NVFP4` sets MTP with five speculative tokens
- **THEN** that model's server starts with that speculative configuration and others start without it

#### Scenario: A model without a profile
- **WHEN** a listed model has no operator profile
- **THEN** it starts with the default profile

#### Scenario: A request tries to influence the launch
- **WHEN** a request carries extra fields, headers or a model id with path or shell characters
- **THEN** the gateway either rejects the id as not listed or launches the listed repo with its profile argv only

### Requirement: Starts are admitted against a memory budget
The gateway SHALL admit a start only if the memory budgets of the servers it runs plus the new model's budget fit within the operator's total budget, after subtracting the reserve for static servers (the OCR server). If they do not fit, it SHALL stop idle servers, least recently used first, until the new model fits. A server is idle when it has no in-flight request. Pinned models SHALL never be stopped for admission. If the model cannot fit even then, the request SHALL fail with `503 model_capacity_exhausted`, naming the servers that are busy. A model whose budget exceeds the total budget SHALL be listed as `unservable`. At most one server SHALL start at a time, because vLLM profiles free memory on start.

#### Scenario: An idle model is evicted to admit another
- **WHEN** the FP8 model is serving and idle, the budget fits only one 27B model, and a request names the NVFP4 model
- **THEN** the gateway stops the FP8 server and then starts the NVFP4 server

#### Scenario: Busy servers block admission
- **WHEN** every running server has an in-flight request and the new model does not fit
- **THEN** the request fails with `503 model_capacity_exhausted` and no server is stopped

#### Scenario: Two cold models are requested together
- **WHEN** requests for two stopped models arrive at the same time
- **THEN** the gateway starts them one after another, never concurrently

### Requirement: Idle servers stop and pinned servers stay
The gateway SHALL stop a non-pinned server after it has had no request for the operator's idle timeout. Servers named as pinned (e.g. the default instruction model) SHALL start when the gateway starts and SHALL NOT be stopped by idle timeout or admission. A server that fails its health check during start SHALL become `failed`, with the tail of its log retained for operators. The next request for it SHALL retry the start at most once per backoff interval.

#### Scenario: An unused model stops
- **WHEN** a non-pinned server receives no request for the idle timeout
- **THEN** the gateway stops it and lists it as `stopped`

#### Scenario: A pinned model is kept
- **WHEN** the default model is pinned and idle beyond the timeout
- **THEN** it keeps serving

#### Scenario: A start fails
- **WHEN** a model's server exits or never becomes healthy within the start timeout
- **THEN** the model is listed as `failed` and requests for it answer `503 model_failed` until the backoff interval passes

### Requirement: The gateway is the only holder of Docker access
Only the gateway container SHALL mount the Docker socket. It SHALL create, inspect and remove only containers carrying its own management label. Studio, the Parsing Service and the browser SHALL reach it only over the private application network, and no gateway endpoint SHALL be routed through nginx. On restart the gateway SHALL adopt or remove labelled containers it finds instead of leaking them.

#### Scenario: Unlabelled containers are untouched
- **WHEN** the gateway evicts or cleans up servers
- **THEN** it acts only on containers with its management label

#### Scenario: The gateway restarts while servers run
- **WHEN** the gateway restarts with labelled model containers running
- **THEN** it adopts healthy ones as `serving` and removes unhealthy ones
