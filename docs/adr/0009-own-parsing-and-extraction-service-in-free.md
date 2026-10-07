# 0009: Own the parsing and extraction service in FREE

Date: 2026-09-22. Status: accepted; amended by
[0010](0010-serve-extraction-models-from-vllm.md) (model servers) and
[0012](0012-one-durable-execution-layer.md) (job backend).

## Context

FREE's upload and extraction clients called a parsing and extraction service
that lived in a separate repository, so a FREE checkout could not supply the
complete application.

The required destination is one FREE monorepo containing the service and its
startup, deployment, persistence, and verification contracts.

## Decision

Import the service into `apps/parsing_service`, replacing the previous
implementation. Retain the `kei_exp` Python package and its locked
dependencies. FREE Studio is the researcher interface; the standalone
experimental web application, research artifacts, and run caches are not
imported.

FREE owns the service API, the separate durable worker, the worker's DBOS
schema (`kei_dbos`) in the shared PostgreSQL database (amended by
[0012](0012-one-durable-execution-layer.md)), schema initialization, shared run
storage, and model-server definitions. Studio calls the private Compose API.
The source tree and build contexts must not reference a sibling checkout. A
service boundary does not require a separate repository or a single process.

Use FREE's existing local and production launchers and preserve the
host-managed production nginx contract. Without the GPU overlay only native PDF
parsing runs, plus extraction if an operator points it at another vLLM server;
the overlay adds the OCR, NuExtract and instruction model servers (amended by
[0010](0010-serve-extraction-models-from-vllm.md)). Model caches and service
runs are persistent volumes. Normal startup does not reset or seed research
data.

## Consequences

The old parser is removed rather than retained as a rollback service. Git
history preserves its source.
