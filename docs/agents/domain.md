# Domain Docs

How the engineering skills should consume this repo's domain documentation when
exploring the codebase.

## Before exploring, read these

- **`CONTEXT.md`** at the repo root.
- **`docs/adr/`** — read ADRs that touch the area you're about to work in.

If either location doesn't exist, **proceed silently**. Don't flag its absence
or suggest creating it upfront. The `/domain-modeling` skill creates domain
documents lazily when terms or decisions are resolved.

## File structure

FREE uses a single-context layout:

```text
/
├── CONTEXT.md
├── docs/adr/
└── prototypes/
    ├── parsing_service/
    └── studio/
```

## Use the glossary's vocabulary

When output names a domain concept—in an issue title, refactor proposal,
hypothesis, or test name—use the term defined in `CONTEXT.md`. Don't drift to
synonyms the glossary explicitly avoids.

If a needed concept isn't in the glossary, either reconsider the invented
language or note a genuine gap for `/domain-modeling`.

## Flag ADR conflicts

If output contradicts an existing ADR, surface it explicitly rather than
silently overriding:

> _Contradicts ADR-0007 (event-sourced orders) — but worth reopening because…_
