# FREE repository context

Use the existing code to establish current behavior. The
[product and safety contract](docs/product-contract.md) defines required
behavior. Report every mismatch between code and documentation you encounter
during the task in your final reply.

- Read `docs/product-contract.md` before changing authentication, persistence,
  deployment, database lifecycle, or verification. It is the normative product
  and safety contract.
- Read `CONTEXT.md` before naming or changing domain concepts.
- Read `CONTRIBUTING.md` when recording plans, unresolved work, or durable
  decisions.
- For Parsing Service changes, read `apps/parsing_service/README.md` and
  its local `CLAUDE.md`.
- For Studio changes, read `apps/studio/CLAUDE.md`.
- Code changes → a worktree from `origin/dev`, the PR base. Follow
  [the worktree lifecycle](CONTRIBUTING.md#worktree-lifecycle): resolve the
  common Git directory and place worktrees in the main checkout's sibling
  `<repository>.worktrees/`, never relative to the current worktree.
- Reuse the worktree assigned to the current task. Do not create worktrees for
  read-only investigation or recursively copy checkouts, dependency directories,
  or other worktrees.
- Documentation-only work needs no dependency installation. For Node-only work,
  use `FREE_SKIP_PYTHON=1 pnpm install --frozen-lockfile`; install Python only
  when the task needs Parsing Service execution. Do not skip required tests.
- Retire completed worktrees after preserving uncommitted/untracked work and
  required ignored evidence. Never force removal or infer disposability from
  age, a branch name, or a merged PR alone. Report retained worktrees and why.
- `(spec, *Section*)` in code comments →
  `docs/design/unified-durable-execution.md`.
- This repository is public: no credentials, internal hostnames/IPs, personal
  data or non-redistributable documents in tracked files (see `CONTRIBUTING.md`).

## Task completion

Make reversible local decisions and complete the authorized work. Verify the
affected behavior. In your final reply, report the checks you ran, what remains
unverified, and any blockers.

## Sustainable design

- Keep the codebase easy to change by giving modules simple interfaces and
  avoiding layers that only pass calls through.
- Handle complexity and edge cases inside the module so callers can use the
  standard flow.

## Commands

- `pnpm test`: run the fast unit and static checks without a running stack
- `pnpm build`: build Studio
- `pnpm lint`: lint Studio
- `pnpm dev`: start the local Compose stack

Before requesting review of code changes, run `pnpm typecheck`, `pnpm lint`,
and `pnpm test:unit` as required by [CONTRIBUTING.md](CONTRIBUTING.md#workflow),
along with the [verification tiers](docs/operations/local-development.md#verification)
affected by the change.

## Conventions

- JavaScript and TypeScript use ESM `import` and `export` syntax.
- JavaScript and TypeScript test files use a `.test.` infix.
- Parsing Service Python tests use pytest's `test_*.py` naming convention.
