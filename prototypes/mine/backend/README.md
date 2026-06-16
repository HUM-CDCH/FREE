# FREE extraction backend

FastAPI backend for the document extraction prototype.

## Model endpoint configuration

The backend reads model settings from environment variables with the
`NUEXTRACT3_` prefix. By default it uses local Ollama at
`http://127.0.0.1:11434` and calls Ollama's OpenAI-compatible
`/v1/chat/completions` endpoint.

### Local Ollama

```env
NUEXTRACT3_PROVIDER=ollama
NUEXTRACT3_BASE_URL=http://127.0.0.1:11434
NUEXTRACT3_MODEL=hf.co/numind/NuExtract3-GGUF:Q4_K_M
```

### KU Spark Ollama

```env
NUEXTRACT3_PROVIDER=ollama
NUEXTRACT3_BASE_URL=http://spark.cdch-dgxspark.lan.ku.dk:11434
NUEXTRACT3_MODEL=hf.co/numind/NuExtract3-GGUF:Q4_K_M
```

### Docker Model Runner with NuExtract3 GGUF

```env
NUEXTRACT3_PROVIDER=openai
NUEXTRACT3_BASE_URL=http://127.0.0.1:12434/engines/v1
NUEXTRACT3_MODEL=hf.co/numind/NuExtract3-GGUF:mmproj
NUEXTRACT3_API_KEY=EMPTY
```

This uses Docker Model Runner's OpenAI-compatible API. The NuExtract3 GGUF
model is served by Docker Model Runner's `llama.cpp` backend or auto-routed
through `/engines/v1`; it does not require the Docker Model Runner `vllm`
backend.

Before starting the backend, apply the Compose model configuration:

```sh
docker compose up -d
```

`compose.yaml` provisions the model with a 4096-token context and partial GPU
offload so it can run on 4 GiB GPUs. The backend still reads its runtime
settings from its own environment, but Docker Model Runner needs the Compose
configuration before the first model request.

If `http://127.0.0.1:12434/engines/v1` is not reachable from the host, make
sure Docker Model Runner is enabled with TCP host access and started:

```sh
docker model status
curl http://127.0.0.1:12434/engines/v1/models
```

`docker model status` may initialize and start the standalone model runner on
first use. If chat requests return `500 Internal Server Error` with CUDA
out-of-memory logs that mention `--ctx-size 262144` or `-ngl 999`, rerun
`docker compose up -d` so Docker Model Runner applies the low-memory model
configuration before the backend calls it.

### vLLM or another OpenAI-compatible endpoint

```env
NUEXTRACT3_PROVIDER=vllm
NUEXTRACT3_BASE_URL=http://127.0.0.1:8000/v1
NUEXTRACT3_MODEL=your-safetensors-model
NUEXTRACT3_API_KEY=EMPTY
```

Use this only for a real vLLM-compatible server. Docker Model Runner's vLLM
backend requires a Safetensors model and supported NVIDIA/CUDA hardware; GGUF
NuExtract3 models should use the Docker Model Runner example above.

`NUEXTRACT3_PROVIDER=openai` and `NUEXTRACT3_PROVIDER=vllm` both select the
backend's OpenAI-compatible adapter.

`NUEXTRACT3_API_KEY` is optional. The backend omits the `Authorization`
header when the value is empty or `EMPTY`, which lets local Ollama and the
Spark endpoint work without placeholder bearer tokens.
