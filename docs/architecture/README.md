# Architecture presentation

The LikeC4 model keeps the implemented runtime apart from the target
deployment:

- [`current.c4`](./current.c4) documents the implemented private HTTPS runtime.
  The host nginx reverse proxy is the only published boundary, the Hono Node
  host authenticates each
  browser session, Project Context graphs are owned by Researcher Accounts,
  and the canonical package is the durable ingestion artifact.
- [`distribution.c4`](./distribution.c4) documents the university-hosted
  multi-researcher web application. Nothing in that file is built. The artifact
  store, parsing queue, and key-management product remain unselected, and
  ADR 0006 conflicts with its status. Read the `index` view before you use it.

From the repository root:

```bash
pnpm architecture:dev
```

Open the URL that LikeC4 prints, then follow this path.

Implemented runtime:

1. `current_context` — the private host-nginx + Studio runtime and its stores.
2. `current_modules` — the module seams inside each system.
3. `current_account_session` — explicit account provisioning and mandatory password replacement.
4. `project_context_lifecycle` — account-owned create, rename, and deletion.
5. `source_document_reopen` — the durable path an authenticated researcher uses.
6. `source_document_ingestion` — authenticated durable multi-PDF ingestion.
7. `schema_guided_extraction` — schema, Schema Revision, Extraction, grounding, and review.
8. `model_configuration` — shared Model Connections, advisory discovery, and Apply.

Target deployment:

9. `index` — the university-hosted target and its open conflict.
10. `target_runtime` — the hosted containers and boundaries.
11. `account_session` — target admin-provisioned accounts and sessions.
12. `target_source_document_ingestion` — backend-mediated asynchronous parsing.
13. `institution_model_flow` — university-managed open-weight models.
14. `researcher_credential_flow` — encrypted private credentials for closed providers.

Use LikeC4 search (`Ctrl+K`) to go to a view.

To validate the model, or to build a portable static presentation:

```bash
pnpm architecture:check
pnpm architecture:build
```

The static build goes to `artifacts/architecture/site/`. That path is
gitignored on purpose.

Change this model in the same pull request as the code it describes. A view
that disagrees with the code is worse than no view.
