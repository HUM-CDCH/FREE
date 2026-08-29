# Architecture presentation

[`current.c4`](./current.c4) is the executable description of FREE's
implemented runtime. It follows the private production topology in
[`compose.yaml`](../../compose.yaml): the host nginx reverse proxy is the only
browser-facing boundary, Studio serves the React application and authenticated
API, PostgreSQL stores durable research state, and the Parsing Service produces
canonical ingestion packages.

The model deliberately contains no speculative credential vault, key-management
service, parsing queue, or separate application backend. Model configuration and
credentials remain deployment-wide Studio state, and the Parsing Service owns no
model operation.

From the repository root:

```bash
pnpm architecture:dev
```

Open the URL that LikeC4 prints, then follow these views:

1. `current_context` — the private host-nginx + Studio runtime and its stores.
2. `current_modules` — maintained module seams, not an import graph.
3. `current_account_session` — Microsoft Entra authentication and JIT
   Researcher Account provisioning.
4. `project_context_lifecycle` — account-owned creation, rename, and deletion.
5. `source_document_reopen` — durable artifact reads for an owned Source Document.
6. `source_document_ingestion` — authenticated multi-PDF ingestion.
7. `schema_guided_extraction` — schema, Extraction, grounding, and review.
8. `model_configuration` — deployment-wide Model Connections and credentials.

Use LikeC4 search (`Ctrl+K`) to open a view.

Validate or build the model with:

```bash
pnpm architecture:check
pnpm architecture:build
```

The static build is written to `artifacts/architecture/site/`. Change the model
in the same pull request as the code it describes.
