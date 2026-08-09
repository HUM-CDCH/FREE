# Contributing

## Workflow

- Work on a branch, open a pull request, get one review, then merge.
- Keep PRs small. Aim for something a teammate can review in 10–15 minutes.
  Smaller PRs are easier to discuss, easier to revert, and surface design
  questions earlier.
- Use GitHub Issues for tasks. Reference the issue number in your PR
  (e.g. `Closes #12`).

## Labels

Use topic labels to make it clear which part of the system an issue touches:
`frontend`, `backend`, `evaluation`, `examples`, `docs`.

## Docs

Keep domain language in [CONTEXT.md](CONTEXT.md), durable decisions in
`docs/adr/`, and current contracts beside the product area they describe.
Track temporary plans and open questions in GitHub Issues or an active OpenSpec
change instead of adding handoff ledgers to `docs/`.
