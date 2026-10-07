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
HTTPS deployment. See [the deployment guide](../../docs/operations/deployment.md#network-exposure-and-proxy-trust)
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

Each Researcher Account has its own model configuration in PostgreSQL; a fresh account starts with none. Open **Configure models** for the Model Configuration page. Its **Models** tab follows the work in three steps — reading documents (the Ingestion Model Choice), schema and chat (the *Assistant model*, which Schema Suggestion follows until given its own model), and extracting data (the Extraction Model Choice) — and its **Connections** tab lists the researcher's connections beside the deployment's read-only ones (`FREE_DEPLOYMENT_INSTRUCT_URL`, `FREE_DEPLOYMENT_INSTRUCT_MODEL`, `FREE_DEPLOYMENT_NUEXTRACT_URL` from the GPU overlay, and the CLI providers enabled by `FREE_DEPLOYMENT_CLI_PROVIDERS`).

- A connection's key is typed into the page and stays in this browser's `localStorage`, bound to the account, the connection and its API base; changing the base or provider clears it. The page sends keys to Studio with `PUT /api/model-keys`, and Studio keeps them only in memory. After a Studio restart the page resends them on its next request; background work with no page open fails with `model_key_required` and can be retried.
- **Apply** saves the whole draft in one transaction; the configuration is validated on every write, so there is no reset.
- Connection checks run when the page opens and after edited provider inputs settle. They are advisory: they never generate content or change configuration, and never gate a manual model ID or Apply.
- A keyless Ollama connection calls its server anonymously, even when `OLLAMA_API_KEY` is set in Studio's environment.

Ollama, OpenAI, Anthropic, Google, vLLM, and generic OpenAI-compatible connections can be added by a researcher; Codex CLI and Claude Code are deployment connections only. A vLLM connection is OpenAI-compatible and switches the chat template's thinking off. Enter provider base URLs exactly as their adapters expect. Ollama uses the server base, such as `http://127.0.0.1:11434`, and FREE reaches its native resources beneath `/api`. Other HTTP providers may require a version prefix such as `/v1` or `/v1beta`; generic OpenAI-compatible bases provide `/models` and `/chat/completions` beneath the entered base.

The Studio container includes the Codex CLI and Claude Code. Enable them with `FREE_DEPLOYMENT_CLI_PROVIDERS`, then log in once inside the running container:

```bash
docker compose exec studio codex login --device-auth
docker compose exec studio codex login status
```

Claude Code authenticates from `CLAUDE_CODE_OAUTH_TOKEN` (`claude setup-token`). The Codex home and Claude Code's state live in the `studio-config` and `studio-claude` volumes, so rebuilding the image keeps the logins.

## Reprocessing a Source Document

Use **Reprocess** in a Source Document menu and select single pages or two-page
spreads. Studio parses the retained PDF and publishes the next Source
Representation Revision after the complete canonical package is retained.
The request pins the expected current revision; concurrent changes return a
conflict, and a retry with the same request key replays its published revision.

Existing Extractions, Review Decisions and Annotations retain their original
source revision. Opening the document without an Extraction identity selects
its current revision; opening a historical Extraction uses its original source.
A new Extraction can be started only on the document's current source revision:
the server answers 409 `source_representation_superseded` for a superseded one,
and the historical view offers no run. Runs started from a Schema Suggestion keep
the revisions saved with the suggestion; they are the one exception.
Run a new Extraction on the current revision to use upgraded cell Evidence; an
Extraction opened on an earlier revision offers no new run. Ordinary
re-uploading still deduplicates by PDF content and does not reprocess it.

Reprocessing runs as a durable workflow: closing the browser does not stop it,
and repeating the request with the same request key rejoins it or returns its
published revision. Its browser request still waits on the parse; after closing
the page, the result becomes visible as the new revision.

An upload is Studio's once it is admitted (`202 { workflowId }`): the Project page
lists it as a Source Ingestion, queued, parsing or failed, across reloads, tabs and
Studio restarts, until it becomes a Source Document. A failure can be dismissed or
uploaded again. Files the browser has not sent yet are still only in the tab.
