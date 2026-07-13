# FREE Vite Prototype

Minimal FREE prototype with a Vite/React frontend and Vercel API functions under `api/`.

## Commands

Run the full prototype from the repository root:

```bash
pnpm install
pnpm start
```

Frontend-only commands from this folder:

```bash
pnpm install
pnpm test
pnpm build
pnpm vercel:dev
```

The full prototype expects the parsing service at `http://127.0.0.1:8000` and the Vite studio at `http://localhost:5173`.

`pnpm vercel:dev` serves the Vite app and `/api/*` routes together. Configure Ollama access with:

```bash
AI_MODEL=hf.co/numind/NuExtract3-GGUF:Q2_K
AI_BASE_URL=http://127.0.0.1:11434
# optional, for hosted Ollama-compatible endpoints
AI_API_KEY=...
```

If `AI_BASE_URL` is omitted, FREE uses the local/default Ollama provider with `AI_MODEL`.

To use the authenticated local Codex CLI instead, install Codex CLI 0.144 or
newer, run `codex login`, and configure:

```bash
AI_PROVIDER=codex-cli
AI_MODEL=gpt-5.6-terra
```

Codex CLI requests use the AI SDK's generic JSON renderer. Ollama remains the
default and keeps the raw NuExtract prompt renderer.
