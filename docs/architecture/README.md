# FREE architecture and repository map

This LikeC4 project maps the tracked repository at system, container and
component boundaries, with dynamic views for the main runtime flows. Select
an element to open its source or detailed contract. Links target `dev`, the
repository's PR base. [`current.c4`](./current.c4) describes FREE's
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

Open the URL that LikeC4 prints and start at `index`. Use search (`Ctrl+K`)
to open any named view. The focused repository and component views are:

| View | What it answers |
| --- | --- |
| `index` | Entry points into the runtime, components and repository support |
| `studio_client` | Research Workspace, document viewer, schema editor, review and model settings |
| `studio_server` | Authentication, host, workflows, providers, persistence and shared contracts |
| `parsing_components` | Worker coordination, ingestion, transcription, canonical publication and extraction |
| `shared_packages` | All four workspace packages and their consumers |
| `repository_map` | Launcher, dependencies/builds, deployment, verification, CI and documentation |
| `research_tooling` | Offline studies, synthetic benchmarks and the optional evaluation watcher |
| `local_deployment` | Local Compose processes, optional model servers and stores |
| `production_deployment` | Production Compose processes behind host or bundled nginx |
| `canonical_processing` | Staged PDF to canonical artifacts and a Source Representation |
| `durable_execution` | Admission, handoff, call checkpoints and retained results |
| `review_and_export` | Corrections, named finalization and browser-side CSV/XLSX export |

The established runtime views remain:

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

The deployment views show the normal topology. `compose.gpu.yaml` supplies
three separate vLLM servers (OCR, fields and reasoning), grouped in the diagram.
`compose.provide-models.yaml` and `compose.use-models.yaml` share those servers
between stacks instead. The optional GLiFormer fields server appears in
`parsing_components`; the opt-in `eval` profile appears in `research_tooling`.
Their linked contracts describe their restrictions.

Validate or build the model with:

```bash
pnpm architecture:check
pnpm architecture:build
```

The static build is written to `artifacts/architecture/site/`, uses hash
navigation and can be served by a static HTTP server. Generated output stays
ignored. These commands use the existing workspace dependency.

## Source coverage

This is a map of responsibilities, not one box per source file. Colocated
tests belong to their module; the verification view shows the wider tiers.
Every tracked source area has a home below. Ignored local checkouts, agent
tooling, credentials, model caches and scratch files are outside the map.

| Source area | Model home | Detailed source or contract |
| --- | --- | --- |
| `apps/studio/src/projectContexts`, navigation, ingestion and batches | `studio.ui.workspace` | [Project Context UI](../../apps/studio/src/projectContexts/), [ingestion machine](../../apps/studio/src/sourceIngestionMachine.ts) |
| `apps/studio/src` document, page, Markdown and Evidence controls | `studio.ui.documents` | [Canonical viewer](../../apps/studio/src/DocumentMarkdown.tsx), [Evidence overlays](../../apps/studio/src/useEvidenceOverlays.ts) |
| `apps/studio/src` schema tree, revision saves and chat | `studio.ui.schemas` | [Schema panel](../../apps/studio/src/SchemaPanel.tsx), [Schema Suggestion contract](../../apps/studio/README.md#schema-suggestion-and-editing) |
| `apps/studio/src` durable control, results, decisions and export adapter | `studio.ui.review` | [Results](../../apps/studio/src/DurableResults.tsx), [review machine](../../apps/studio/src/durableReviewMachine.ts), [fixed-cut export](../../apps/studio/src/durableExport.ts) |
| `apps/studio/src/providerConfig`, `modelKeys`, `auth`, HTTP adapters | `studio.ui.settings`, `studio.key_store`, `studio.browser_http`, `studio.authentication` | [Model settings](../../apps/studio/src/providerConfig/), [browser auth](../../apps/studio/src/auth/) |
| `apps/studio/src/ui`, frame, CSS, assets and `public` | `studio.ui.design` | [Design rules](../../apps/studio/DESIGN.md), [shared controls](../../apps/studio/src/ui/) |
| `apps/studio/shared` | `studio.contracts` | [Zod wire contracts](../../apps/studio/shared/) |
| `apps/studio/server` | `studio.handlers`, `studio.authentication`, `studio.durable`, `traces` | [Host and session boundary](../../apps/studio/server/), [execution specification](../design/unified-durable-execution.md) |
| `apps/studio/api` | `studio.handlers`, `studio.ingestion`, `studio.suggestions`, `studio.provider_registry`, `studio.garbage` | [Handlers and workflow implementations](../../apps/studio/api/) |
| `packages/db` | `studio.project_store`, `project_db`, `package_store` | [Prisma Next schema](../../packages/db/src/prisma/contract.prisma), [migrations and coordination SQL](../../packages/db/migrations/), [artifact store](../../packages/db/src/artifact-store.ts) |
| `packages/extraction` | `studio.extraction_module` | [Public exports](../../packages/extraction/package.json), [saved-value contracts](../../packages/extraction/src/durable-contract.ts), [ADR 0017](../adr/0017-durable-extraction-control-and-call-checkpoints.md) |
| `packages/extraction-result-export` | `studio.export` | [CSV/XLSX package](../../packages/extraction-result-export/src/), [typed projection](../../packages/extraction-result-export/src/durable.ts) |
| `packages/studio-configuration` | `studio.configuration` | [Shared settings validation](../../packages/studio-configuration/src/index.mjs) |
| `apps/parsing_service/src/kei_exp/api.py` | `parsing_service.http_api` | [Read API](../../apps/parsing_service/src/kei_exp/api.py), [HTTP contract](../../apps/parsing_service/README.md#http-and-evidence-contract) |
| `apps/parsing_service/src/kei_exp/workflows` | `parsing_service.parser.coordination` | [Worker contract](../../apps/parsing_service/README.md#runtime), [workflow fixtures](../../apps/parsing_service/tests/fixtures/contracts/) |
| `apps/parsing_service/src/kei_exp/kie/stages`, page/rendering/geometry helpers | `parsing_service.parser.ingest` | [Ingestion stages](../../apps/parsing_service/src/kei_exp/kie/stages/), [page and spread cuts](../../apps/parsing_service/docs/ingest-cuts.md) |
| `apps/parsing_service/src/kei_exp/transcription` | `parsing_service.parser.transcription` | [Native text and OCR adapters](../../apps/parsing_service/src/kei_exp/transcription/) |
| `apps/parsing_service/src/kei_exp` result, runs, files, reuse and diagnostics | `parsing_service.parser.canonical`, `parsing_service.task_cache` | [Canonical publication](../../apps/parsing_service/src/kei_exp/result.py), [reuse](../../apps/parsing_service/src/kei_exp/reuse.py), [Evidence vocabulary](../../apps/parsing_service/CONTEXT.md) |
| `apps/parsing_service/src/kei_exp/kie` recipes, boundaries and passages | `parsing_service.parser.segmentation` | [Recipe Catalog contract](../../apps/parsing_service/docs/extraction-experiments.md#the-recipe-catalog) |
| `apps/parsing_service/src/kei_exp/kie/extract` | `parsing_service.parser.extraction` | [Local Mermaid pipeline, stage ownership and model-call map](../../apps/parsing_service/docs/extraction-experiments.md) |
| `apps/parsing_service/model_servers/gliformer`, `nuextract.template.jinja` | `parsing_service.gliformer`, `parsing_service.models` | [GLiFormer API](../../apps/parsing_service/model_servers/gliformer/README.md), [NuExtract template](../../nuextract.template.jinja) |
| `apps/parsing_service/experiments`, `evaluate_table_cells.py` | `repository.studies`, `repository.synthetic`, `repository.evaluation` | [Study protocols](../../apps/parsing_service/experiments/extraction/), [synthetic benchmark](../../apps/parsing_service/experiments/synthetic_pdf/README.md) |
| Root `compose*.yaml`, app Dockerfiles and `docker` | `repository.delivery`, deployment views | [Base services](../../compose.yaml), [deployment runbook](../operations/deployment.md), [proxy and entrypoint](../../docker/) |
| `scripts` | `repository.launcher`, `repository.workspace`, `repository.ci` | [Launcher, install and CI scripts](../../scripts/) |
| `tests`, Studio `test`/`e2e`, Parsing Service tests and colocated tests | `repository.verification` | [Verification tiers and prerequisites](../operations/local-development.md#verification) |
| `.github/workflows` | `repository.ci` | [verify workflow](../../.github/workflows/verify.yml) |
| Root manifests, lockfiles, dotfiles and per-app build/test configuration | `repository.workspace` | [Commands](../../package.json), [workspace](../../pnpm-workspace.yaml), [Python project](../../apps/parsing_service/pyproject.toml) |
| `docs`, root/module READMEs, context/agent/contribution rules and license | `repository.documentation` | [Product contract](../product-contract.md), [domain language](../../CONTEXT.md), [ADRs](../adr/), [contribution rules](../../CONTRIBUTING.md) |

Contracts come first: the Zod schemas in `apps/studio/shared/*.contract.ts`
define the browser-to-server wire format, and both sides import them.

## Keep the detail with its owner

LikeC4 owns topology, component boundaries and high-level API/workflow chains.
State machines, complex protocols and schemas stay beside their implementation:
the XState machines, Zod contracts, Prisma Next schema, workflow fixtures and
local Mermaid pipeline are linked above and from the elements. Add Mermaid
or D2 beside a module's README when it explains something those sources cannot;
attach it with the component's `link` property.

For code structure, inspect the current source rather than maintaining Level 4
by hand. With an existing CodeGraph index, use `codegraph explore` with module
or symbol names. `pnpm db:generate` emits the database contract from
`contract.prisma`; the running private Parsing Service exposes FastAPI's
`/openapi.json`. Studio's wire boundary is its shared Zod contracts. Keep
generated structure and experiment receipts in ignored artifacts.

## Model ownership

| File | Owns |
| --- | --- |
| `likec4.config.json` | Project scope and name |
| `spec.c4` | Element kinds, optional tag and deployment-node kinds |
| `current.c4` | Established runtime boundaries and product flows |
| `components.c4` | Studio client/server, shared packages and worker seams |
| `links.c4` | Source and detailed-contract links for established elements |
| `repository.c4` | Build, delivery, verification, research and entry views |
| `deployment.c4` | Named local and production process/store instances |
| `flows.c4` | Canonical processing, durable execution, review and export |

Update the affected boundary, links and views in the same PR as its code.
Reuse existing element IDs, use full names for cross-file references and
validate the complete project before building it. Keep secrets, source
document content and machine-specific addresses out of the model.
