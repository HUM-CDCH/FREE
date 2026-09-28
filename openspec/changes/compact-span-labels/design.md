# Design

## Context

See proposal.md for motivation. `verify()` already maps E-number labels to canonical candidates in quoted and semantic modes. Span mode alone uses canonical IDs as transport labels. Its proof materialization already reads the selected candidate's canonical ID, text, offsets and geometry.

## Goals / Non-Goals

**Goals:** reuse that label mapping for spans, retain the entire catalogue and existing table context, and measure admission with the registered tokenizer and budget.

**Non-Goals:** change splitting, retrieval, attestation, eligibility, early exit, production defaults or frozen R5; make semantic quality claims from scripted replies.

## Decisions

Use E1, E2, ... over the complete ordered candidate catalogue before batching. Labels stay stable when claim batches split or filter ineligible table cells. Only offered labels resolve; canonical IDs returned by the model are rejected like any unoffered label. Persist canonical proofs, never transport aliases.

Bump `spans.VERSION` to 2, which is already included only in span-method fingerprints/artifacts. Keep old-mode request bytes and fingerprints unchanged. Avoid a version-selection flag: frozen R5 retains the earlier implementation for reproduction.

First check all-NONE admission with unchanged fixed records and source units. Start with Hvissinge and the other highest-refusal sources, plus the completed pilot source. Save separate input/code/probe pins and compare admitted/refused claim–unit pairs, batch counts and actual tokens. Compare schema size separately because this provider does not render it into the prompt. No model generation.

## Risks / Trade-offs

- Short aliases can change model choices → report tokenizer results as admission evidence only; fresh quality comparison remains a separate gate.
- Source text may still exceed the budget → preserve explicit refusals and complete source text; no truncation.
- Request-local labels can be confused with persistent identities → test repeated occurrences, filtered cells and split batches against exact canonical proofs.
