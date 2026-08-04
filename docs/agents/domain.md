# Domain Docs

FREE uses a single domain context.

## Before exploring, read these

- `CONTEXT.md` at the repository root.
- Relevant decisions under `docs/adr/`.

If either is absent, proceed silently. Create domain documentation only when terminology or decisions are actually resolved.

## File structure

/
├── CONTEXT.md
└── docs/adr/

## Use the glossary vocabulary

When naming domain concepts in issues, proposals, tests, or implementation, use the terms defined in `CONTEXT.md`. Avoid synonyms that the glossary explicitly rejects.

If a required concept is missing, reconsider whether it belongs to the domain or note the gap for domain-modeling work.

## Flag ADR conflicts

Explicitly identify proposals that contradict an existing ADR instead of silently overriding it.
