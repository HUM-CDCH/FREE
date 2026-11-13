# FREE repository context

If the docs and the existing code disagree, follow the existing code, and list every mismatch in your final reply.

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

## Sustainable design

This codebase is yours: what it does and how it is built depend entirely on your
choices, and you will continue developing it over time. Build it with sustainable
design in mind:

- **Strategic approach, not tactical:** your primary goal is to keep the structure
  clean and easy to change tomorrow, as well as making the code work today.
- **Deep modules:** design components that offer powerful functionality through
  simple interfaces. Avoid fragmentation into shallow modules full of pass-through
  methods.
- **Pull complexity downward:** a module's ease of use matters more than its ease
  of implementation. Absorb complexity within the module instead of pushing it
  onto callers.
- **Define errors out of existence:** design abstractions so that edge cases fit
  naturally into the standard flow, reducing unnecessary branches and exceptions.

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
