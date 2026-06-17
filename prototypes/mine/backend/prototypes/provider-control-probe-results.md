# NuExtract Provider Control Probe Results

Date: 2026-06-17

This document records the one-shot probe used to decide where NuExtract
extraction controls should be sent for different OpenAI-compatible providers.
It is intended to make the run reproducible from a clean checkout and to
preserve the exact operational evidence behind the provider recommendations.

## Question

NuExtract-style runtimes can receive extraction controls in two places:

1. Message text: the user message includes the extraction instruction,
   extraction template, and source document.
2. `chat_template_kwargs`: the request body includes structured controls such
   as `mode`, `enable_thinking`, and `template`.

The backend should not blindly send the same NuExtract controls in both places.
Doing that can hide provider behavior and creates ambiguity when message text
and `chat_template_kwargs` disagree. The probe checks which single channel works
for each provider, and which channel wins if both are sent with conflicting
templates.

## Probe Script

Script:

```powershell
prototypes\probe_provider_controls.py
```

Compile check:

```powershell
.venv\Scripts\python.exe -m py_compile prototypes\probe_provider_controls.py
```

The current probe sends three `/chat/completions` requests for each NuExtract
workflow that FREE uses: structured extraction, content extraction, schema
suggestion, and markdown. That is 12 requests per provider.

| Case | Message content | `chat_template_kwargs` | Expected success signal |
| --- | --- | --- | --- |
| `kwargs_only` | Source document, plus natural-language schema-suggestion guidance where that is task input | NuExtract controls for the workflow | `kwargs_probe_channel` or `KWARGS_CHANNEL_MARKER` |
| `message_only` | Source document plus workflow instructions | Omitted | `message_probe_channel` or `MESSAGE_CHANNEL_MARKER` |
| `conflict` | Message text asks for the message signal | Kwargs ask for the kwargs signal | Used to infer precedence |

Workflow-specific kwargs:

| Workflow | Kwargs mode |
| --- | --- |
| Structured extraction | `mode: structured`, `template` |
| Content extraction | `mode: content`, `instructions` |
| Schema suggestion | `mode: template-generation` |
| Markdown | `mode: markdown` |

The sentinel document value is:

```text
CONTROL_VALUE_7391
```

Structured extraction and schema suggestion expect valid JSON containing the
relevant key. For example:

```json
{"kwargs_probe_channel": "CONTROL_VALUE_7391"}
```

The probe uses the backend's existing `model_headers()` helper, so API key
handling is the same as the provider layer.

The 2026-06-17 code update expanded the probe matrix and verified the script
with:

```powershell
.venv\Scripts\python.exe -m py_compile prototypes\probe_provider_controls.py
.venv\Scripts\python.exe prototypes\probe_provider_controls.py --dry-run
```

The historical live observations below were gathered with the earlier
structured-extraction matrix. Re-run the expanded probe before treating
workflow-specific local behavior as current.

## Environment

Run directory:

```powershell
E:\progetti\FREE\prototypes\mine\backend
```

Python:

```powershell
.venv\Scripts\python.exe
```

Tested providers:

| Provider | Endpoint | Model |
| --- | --- | --- |
| Ollama OpenAI-compatible API | `http://127.0.0.1:11434/v1` | `hf.co/numind/NuExtract3-GGUF:Q4_K_M` |
| Docker Model Runner | `http://127.0.0.1:12434/engines/v1` | `huggingface.co/numind/nuextract3-gguf:Q4_K_M` |
| Docker vLLM | `http://127.0.0.1:8000/v1` | `numind/NuExtract3` |

## Result Summary

| Provider | `kwargs_only` | `message_only` | Conflict winner | Recommended single-channel format |
| --- | --- | --- | --- | --- |
| Ollama | Failed | Passed | Message | Message text only |
| Docker Model Runner | Passed | Passed | Message | Either single channel works; use one channel only |
| Docker vLLM | Passed | Passed | Message | Either single channel works; use one channel only |

Practical interpretation:

- Ollama should use message-embedded NuExtract controls. The OpenAI-compatible
  Ollama endpoint did not apply the NuExtract template from
  `chat_template_kwargs` in this probe.
- Docker Model Runner and Docker vLLM both accepted a kwargs-only NuExtract
  template and also accepted a message-only template.
- When Docker Model Runner or Docker vLLM received conflicting message and
  kwargs templates, the response followed the message-embedded template.
- To avoid double instructions, choose one channel per provider. For
  NuExtract-aware Docker Model Runner or vLLM serving, `chat_template_kwargs`
  is a valid single-channel format. For Ollama, use message text.
- If both channels are sent accidentally, do not assume
  `chat_template_kwargs` is authoritative. In the tested Docker providers,
  message text won the conflict probe.

## Ollama Reproduction

Prerequisite: Ollama is running locally and the NuExtract3 GGUF model is
available under this model name:

```text
hf.co/numind/NuExtract3-GGUF:Q4_K_M
```

Command:

```powershell
.venv\Scripts\python.exe prototypes\probe_provider_controls.py `
  --provider ollama `
  --base-url http://127.0.0.1:11434 `
  --model hf.co/numind/NuExtract3-GGUF:Q4_K_M `
  --pretty `
  --timeout 240 `
  --max-tokens 512
```

Observed behavior:

```text
kwargs_only:
  raw_text: The probe value is CONTROL_VALUE_7391.
  parsed_json: null
  success: false

message_only:
  parsed_json: {"message_probe_channel": "CONTROL_VALUE_7391"}
  success: true

conflict:
  parsed_json: {"message_probe_channel": "CONTROL_VALUE_7391"}
  message key present: true
  kwargs key present: false
```

Probe recommendation:

```json
{
  "event": "recommendation",
  "strategy": "message_only",
  "reason": "message-embedded controls produced the expected key/value and won the conflict probe."
}
```

Conclusion: use message text for Ollama. Do not rely on
`chat_template_kwargs` alone with this Ollama OpenAI-compatible endpoint.

## Docker Model Runner Reproduction

Prerequisite: Docker Model Runner is running.

Model inventory command:

```powershell
Invoke-RestMethod -Uri http://127.0.0.1:12434/engines/v1/models -TimeoutSec 5 |
  ConvertTo-Json -Depth 4
```

Observed models:

```text
huggingface.co/numind/nuextract3-gguf:Q4_K_M
huggingface.co/numind/nuextract3-gguf:mmproj
```

Status details observed during the run:

```text
Docker Model Runner: running
llama.cpp backend: running
vllm backend: not installed; only supported on Linux
```

Docker Model Runner was not visible as a normal application container in
`docker ps`; it was exposed through Docker Desktop's model runner endpoint.

Probe command:

```powershell
.venv\Scripts\python.exe prototypes\probe_provider_controls.py `
  --provider openai `
  --base-url http://127.0.0.1:12434/engines/v1 `
  --model huggingface.co/numind/nuextract3-gguf:Q4_K_M `
  --api-key EMPTY `
  --pretty `
  --timeout 300 `
  --max-tokens 512
```

Observed behavior:

```text
kwargs_only:
  parsed_json: {"kwargs_probe_channel": "CONTROL_VALUE_7391"}
  success: true

message_only:
  parsed_json: {"message_probe_channel": "CONTROL_VALUE_7391"}
  success: true

conflict:
  parsed_json: {"message_probe_channel": "CONTROL_VALUE_7391"}
  message key present: true
  kwargs key present: false
```

Probe recommendation:

```json
{
  "event": "recommendation",
  "strategy": "both_single_channel",
  "reason": "both single-channel probes worked; the conflict probe followed message-embedded controls."
}
```

Conclusion: Docker Model Runner can use `chat_template_kwargs` as the only
NuExtract control channel. Message-only also works. Avoid sending both because
the conflict probe followed message text, so duplicated controls can make stale
message instructions override structured kwargs.

## Docker vLLM Reproduction

### Initial State

The expected vLLM endpoint was initially not listening:

```powershell
Invoke-RestMethod -Uri http://127.0.0.1:8000/v1/models -TimeoutSec 5
```

The request failed because nothing was serving on port 8000.

### Docker Hub Image Issue

The official Docker Hub image could not be pulled in this environment:

```powershell
docker run --name nuextract-vllm-probe --rm -d --gpus all -p 8000:8000 --ipc=host `
  vllm/vllm-openai:latest `
  --model numind/NuExtract3 `
  --trust-remote-code
```

Failure:

```text
unauthorized: authentication required
```

The same failure occurred with:

```powershell
docker run --name nuextract-vllm-probe --rm -d --gpus all -p 8000:8000 --ipc=host `
  vllm/vllm-openai:v0.23.0-cu129-ubuntu2404 `
  --model numind/NuExtract3 `
  --trust-remote-code
```

and with an explicit pull:

```powershell
docker pull --platform linux/amd64 vllm/vllm-openai:v0.23.0-cu129-ubuntu2404
```

Docker was not logged in:

```text
Username=<no value>
Mirrors=[]
```

### Working Image

The NVIDIA NGC image was accessible:

```text
nvcr.io/nvidia/vllm:26.03.post1-py3
```

The first startup attempt failed while loading the NuExtract tokenizer:

```text
ValueError: Tokenizer class TokenizersBackend does not exist or is not currently imported.
```

Diagnosis command:

```powershell
docker run --rm nvcr.io/nvidia/vllm:26.03.post1-py3 python3 -c "import transformers, tokenizers; print('transformers', transformers.__version__); print('tokenizers', tokenizers.__version__); import transformers; print(hasattr(transformers, 'TokenizersBackend'))"
```

Observed output:

```text
transformers 4.57.5
tokenizers 0.22.2
False
```

Installing `transformers==5.5.4` inside the disposable container made the
NuExtract tokenizer load:

```powershell
docker run --rm nvcr.io/nvidia/vllm:26.03.post1-py3 bash -lc 'python3 -m pip install -q --upgrade "transformers==5.5.4" && python3 -c "import transformers, tokenizers; print(\"transformers\", transformers.__version__); print(\"tokenizers\", tokenizers.__version__); from transformers import AutoTokenizer; tok=AutoTokenizer.from_pretrained(\"numind/NuExtract3\", trust_remote_code=True); print(type(tok)); print(tok.__class__.__module__)"'
```

Observed output included:

```text
transformers 5.5.4
tokenizers 0.22.2
<class 'transformers.tokenization_utils_tokenizers.TokenizersBackend'>
transformers.tokenization_utils_tokenizers
```

The command also emitted a dependency warning because this vLLM image pins
`transformers==4.57.5`. For this probe, the patched disposable container was
good enough to serve the model and complete the provider-control test.

### Start vLLM

Final successful startup command:

```powershell
docker run --name nuextract-vllm-probe -d --gpus all -p 8000:8000 --ipc=host `
  nvcr.io/nvidia/vllm:26.03.post1-py3 `
  bash -lc 'python3 -m pip install -q --upgrade "transformers==5.5.4" && vllm serve numind/NuExtract3 --trust-remote-code --chat-template-content-format openai --generation-config vllm --max-model-len 16384 --limit-mm-per-prompt "{\"image\":6,\"video\":0}" --gpu-memory-utilization 0.7'
```

Startup took a long time. The run downloaded model files into the container and
the Hugging Face cache reached about 8.7 GB. The model was ready only after logs
like these:

```text
Model loading took 8.61 GiB memory and 753.166113 seconds
Starting vLLM API server 0 on http://0.0.0.0:8000
```

Readiness check:

```powershell
Invoke-RestMethod -Uri http://127.0.0.1:8000/v1/models -TimeoutSec 5 |
  ConvertTo-Json -Depth 6
```

Observed ready model:

```text
id: numind/NuExtract3
max_model_len: 16384
```

### Probe vLLM

Command:

```powershell
.venv\Scripts\python.exe prototypes\probe_provider_controls.py `
  --provider vllm `
  --base-url http://127.0.0.1:8000/v1 `
  --model numind/NuExtract3 `
  --api-key EMPTY `
  --pretty `
  --timeout 300 `
  --max-tokens 512
```

Observed behavior:

```text
kwargs_only:
  parsed_json: {"kwargs_probe_channel": "CONTROL_VALUE_7391"}
  success: true

message_only:
  parsed_json: {"message_probe_channel": "CONTROL_VALUE_7391"}
  success: true

conflict:
  parsed_json: {"message_probe_channel": "CONTROL_VALUE_7391"}
  message key present: true
  kwargs key present: false
```

Probe recommendation:

```json
{
  "event": "recommendation",
  "strategy": "both_single_channel",
  "reason": "both single-channel probes worked; the conflict probe followed message-embedded controls."
}
```

Conclusion: vLLM can use `chat_template_kwargs` as the only NuExtract control
channel when served with the NuExtract chat template. Message-only also works.
Avoid duplicated controls because message text won the conflict probe.

### Cleanup

Stop and remove the probe container:

```powershell
docker stop nuextract-vllm-probe
docker rm nuextract-vllm-probe
```

Verify no matching container remains:

```powershell
docker ps -a --filter name=nuextract-vllm-probe
```

Verify port 8000 is no longer serving vLLM:

```powershell
Invoke-RestMethod -Uri http://127.0.0.1:8000/v1/models -TimeoutSec 5
```

After cleanup, the readiness request should fail with connection refused.

## Backend Policy Suggested By The Probe

Use provider-specific single-channel request construction:

| Provider family | Suggested control placement |
| --- | --- |
| Ollama OpenAI-compatible NuExtract3 GGUF | Message text only |
| Docker Model Runner NuExtract3 GGUF | `chat_template_kwargs` only |
| vLLM NuExtract3 | `chat_template_kwargs` only |

The important rule is not "kwargs are always better" or "message prompts are
always better". The rule is: send exactly one authoritative NuExtract task
control channel for a given provider. Official NuExtract examples use
`chat_template_kwargs` for the supported workflows, while local Ollama evidence
showed kwargs-only controls were not applied there. The backend therefore uses
message text for Ollama and `chat_template_kwargs` for vLLM/OpenAI-compatible
providers, with thinking/reasoning left as a generation control.

## Troubleshooting Notes

### `kwargs_only` returns plain source text

This happened with Ollama. It means the endpoint accepted the request but did
not apply the NuExtract extraction template from `chat_template_kwargs`. Use
message text for that provider.

### vLLM `/v1/models` connection refused

The vLLM server is not ready or is not running. Check:

```powershell
docker ps --filter name=nuextract-vllm-probe
docker logs nuextract-vllm-probe --tail 80
```

The model can take more than 10 minutes to download and load.

### vLLM response ended prematurely

This can happen while the server process is still starting or while model load
is in progress. Wait for the log line that starts the API server, then retry:

```text
Starting vLLM API server 0 on http://0.0.0.0:8000
```

### `Tokenizer class TokenizersBackend does not exist`

The NGC vLLM image used here included `transformers 4.57.5`, while NuExtract3's
tokenizer expected `TokenizersBackend`. The disposable workaround was to install
`transformers==5.5.4` before starting vLLM.

This is a probe workaround, not necessarily a production serving image
recommendation. A production image should pin a mutually compatible vLLM,
Transformers, tokenizer, CUDA, and NuExtract model combination.

### Docker Hub vLLM image is unauthorized

In this environment, pulling `vllm/vllm-openai` from Docker Hub failed with
`unauthorized: authentication required`. The NGC image was used instead.

### Docker Model Runner vLLM backend says only Linux is supported

Docker Model Runner still served the GGUF model through its `llama.cpp` backend
on this Windows Docker Desktop setup. The built-in Docker Model Runner vLLM
backend was not used for this probe.
