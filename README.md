# FREE

FREE turns source documents (PDFs of articles, catalogues, reports) into
structured data for humanities research. You describe the fields you want as a
schema, FREE extracts them, and every value points back to the passage it came
from, so you can check it before you trust it.

It has two parts, run together with Docker Compose:

- **Studio**: the web app (React + TypeScript) where you upload documents,
  build schemas, run extractions, review the results and export them.
- **Parsing Service**: a Python service that parses PDFs (text or OCR) and runs
  extraction on vLLM model servers.

## Requirements

| | Version | Notes |
|---|---|---|
| Docker + Compose | Compose ≥ 2.40 | Checked by the launcher |
| Node.js | 24 | |
| pnpm | 12.8.1 | `corepack enable` picks it up from `package.json` |
| Python | 3.13 | Installed through [uv](https://docs.astral.sh/uv/) |
| uv | recent | `pnpm install` runs `uv sync` for the Parsing Service |
| mkcert | any | Run `mkcert -install` once; local HTTPS uses it |
| NVIDIA GPU | optional | Needed for extraction and OCR of scanned PDFs (vLLM); the default models need about 60 GB of GPU memory |

Linux is the main target. macOS and Windows work through Docker Desktop. Plan
for roughly 70 GB of disk with the default models: about 40 GB of model weights,
6 GB for the Python environment and 20 GB of Docker images.

## Install

```bash
git clone <this-repo-url> free && cd free
corepack enable
mkcert -install
pnpm install
```

## Run

```bash
pnpm dev
```

Open <https://localhost:8443/free> and sign in. In development the sign-in is a
local mock identity provider, so you don't need an account or a `.env` file.
The first start builds the images and downloads models, which can take a while.
Stop it with Ctrl+C.

If Docker can see an NVIDIA GPU, the launcher also runs the vLLM model servers.
If you don't want them, set `FREE_GPU=off`; set `FREE_GPU=required` to stop with
an error when no GPU is available. Without model servers you can still upload
text PDFs and build schemas, but OCR and extraction need vLLM.

`pnpm dev` reads settings from your shell, not from `.env`, so prefix or export
them: `FREE_GPU=off pnpm dev`. `pnpm production` reads `.env`. To deploy for production (Microsoft Entra
sign-in, TLS, backups), see [docs/operations/deployment.md](docs/operations/deployment.md).

## Models

FREE uses models for two different jobs, and they're set up differently.

**Extraction runs on vLLM.** The Parsing Service needs an OpenAI-compatible
vLLM server, and it also uses vLLM's `/tokenize` endpoint. With a GPU,
`compose.gpu.yaml` starts three servers for you. You can change the extraction
models (export them for `pnpm dev`, or put them in `.env` for production):

```bash
KEI_EXTRACT_MODEL=Qwen/Qwen3.8-27B-FP8       # instruction model
KEI_NUEXTRACT_MODEL=numind/NuExtract3-FP8    # template field extractor
HF_TOKEN=<your-hugging-face-token>           # only for gated models
```

On a machine without a GPU, point the Parsing Service at a vLLM server you
already run elsewhere, and name the model it serves. Use an address the
containers can reach (not `localhost`):

```bash
KEI_EXTRACT_URL=http://<vllm-host>:8000/v1/chat/completions
KEI_EXTRACT_MODEL=<served-model-name>
```

On ARM64 hosts such as DGX Spark, set `VLLM_IMAGE` to an ARM64 build of vLLM.

**Schema help and chat run on any connection you add in Studio.** Open
**Configure models** → **Connections**. Each researcher adds their own. API keys
are kept in the browser; Studio holds them in memory only and never stores them.

- **Ollama**: install [Ollama](https://ollama.com), pull a model (for example
  `ollama pull qwen3.8`), then add an Ollama connection. Studio runs in a
  container, so use `http://host.docker.internal:11434` as the base URL, not
  `localhost`. On Linux, also make Ollama listen beyond loopback
  (`OLLAMA_HOST=0.0.0.0`, then restart it).
- **vLLM**: add a vLLM connection with the server's `/v1` base URL.
- **OpenAI, Anthropic, Google** or any OpenAI-compatible API: add a connection
  and paste your key.

**Codex CLI and Claude Code** can serve as shared connections for every
researcher. They run on the server's own login and billing, so the operator
turns them on. The development stack enables both. In production, set
`FREE_DEPLOYMENT_CLI_PROVIDERS=codex-cli,claude-code` in `.env`.

```bash
# Codex: log in once inside the running Studio container
studio=$(docker ps -qf label=com.docker.compose.service=studio)   # with one FREE stack running
docker exec -it "$studio" pnpm --filter studio exec codex login --device-auth
docker exec "$studio" pnpm --filter studio exec codex login status

# Claude Code: create a long-lived token (needs a Claude subscription)
pnpm --filter studio exec claude setup-token     # prints CLAUDE_CODE_OAUTH_TOKEN=...
CLAUDE_CODE_OAUTH_TOKEN=<token> pnpm dev          # production: put it in .env
```

The Codex login lives in a Docker volume, so it survives image rebuilds. Claude
Code reads its token from the environment at every start. Both are only used
for schema help and chat; extraction always runs on vLLM.

## Use

1. **Configure models**: add connections, then on the **Models** tab choose the
   assistant model and the extraction models, and click **Apply**.
2. **Create a project** and upload PDFs (up to 100 MiB each). FREE parses them
   in the background.
3. **Build a schema**: ask Schema Suggestion for one, edit it by hand, or refine
   it in chat. Pick *Article* (one record per document) or *Catalog* (many
   records per document), then approve it.
4. **Run an extraction** on one document or a batch. You can pause, resume,
   stop or retry it.
5. **Review**: each value shows its evidence in the source, or is flagged as
   ungrounded. Approve, reject or correct values, then finalize.
6. **Export** the results as CSV or Excel.

## Develop and test

```bash
pnpm test        # fast unit tests (TypeScript and Python)
pnpm typecheck
pnpm lint
pnpm test:e2e    # Playwright, browser flows
pnpm test:all    # every tier except live-model and system tests
```

The [product contract](docs/product-contract.md) describes every test tier, plus
the rules for authentication, storage and deployment.
[docs/operations/local-development.md](docs/operations/local-development.md)
covers the rest of local setup.

The repository also works with coding agents. [AGENTS.md](AGENTS.md) is the
entry point for Codex, Claude Code and other agents (`CLAUDE.md` points to it).
Project skills live in `.agents/`, `.claude/` and `.codex/`.

## Documentation

- [CONTEXT.md](CONTEXT.md): domain language
- [docs/product-contract.md](docs/product-contract.md): product and safety contract
- [docs/adr/](docs/adr/): architecture decisions
- [docs/operations/](docs/operations/): local development, deployment, Entra sign-in
- [prototypes/parsing_service/README.md](prototypes/parsing_service/README.md): Parsing Service
- [CONTRIBUTING.md](CONTRIBUTING.md): how to contribute
