# FREE Studio

FREE Studio is a React client with same-origin TypeScript API handlers under
`api/`. Vite serves it during development; the built production client and API
run from the Node host in `server/`.

## Commands

Run the full prototype from the repository root:

```bash
pnpm install
pnpm start
```

Local development uses Vite's implicit localhost binding at
`http://localhost:5173`; the Parsing Service defaults to
`http://127.0.0.1:8055`. The root `compose.yaml` supplies the supported private
HTTPS deployment. See [the root deployment guide](../../README.md#network-exposure-and-proxy-trust)
for its port boundary and the production Node host's explicit trust modes.

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

A fresh Studio starts without saved Model Connections or Capability Routes. Open **Configure models** in Studio for the Model Configuration page, which holds every model choice. Saved configuration is machine-wide; the deployment's own vLLM servers are added from the environment (`FREE_DEPLOYMENT_INSTRUCT_URL`, `FREE_DEPLOYMENT_INSTRUCT_MODEL`, `FREE_DEPLOYMENT_NUEXTRACT_URL`, set by the GPU overlay), listed read-only, and never saved.

- Non-secret connection and route state is stored as `model-config.json` in the operating system user configuration directory for `FREE Studio`.
- FREE-managed credentials are stored only in the operating system credential store. A locked or unavailable credential store does not block credentialless Ollama/OpenAI-compatible connections or externally authenticated Codex CLI and Claude Code connections.
- **Extraction** chooses kei-exp's field and reasoning models for every single and Batch Extraction; **Default** keeps the service's default for the role.
- **Single model** assigns one explicit connection and model ID to Schema Suggestion, document chat, and conversational Extraction Schema editing.
- **Capability Routes** independently assigns the Schema Suggestion Route and Interaction Route. The NuExtract protocol is a vLLM-only Schema Suggestion Route option. A route left unset runs on the deployment's instruction model.
- **Apply** sends the complete editable draft once. Credential fields are write-only; leaving one untouched preserves its saved value.
- Connection checks run after edited provider inputs settle and through **Refresh models**. Their status and model catalog are advisory session state: checks never generate content, change configuration, or gate manual model IDs or Apply.

Ollama, OpenAI, Anthropic, Google, Codex CLI, Claude Code, vLLM, and generic OpenAI-compatible connections are supported. A vLLM connection is OpenAI-compatible and switches the chat template's thinking off. Enter provider base URLs exactly as their adapters expect. Ollama uses the server base, such as `http://127.0.0.1:11434`, and FREE reaches its native resources beneath `/api`. Other HTTP providers may require a version prefix such as `/v1` or `/v1beta`; generic OpenAI-compatible bases provide `/models` and `/chat/completions` beneath the entered base.

The Studio container includes the Codex CLI. Authenticate it once inside the
running container before using a Codex CLI Model Connection:

```bash
docker compose exec studio codex login --device-auth
docker compose exec studio codex login status
```

Codex home and the container keyring use the existing persistent Studio
volumes, so rebuilding the image does not discard the login.

## Reprocessing a Source Document

Use **Reprocess** in a Source Document menu and select single pages or two-page
spreads. Studio parses the retained PDF and publishes the next Source
Representation Revision after the complete canonical package is retained.
The request pins the expected current revision; concurrent changes return a
conflict, and a retry with the same request key replays its published revision.

Existing Extractions, Review Decisions and Annotations retain their original
source revision. Opening the document without an Extraction identity selects
its current revision; opening a historical Extraction uses its original source.
Run a new Extraction to use upgraded cell Evidence. Ordinary re-uploading still
deduplicates by PDF content and does not reprocess it.

Apply database migration `20260923T1946_source_reprocessing` before serving this
version. This action currently uses the same request and in-memory queue
lifecycle as uploads; closing the browser does not provide durable queue recovery.
