# Architecture presentation

[`current.c4`](./current.c4) is the executable description of FREE's
implemented production and local-development runtimes. Production combines
[`compose.yaml`](../../compose.yaml) and
[`compose.prod.yaml`](../../compose.prod.yaml) behind host nginx, or adds
[`compose.nginx.yaml`](../../compose.nginx.yaml) for the bundled nginx
container (`FREE_NGINX=container`). Local Compose adds
[`compose.override.yaml`](../../compose.override.yaml), optionally
[`compose.entra.yaml`](../../compose.entra.yaml). Both add
[`compose.gpu.yaml`](../../compose.gpu.yaml), the vLLM model servers, when
Docker can see an NVIDIA GPU and `FREE_GPU` is not `off`.

The model deliberately contains no credential vault, key-management service
or separate application backend. Model configuration belongs to each
Researcher Account; keys stay in researchers' browsers and in Studio's
memory. Durable work runs as DBOS workflows inside Studio and the Parsing
Service's worker.

From the repository root:

```bash
pnpm architecture:dev
```

Open the URL that LikeC4 prints, then follow these views:

1. `current_context` — production browser, nginx TLS gateway, Studio, and stores.
2. `current_modules` — maintained production module seams, including DBOS in
   Studio and the Parsing Service's worker.
3. `current_account_session` — Microsoft Entra authentication and JIT
   Researcher Account provisioning.
4. `project_context_lifecycle` — account-owned creation, rename, and deletion.
5. `source_document_reopen` — durable artifact reads for an owned Source Document.
6. `source_document_ingestion` — authenticated multi-PDF ingestion.
7. `schema_guided_extraction` — schema, Extraction, grounding, corrections and
   named finalizations.
8. `local_compose_topology` — default local nginx, Studio, PostgreSQL, Parsing
   Service, and mock OIDC services.
9. `local_entra_topology` — the same local entry topology using Microsoft Entra.
10. `model_configuration` — each account's Model Connections, steps and browser-held keys.
11. `garbage_collection` — the ten-minute sweep and its quiescence rules.

Use LikeC4 search (`Ctrl+K`) to open a view.

Validate or build the model with:

```bash
pnpm architecture:check
pnpm architecture:build
```

The static build is written to `artifacts/architecture/site/`. Change the model
in the same pull request as the code it describes.

## Code map

Studio is React 19, Vite, Tailwind CSS, XState v5 and PDF.js on a Hono server
(Node 24), with PostgreSQL 17 through Prisma Next. The Parsing Service is
Python with FastAPI and Docling; its OCR (Surya) and extraction models run on
vLLM servers. Tests use Vitest, Playwright, pytest and `node --test`.

| Directory | Responsibility |
|---|---|
| `apps/studio/src` | React client: project pages, schema editor, results review, Model Configuration page |
| `apps/studio/shared` | Zod contracts and pure helpers imported by both the client and the API handlers |
| `apps/studio/api` | Same-origin request handlers, DBOS workflows and their private `_*.ts` helpers |
| `apps/studio/server` | Hono host: sign-in, sessions, origin checks, API dispatch, static serving, DBOS launch |
| `packages/db` | Prisma Next contract and migrations, researcher-scoped Project Store, content-addressed package store |
| `packages/extraction` | Durable Extraction admission, selections, corrections, finalization, canonical Evidence |
| `packages/extraction-result-export` | CSV and Excel export of fixed result cuts |
| `packages/studio-configuration` | Studio settings validation shared by the launcher and the server |
| `apps/parsing_service/src/kei_exp` | `api.py` read API, `workflows/` DBOS worker, `kie/` ingestion, segmentation and grounded extraction, `transcription/` native and OCR text |
| `docker/`, `scripts/` | nginx templates, Studio entrypoint, the `free.mjs` launcher |
| `tests/` | Safety checks and the black-box system test against a Compose stack |

Contracts come first: the Zod schemas in `apps/studio/shared/*.contract.ts`
define the browser-to-server wire format, and both sides import them.
