# Development feasibility and scoring audit, 2026-09-30

Status: completed offline audit of
`406263e58c030b367af75ddf1a9e16717ac9c1e5` on
`feat/extraction-research-harness`. This increment adds audit artifacts only.
Production, the stacked base, extraction/scoring source, frozen configurations,
historical evidence and all eight held-out groups are unchanged. The offline
audit made **zero fresh extraction/OCR/tokenizer requests**. The separate
user-requested Claude consultations are accounted in [sparring metadata](sparring-metadata.json)
and are not development inference.

The bounded development study closes as **incomplete**, with 13/48 scored cells
and no challenger selected. The [Claude Code Fable 5.1 sparring decision](sparring-decision.md)
withdraws the earlier 150-minute pilot, added completeness gate and handwritten
semantic guidance. The next concrete prerequisite is a regression-tested
cumulative-cell-budget reproducibility fix; this checkpoint does not implement it.
Schema fidelity remains unresolved. No additional validation spending is authorized.
The revised [protocol disposition](protocol-amendment.md) records those boundaries.

## Findings

- **Illinois labels are consistent with the original field definitions.** All
  28 populated-versus-null section disagreements assign the document title to
  a field that excludes titles. No gold/scorer defect was established.
- **All Illinois errors were traced.** Seven billing-basis vocabulary errors,
  one issuer-specificity error and 21 capitalization-only disagreements complete
  the ledger. Raw F1 remains .57, canonical F1 .78, and complete repeated records
  zero. Matching is correct for all 28 repeated records.
- **Structural sanitization removes legitimate field semantics along with
  answer-bearing descriptions.** This is a plausible contributor, not an
  experimentally established cause. Do not reinstate the original descriptions
  or change the published comparator to erase errors.
- **More time alone cannot repair Viega's cached output.** Five recovery halves
  still hit the output cap at maximum subdivision depth.
- **The full recovery matrix does not fit its allowance.** The 268 nominal
  requests expand to 804 before caps; DD1155 and Erie also conflict with cell
  call/token ceilings. Smaller windows increase call counts substantially.
- **Resumed cell budgets need correction.** An executable synthetic case spends
  three calls across attempts under a configured two-call cell cap while staying
  within the study cap. This audit changes no harness implementation.
- **Textless pages cannot simply be discarded.** Visually inspected development
  examples include a nonblank brand page, a substantive form and prose/tables.
  No OCR was run and blocked groups' annotations remain unopened.

Read the [error ledger](error-ledger.md), [machine-readable scoring audit](scoring-audit.json)
and [resource budget](resource-budget.md) for evidence, limitations and local
source references. Semantic support, exact geometry, human adjudication and
long/cross-page extraction quality remain unvalidated.

## Verification and reproduction

The frozen continuation accounting audit was rerun into a **new ignored output
directory**, reproducing 15 charged calls, 25,512 input / 52,300 output tokens,
one sealed cell and the incomplete comparison. This is replay of accounting and
scoring only; no generation or serving-tokenizer call occurs.

The new scoring helper reproduced all Illinois counts and both F1 values with
zero network attempts. The real-executor budget counterexample reproduced the
resume defect with a fabricated source and a scripted in-process provider only.
The targeted existing evaluator, v2-contract and study tests passed: **55 tests**.
Detailed preservation checks and hashes are recorded in [verification.json](verification.json).

From this worktree's `prototypes/parsing_service`, use the installed environment:

```bash
export PYTHONPATH=src:.
export AUDIT_PYTHON=/home/gebbaro/Progetti/FREE/prototypes/parsing_service/.venv/bin/python
export AUDIT_DOCS=../../docs/research/2026-09-30-extractbench-validation/development-audit

# Choose a new filename; the helper refuses to overwrite existing evidence.
"$AUDIT_PYTHON" "$AUDIT_DOCS/audit_scoring.py" \
  ../../.scratch/extractbench-v2-development \
  /tmp/extractbench-illinois-audit-repeat.json

"$AUDIT_PYTHON" "$AUDIT_DOCS/reproduce_budget_reset.py"

"$AUDIT_PYTHON" -m pytest -q \
  tests/test_harness_evaluate.py tests/test_harness_v2.py \
  tests/test_harness_study.py -m 'not live_model' \
  --basetemp=/tmp/extractbench-audit-repeat-tests
```

For accounting reproduction, follow the existing
[offline audit command](../development-continuation/reproduce.md#offline-verification-and-final-audit)
with a new output directory. The resource report contains its metadata-only
arithmetic and development-source-only window-count reproduction commands.
All helpers leave PDFs, source text, gold, model replies and caches in ignored
storage; the new public ledger retains only identifiers, counts and hashes.

CodeGraph was tried first, but its index belonged to the main worktree and omitted
the harness-only symbols. Current branch source was read directly after that
warning. No indexing, dependency installation, remote deployment action,
production change, challenger selection or held-out execution occurred.
