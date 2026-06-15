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

### Docker Model Runner or another OpenAI-style endpoint

```env
NUEXTRACT3_BASE_URL=http://127.0.0.1:12434/engines/v1
NUEXTRACT3_MODEL=hf.co/numind/NuExtract3-GGUF:mmproj
NUEXTRACT3_API_KEY=EMPTY
```

`NUEXTRACT3_API_KEY` is optional. The backend omits the `Authorization`
header when the value is empty or `EMPTY`, which lets local Ollama and the
Spark endpoint work without placeholder bearer tokens.
