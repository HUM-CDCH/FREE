# Contributing

## Workflow

- Work on a branch from `dev`, open a pull request against `dev`, get one
  review, then merge. `dev` reaches `main` through merge PRs, which run the
  [`verify`](.github/workflows/verify.yml) workflow; a pull request against
  `dev` runs no CI, so run `pnpm typecheck`, `pnpm lint`, `pnpm test` and the
  [tiers](docs/operations/local-development.md#verification) your change
  touches before asking for review.
- Reviewers, human or agent, also check the diff against
  [CODING_STANDARDS.md](CODING_STANDARDS.md).
- Give each PR one coherent, testable review boundary: the smallest change that
  is still complete end to end, whatever its size. A larger PR is fine when
  splitting it would leave a non-working layer, or when most of it is
  mechanical, generated, or review evidence.
- Use GitHub Issues for work that needs triage, planning, or coordination. A
  self-contained change may originate in its PR. Link the originating Issue
  when one exists; a stacked PR instead identifies its base, adjacent PRs, and
  merge order.

## Labels

Use topic labels to make it clear which part of the system an issue touches:
`frontend`, `backend`, `evaluation`, `examples`, `docs`.

## Docs

Keep domain language in [CONTEXT.md](CONTEXT.md), durable decisions in
`docs/adr/`, and current contracts beside the product area they describe.
Track unresolved work and open questions in GitHub Issues and pull requests.
Execution plans, run logs, review logs, and validation evidence go in the pull
request or Issue, not in `docs/`.

This repository is public. Never commit credentials, internal hostnames or IP
addresses, personal data, or documents you may not redistribute; test fixtures
use synthetic documents only.
