# 0009: Own the parsing and extraction service in FREE

Date: 2026-09-22. Status: accepted; implementation and validation recorded in
the accompanying monorepo consolidation change.

## Context

FREE's upload and extraction clients had moved to kei-exp while the service
remained in another repository. FREE's Compose topology still started the
replaced Docling service and expected a separately managed kei-exp API and
worker. The Spark deployment plan also required two checkouts and put the
combined launcher in kei-exp. A FREE checkout could not supply the complete
application.

The required destination is one FREE monorepo containing the service and its
startup, deployment, persistence, and verification contracts.

## Decision

Import the backend from kei-exp commit
`93b9435c2b9a01a5424758d917c058fc79bbc159` into
`prototypes/parsing_service`, replacing the previous implementation. Retain
the `kei_exp` Python package and its locked dependencies. FREE Studio is the
researcher interface; the standalone experimental web application, research
artifacts, run caches, and agent worktrees are not imported.

FREE owns the service API, separate durable worker, PostgreSQL job database,
schema initialization, shared run storage, and model-server definitions.
Studio calls the private Compose API. The source tree and build contexts must
not reference a sibling checkout. A service boundary does not require a
separate repository or a single process.

Use FREE's existing local and production launchers and preserve the
host-managed production nginx contract. This supersedes the two-repository
Spark deployment direction. CPU supports native PDFs and extraction; the GPU
overlay adds the scanned-document OCR server. Model caches and service runs
are persistent volumes. Normal startup does not reset or seed research data.

## Consequences

The old parser is removed rather than retained as a rollback service. Git
history preserves its source. Existing research databases and Studio artifact
volumes are retained; historical Source Documents without a run in the new
service must be uploaded again before extraction. This change does not copy
data from a separately running kei-exp deployment or retire that deployment.

Validation must cover the real FREE upload adapter and the imported service's
API, worker, canonical artifacts, extraction response, and saved review. A
deterministic model-boundary fixture can verify plumbing; real-model and
scanned-document checks must be reported separately. Importing the backend
does not implement the longer-term character-span Catalog boundary design.
