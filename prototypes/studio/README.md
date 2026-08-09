# FREE Vite Prototype

FREE Studio is a local Vite/React source prototype with TypeScript API handlers under `api/`.

## Commands

Run the full prototype from the repository root:

```bash
pnpm install
pnpm start
```

Studio uses Vite's implicit localhost binding at `http://localhost:5173`; the parsing service defaults to `http://127.0.0.1:8000`. Non-loopback exposure and hosted deployment are unsupported. Supporting either requires a separate authenticated-host design.

From this folder:

```bash
pnpm dev
pnpm test
pnpm test:e2e
pnpm lint
pnpm build
```

## Source-document Evidence

Completed parsing supplies canonical Markdown and the strict `parsed_document.v2`
contract together. A reopened Source Document reads both from its durable Source
Representation at `/api/source-representations/{id}/markdown` and
`/api/source-representations/{id}/source`. A Source Document that you open from
disk goes to the Parsing Service, which returns the same two payloads.
The **Evidence** tab groups text and table-cell Evidence by physical page, shows
producer and logical coordinates, continuation/page-span status, geometry availability,
unplaced content, and parser diagnostics. Selecting an anchor uses only its recorded
physical page and canonical bounding box; missing geometry never triggers PDF text
matching. This source-document Evidence view is separate
from extraction-result Evidence and arbitrary extraction JSON remains permissive.

## Model configuration

A fresh Studio starts without Model Connections or Capability Routes. Open **Model Connections** in Studio to configure them. Saved configuration is machine-wide and is the sole model-configuration source.

- Non-secret connection and route state is stored as `model-config.json` in the operating system user configuration directory for `FREE Studio`.
- FREE-managed credentials are stored only in the operating system credential store. A locked or unavailable credential store does not block credentialless Ollama/OpenAI-compatible connections or externally authenticated Codex CLI and Claude Code connections.
- **Single model** assigns one explicit connection and model ID to Extraction, Schema Suggestion, document chat, and conversational Extraction Schema editing.
- **Capability Routes** independently assigns the Extraction Route and Interaction Route. Raw NuExtract is an explicit Ollama-only Extraction Route option.
- **Apply** sends the complete editable draft once. Credential fields are write-only; leaving one untouched preserves its saved value.
- Connection checks run after edited provider inputs settle and through **Refresh models**. Their status and model catalog are advisory session state: checks never generate content, change configuration, or gate manual model IDs or Apply.

Ollama, OpenAI, Anthropic, Google, Codex CLI, Claude Code, and generic OpenAI-compatible connections are supported. Enter provider base URLs exactly as their adapters expect. Ollama uses the server base, such as `http://127.0.0.1:11434`, and FREE reaches its native resources beneath `/api`. Other HTTP providers may require a version prefix such as `/v1` or `/v1beta`; generic OpenAI-compatible bases provide `/models` and `/chat/completions` beneath the entered base.
