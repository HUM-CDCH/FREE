# FREE Vite Prototype

Minimal FREE prototype with a Vite/React frontend and Vercel API functions under `api/`.

## Commands

From the repository root:

```bash
pnpm install
pnpm start
pnpm --filter studio test
pnpm --filter studio build
```

The full prototype expects the parsing service at `http://127.0.0.1:8000` and Studio at `http://localhost:5173`. `pnpm --filter studio vercel:dev` serves the frontend and `/api/*` routes together.

## Supported provider profiles

Extraction selects its provider only from `AI_PROVIDER`; it does not infer capability from model names and never silently reroutes Catalog or Article extraction. Conversational chat is configured independently:

```bash
AI_CHAT_PROVIDER=ollama
AI_CHAT_MODEL=gemma4:26b-a4b-it-qat
AI_CHAT_BASE_URL=http://spark.cdch-dgxspark.lan.ku.dk:11434
```

The default chat endpoint is VPN-only and does not require an API key. These `AI_CHAT_*` settings do not alter NuExtract schema generation or extraction.

### Local Catalog — Ollama

Use the official NuExtract3 `Q4_K_M` profile, or an operator-qualified better profile:

```bash
AI_PROVIDER=ollama
AI_MODEL=hf.co/numind/NuExtract3-GGUF:Q4_K_M
AI_BASE_URL=http://127.0.0.1:11434
AI_NUM_CTX=32768 # optional positive integer
```

`AI_NUM_CTX` is omitted from the raw Ollama request when unset. Invalid, zero, negative, fractional, or unsafe values fail configuration validation clearly.

### Article — Spark Ollama

Point the same raw Ollama-compatible boundary at a capable Spark host and use Q4_K_M or better:

```bash
AI_PROVIDER=ollama
AI_BASE_URL=http://spark.cdch-dgxspark.lan.ku.dk:11434
AI_API_KEY=... # optional when the host requires it
AI_MODEL=hf.co/numind/NuExtract3-GGUF:Q4_K_M
AI_NUM_CTX=65536 # optional positive integer sized for the host
```

### Article — authenticated Codex CLI

Install Codex CLI 0.144 or newer and run `codex login` first:

```bash
AI_PROVIDER=codex-cli
AI_MODEL=<authenticated-codex-model>
```

Codex CLI owns context configuration; `AI_NUM_CTX` applies only to Ollama raw requests.

## Explicit live smoke lanes (not CI)

These commands are opt-in and are not part of ordinary `pnpm test`:

```bash
RUN_NUEXTRACT_CATALOG_SMOKE=1 \
AI_PROVIDER=ollama \
AI_MODEL=hf.co/numind/NuExtract3-GGUF:Q4_K_M \
pnpm --filter studio exec vitest run api/extract.catalog.smoke.test.ts

RUN_ARTICLE_SMOKE=1 \
AI_PROVIDER=codex-cli \
AI_MODEL=<authenticated-codex-model> \
pnpm --filter studio exec vitest run api/extract.article.smoke.test.ts

# Alternative Article lane through a configured Spark Ollama host:
RUN_ARTICLE_SMOKE=1 \
AI_PROVIDER=ollama \
AI_BASE_URL=<spark-url> \
AI_API_KEY=<if-required> \
AI_MODEL=hf.co/numind/NuExtract3-GGUF:Q4_K_M \
AI_NUM_CTX=<positive-int> \
pnpm --filter studio exec vitest run api/extract.article.smoke.test.ts
```

The Catalog lane uses Source Context containing Grav 8 and 13 while the verbatim schema metadata contains the conflicting Grav 17 example. The Article lane requires schema-shaped values and canonical table Evidence.
