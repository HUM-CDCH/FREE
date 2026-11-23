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
- For code changes, follow the [worktree lifecycle](CONTRIBUTING.md#worktree-lifecycle)
  starting from `origin/dev`. Reuse the task's assigned worktree. Preserve required
  ignored evidence before retirement and report any retained worktree and why.
- `(spec, *Section*)` in code comments →
  `docs/design/unified-durable-execution.md`.
- This repository is public: no credentials, internal hostnames/IPs, personal
  data or non-redistributable documents in tracked files (see `CONTRIBUTING.md`).

For reviews or investigations with independent questions, use subagents as
needed. Examples include checking Studio and Parsing Service against the same
contract, or checking separate architecture views against their implementations.
Keep a single causal trace with one agent.

Before requesting review, run the [local gates](CONTRIBUTING.md#workflow) and
the [verification tiers](docs/operations/local-development.md#verification)
affected by the change. The `dev` branch has no automatic CI.
