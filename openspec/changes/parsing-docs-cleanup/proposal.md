<!-- markdownlint-disable MD013 -->

# Proposal: parsing-docs-cleanup

> **Status: approved 2026-07-16; implement after PR #24 merges.** Carries the
> surviving tasks from the closed
> [`harden-canonical-parsing-service`](../harden-canonical-parsing-service/proposal.md)
> change: former tasks 2.7, 2.8, and batch 5.

## Why

PR #24 landed the parsing-fidelity fixes and the source-ingestion
simplification. The docs still describe the pre-simplification service
(quotas, leases, URL ingestion, request-envelope streaming), terminology
drifted from `CONTEXT.md`, and canonical text artifacts inherit platform
newline defaults, which would change content digests on Windows.

## What Changes

- Canonical text artifacts are written as deterministic UTF-8/LF bytes, with a
  digest-stability test independent of platform newline defaults.
- `docs/parsing-quality.md` describes canonical Markdown semantics,
  table-less success, literal-value preservation, and the page-local
  multi-page table behavior actually implemented (task 1.7 predicate).
- Documentation matches the post-simplification service: no URL ingestion, no
  quotas or leases, declared Content-Length admission only, mtime-grace
  pruning, 7-day retention.
- `user`/`file` wording is replaced with `Humanities Researcher` and
  `Source Document` where CONTEXT.md terminology applies; format-specific PDF
  terminology stays where technically required.
- The sole production `read_text` helper moves to its owning module;
  production-dead normalization functions and their module tests are deleted.

## What This Change Is Not

No behavior changes beyond byte-level newline normalization, no new endpoints,
no CI (explicitly declined for now), no container work, no extraction scope.

## Implementation notes

Small, mechanical, docs-heavy: one implementer on `gpt-5.6-terra` at medium
effort (or `luna` at high), single commit or two (code vs docs), full backend
suite plus `git diff --check` as the gate. No review panel needed beyond one
read-only scope check.
