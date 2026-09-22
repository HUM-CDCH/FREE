# FREE service consolidation validation

Date: 2026-09-22. Status: paused for coordinator handoff at the user's request;
implementation is uncommitted and validation is incomplete. Continue from
[the coordinator handoff](2026-09-22-service-consolidation-handoff.md).

## Change under test

The backend from kei-exp `93b9435c2b9a01a5424758d917c058fc79bbc159`
now lives in `prototypes/parsing_service`, replacing the former parser.
FREE owns the API, worker, job database/schema, shared run storage, and model
servers. Studio calls the private Compose service. See
[ADR 0009](../adr/0009-own-parsing-and-extraction-service-in-free.md).
No sibling checkout, agent worktree, runtime data, or research PDF is required.

## Reproduction

```bash
pnpm install --frozen-lockfile
pnpm typecheck
pnpm lint
pnpm test:unit
pnpm test:safety
pnpm test:e2e
pnpm test:service
pnpm --filter studio build
pnpm architecture:check
```

`test:service` provisions isolated PostgreSQL and mock OIDC, uses the imported
Python environment, and starts a real API and worker. Its generated native
PDF contains two separate entries on one page. Only extraction completions are
scripted; their values are derived from actual parsed prompt text. It checks:

- authenticated upload and canonical artifact import;
- Article and Catalog extraction, each with two records and six grounded values;
- saved review and browser evidence navigation;
- API/worker restart before extraction and after accepted results;
- identical accepted artifacts after restart; with scripted completions, it also
  proves that restart makes no additional model calls.

To repeat with a real model instead of scripted completions:

```bash
FREE_REAL_EXTRACT_URL=http://127.0.0.1:PORT/v1/chat/completions \
FREE_REAL_EXTRACT_MODEL=qwen3:8b pnpm test:service
```

Database tests require caller-provisioned, guarded disposable targets; see
[the development runbook](../operations/local-development.md#verification).
The audit used its own `free-monorepo-parsing-tests` container on loopback 5432,
with `free_test_project_store`, `free_test_extraction`, and `free_test_parsing`.
Existing databases on other ports and the existing model server were not used.

## Results

- Workspace type checks and lint passed; lint retains three existing React Hook warnings.
- Fast unit aggregate passed, including 583 backend tests. 73 backend cases skip
  because their exact optional upstream research PDFs are not distributed here.
- Launcher checks and all 14 safety checks passed, including CPU/GPU Compose
  rendering, nginx validation, and ordered build/stop/migration startup.
- FREE PostgreSQL checks passed: 3 Project Store and 20 extraction tests.
- Backend PostgreSQL checks passed: 106 tests; 4 optional research-fixture skips.
- Real native API + worker + PostgreSQL parsing smoke passed.
- Interrupted-worker recovery passed on a generated 300-page native PDF
  (136.82 seconds, CPU); the recovered job reached its authoritative terminal state.
- Deterministic complete service/browser workflow passed in 24.2 seconds.
- Full default browser suite passed: 50 tests, 1 expected developer-UI skip.
- Studio production build and architecture validation passed.

The first real `qwen3:8b` run passed Article extraction but failed the exact
Catalog result assertion. After a cold model load, the `Valley` record call
spent all 8192 tokens in a repeating reasoning loop (greedy decoding in Qwen3
thinking mode) and returned no content; this reproduced in 6 of 6 cold replays
of the captured requests. Extraction calls now send `reasoning_effort: "none"`
(`PROMPT_VERSION` 2). The same cold replays then answered correctly 4 of 4
times, and the complete real-model workflow passed 3 of 3 times from a cold
model load (25 seconds each). The real-model tier does not count model calls;
only the scripted tier proves no extra calls after restart. Both Docker
image builds were deliberately interrupted while resolving host disk pressure;
the host Studio build passing does **not** establish that those images build.

Validation found and repaired two defects: the Catalog DTO required diagnostics
from the removed local pipeline, and a pending provider stream read overwrote
an explicit cancellation trace. Both have regression coverage.

## Boundaries

The complete service test uses native PDF parsing. It does not prove scanned
Surya OCR quality, GPU model compatibility, or DGX Spark deployment. The imported
Catalog implementation still cannot place two record starts within one parser
segment; preserving separate native blocks addresses the test's two-entry page,
not the full character-span boundary design.

The import keeps canonical file formats and the Python package names. It removes
the obsolete parser, standalone experimental web launcher, standalone model
launcher, and unused Modal dependency. Historical source specifications remain
beside the service for code-referenced contracts. Runtime data from an existing
separate kei-exp deployment is not migrated; existing FREE research data is not
reset.
