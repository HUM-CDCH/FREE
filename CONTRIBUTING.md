# Contributing

## Workflow

- Work on a branch, open a pull request, get one review, then merge.
- Reviewers, human or agent, also check the diff against
  [CODING_STANDARDS.md](CODING_STANDARDS.md).
- Give each PR one coherent, testable review boundary. Use the smallest boundary
  that remains end-to-end complete; reviewability is not measured by elapsed
  time or line count. A larger PR is appropriate when splitting it would leave
  a non-working intermediate layer or when most of the change is mechanical,
  generated, or review evidence.
- Use GitHub Issues for work that needs triage, planning, or coordination. A
  self-contained change may originate in its PR. Link the originating Issue or
  OpenSpec change when one exists; a stacked PR instead identifies its base,
  adjacent PRs, and merge order. Do not create a placeholder Issue solely to
  satisfy a PR template.

## Labels

Use topic labels to make it clear which part of the system an issue touches:
`frontend`, `backend`, `evaluation`, `examples`, `docs`.

## Docs

Keep domain language in [CONTEXT.md](CONTEXT.md), durable decisions in
`docs/adr/`, and current contracts beside the product area they describe.
Track unresolved work and open questions in GitHub Issues or an active OpenSpec
change. `docs/` may hold dated execution plans, defect ledgers, and validation
evidence when they form a reproducible review record that remains useful with
the code. Date those artifacts and, where applicable, state their status and
link the outcome or superseding artifact so they do not become ambiguous
handoff notes.
