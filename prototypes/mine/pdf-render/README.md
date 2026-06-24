# FREE Vite Prototype

Minimal FREE prototype with a Vite/React frontend and Vercel API functions under `api/`.

## Commands

```bash
pnpm install
pnpm test
pnpm build
pnpm vercel:dev
```

`pnpm vercel:dev` serves the Vite app and `/api/*` routes together. Configure model access with:

```bash
AI_MODEL=openai/gpt-5.4-mini
AI_API_KEY=...
AI_BASE_URL=...
```

Set `AI_BASE_URL` only for an OpenAI-compatible provider. Without it, FREE uses the AI SDK global provider with `AI_MODEL`.
