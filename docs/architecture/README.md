# Architecture presentation

The LikeC4 model separates the implemented MVP from the approved target
deployment:

- [`current.c4`](./current.c4) documents the implemented runtime.
- [`distribution.c4`](./distribution.c4) documents the university-hosted
  multi-researcher web application. PostgreSQL/Prisma is adopted for the Project
  Store behind `ProjectStore`, but no application runtime consumes it. The
  artifact store, parsing queue, and key-management product remain unselected.

For the broader target workflow, see [`architecture.md`](../architecture.md).

From the repository root:

```bash
pnpm architecture:dev
```

Open the URL printed by LikeC4 and follow this meeting path:

1. `current_context` — implemented localhost runtime.
2. `index` — approved university-hosted target.
3. `target_runtime` — conventional web application containers and boundaries.
4. `account_session` — admin-provisioned accounts and authenticated sessions.
5. `target_source_document_ingestion` — backend-mediated asynchronous parsing.
6. `institution_model_flow` — university-managed open-weight models.
7. `researcher_credential_flow` — encrypted private credentials for closed providers.

Use LikeC4 search (`Ctrl+K`) to jump to a view.

To validate the model or build a portable static presentation:

```bash
pnpm architecture:check
pnpm architecture:build
```

The static build is written to `artifacts/architecture/site/` and is intentionally
gitignored.
