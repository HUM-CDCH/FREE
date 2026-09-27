# Architecture presentation

[`current.c4`](./current.c4) is the executable description of FREE's
implemented production and local-development runtimes. Production combines
[`compose.yaml`](../../compose.yaml) and
[`compose.prod.yaml`](../../compose.prod.yaml) behind host nginx. Local Compose
adds [`compose.override.yaml`](../../compose.override.yaml), optionally
[`compose.entra.yaml`](../../compose.entra.yaml).

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

1. `current_context` — production browser, host-nginx TLS, Studio, and stores.
2. `current_modules` — maintained production module seams, including DBOS in
   Studio and the Parsing Service's worker.
3. `current_account_session` — Microsoft Entra authentication and JIT
   Researcher Account provisioning.
4. `project_context_lifecycle` — account-owned creation, rename, and deletion.
5. `source_document_reopen` — durable artifact reads for an owned Source Document.
6. `source_document_ingestion` — authenticated multi-PDF ingestion.
7. `schema_guided_extraction` — schema, Extraction, grounding, and versioned
   ExtractionReview persistence.
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
