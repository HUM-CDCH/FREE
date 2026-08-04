<!-- markdownlint-disable MD013 -->

# Tasks: parsing-docs-cleanup

## 1. Deterministic canonical bytes (former hardening 2.7)

- [ ] 1.1 Write all canonical text artifacts as deterministic UTF-8/LF bytes and add a digest-stability test independent of platform newline defaults

## 2. Documentation alignment (former hardening 2.8, 5.3, 5.4)

- [ ] 2.1 Update `docs/parsing-quality.md` with canonical Markdown semantics, table-less success, literal-value preservation, and the implemented page-local multi-page table behavior
- [ ] 2.2 Align request-limit, retention, and ingestion documentation with the post-simplification service (no URL ingestion, no quotas/leases, Content-Length admission, mtime-grace pruning); correct "digest-authenticated" cache claims to "integrity-verified"
- [ ] 2.3 Confirm previously overstated claims (NAT64 exploitability, forever-pending locks, mid-stream deletion, `/markdown` newline behavior) are not repeated

## 3. Terminology and dead code (former hardening 5.1, 5.2)

- [ ] 3.1 Replace `user`/`file` wording with `Humanities Researcher` / `Source Document` per CONTEXT.md, keeping format-specific PDF terminology where technically required
- [ ] 3.2 Move the sole production `read_text` helper to its owning module and delete production-dead normalization functions plus their module tests

## 4. Verification (former hardening 5.5)

- [ ] 4.1 Run the full backend suite, `pnpm --filter studio test` and `build` if studio docs changed, `openspec validate parsing-docs-cleanup --strict`, and `git diff --check`
