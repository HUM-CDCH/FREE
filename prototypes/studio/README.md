# FREE Vite Prototype

Minimal FREE prototype with a Vite/React frontend and Vercel API functions under `api/`.

## Commands

```bash
pnpm install
pnpm test
pnpm build
pnpm vercel:dev
```

`pnpm vercel:dev` serves the Vite app and `/api/*` routes together. Configure Ollama access with:

```bash
AI_MODEL=hf.co/numind/NuExtract3-GGUF:Q2_K
AI_BASE_URL=http://127.0.0.1:11434
# optional, for hosted Ollama-compatible endpoints
AI_API_KEY=...
```

If `AI_BASE_URL` is omitted, FREE uses the local/default Ollama provider with `AI_MODEL`.
