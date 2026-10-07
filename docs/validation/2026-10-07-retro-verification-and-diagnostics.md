# Export incident follow-up — 7 October 2026

Status: implemented; independent review, hosted CI and shared-helper installation
are recorded in the resulting pull request and operator evidence.

This follows the readable-export and empty-discovery corrections in PRs #208
and #209. It closes their verification and operational gaps together:

- Hosted CI runs the existing fast Python checks in a separate CPU environment
  using the release lock's versions. The production GPU environment is unchanged.
- A trusted `dev` workflow publishes an annotated, commit-bound verification tag
  only after both Node and Python jobs succeed. The shared release command
  requires that evidence before advancing source or deploying. It checks built
  and running image labels against the existing per-context revision calculator.
- The review contract requires the reported scenario and meaningful output
  evidence, including record counts and representative transfer sizes.
- The Spark verification helper accepts a focused Python tier and a custom SSH
  configuration for both transports, installs frozen dependencies, and probes
  tracing, grammar and test imports before verification.
- An owner-scoped diagnostic command samples saved calls in a read-only
  transaction. Metadata is bounded; source text and replies require private,
  opt-in files. Original payloads and provider credentials stay out of stdout.

## Local acceptance evidence

- Existing fast Python suite: 1,440 passed, 72 skipped, 88 deselected.
- Script checks: 80 passed, including rejection of failed, pending, mismatched
  and untrusted release evidence.
- Shared helper checks: 42 passed, including real temporary Git repositories,
  container selection and rejection of unknown image revisions before stopping
  services.
- Extraction diagnostics passed unit, TypeScript and real PostgreSQL checks.
  The integration test checks ownership on both compared extractions, deleted
  heads, bounded sampling, source/prompt differences, read-only transaction
  enforcement, private output and unchanged retained capture counts.

Reproduce using `pnpm test:unit:node`, `pnpm test:unit:python`, `pnpm test:ops`,
and the Extraction package's `test`, `typecheck` and guarded `test:postgres`
scripts. The CPU environment is prepared by `scripts/install-python-cpu.mjs`.
Local logs are retained in the ignored `artifacts/retro-hardening-20261007/`.

## Release evidence boundary

The verification tag is repository evidence, not a cryptographic signature.
Its namespace belongs to CI; manual tags are outside the operator contract.
PR runs cannot publish it. Shared-helper installation follows the reviewed-byte,
backup and ownership-preserving procedure in `scripts/ops/README.md`, after the
merged `dev` commit finishes verification and its tag is available.

Live acceptance records the installed helper hash, source commit, context image
revisions, health, database counts and protected container identities. Diagnostics
on the incident's saved runs remain read-only and use metadata output.
