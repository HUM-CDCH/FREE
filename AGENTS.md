# FREE repository context

- Read `docs/product-contract.md` before changing authentication, persistence,
  deployment, database lifecycle, or verification. It is the normative product
  and safety contract.
- Read `CONTEXT.md` before naming or changing domain concepts.
- Read `CONTRIBUTING.md` when recording plans, unresolved work, or durable
  decisions.
- For Parsing Service changes, read `apps/parsing_service/README.md` and
  its local `CLAUDE.md`.
- For Studio changes, read `apps/studio/CLAUDE.md`.
- Code changes → a worktree from `origin/dev`, the PR base:
  `git worktree add .claude/worktrees/<name> -b <branch> origin/dev`.
- `(spec, *Section*)` in code comments →
  `docs/design/unified-durable-execution.md`.
- This repository is public: no credentials, internal hostnames/IPs, personal
  data or non-redistributable documents in tracked files (see `CONTRIBUTING.md`).

## Commands

- `pnpm test`: run the full test suite
- `pnpm build`: build the project
- `pnpm lint`: run the lint task
- `pnpm dev`: run the development task

## Code Map

- `apps/`: application source
- `packages/`: packages
- `tests/`: automated tests
- `docs/`: project documentation

## Conventions

- Use ESM `import` and `export` syntax.
- Name test files with a `.test.` infix.
