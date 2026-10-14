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

- `pnpm test`: run the fast unit and static checks
- `pnpm build`: build Studio
- `pnpm lint`: lint Studio
- `pnpm dev`: start the local Compose stack

## Code Map

- `apps/`: application source
- `packages/`: packages
- `tests/`: automated tests
- `docs/`: project documentation

## Conventions

- JavaScript and TypeScript use ESM `import` and `export` syntax.
- JavaScript and TypeScript test files use a `.test.` infix.
- Parsing Service Python tests use pytest's `test_*.py` naming convention.
