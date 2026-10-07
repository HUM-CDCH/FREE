# FREE repository context

- Read `README.md` before changing authentication, persistence, deployment,
  database lifecycle, or verification. It is the normative product and safety
  contract.
- Read `CONTEXT.md` before naming or changing domain concepts.
- Read `CONTRIBUTING.md` when recording plans, unresolved work, or durable
  decisions.
- For Parsing Service changes, read `prototypes/parsing_service/README.md` and
  its local `CLAUDE.md`.
- For Studio changes, read `prototypes/studio/CLAUDE.md`.
- Baratheon (Spark) verification of a commit → `scripts/baratheon-verify.sh`.
- Code changes → a worktree from `origin/dev`, the PR base (`origin/main` is
  stale): `git worktree add .claude/worktrees/<name> -b <branch> origin/dev`.
- `(spec, *Section*)` in code comments →
  `docs/plans/2026-09-24-unified-durable-execution.md`.
- Shared Baratheon release tooling → `scripts/ops/README.md`.
- Extraction diagnostics → `docs/operations/extraction-diagnostics.md`.
