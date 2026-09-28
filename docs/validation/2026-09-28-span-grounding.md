# Span grounding prototype — 2026-09-28

Status: source-span verification and unresolved-path scheduling implemented and
tested in `feat/extraction-span-grounding`; schema policy, retrieval and live
evaluation remain unfinished. See the [plan](../plans/2026-09-28-span-grounding.md).
Existing frozen study runs and production defaults are unchanged.

## Implemented behavior

`grounding=spans` offers deterministic ranges over complete canonical passage
text, plus intact table cells. The model returns an offered ID and attribution
boolean. The service reconstructs exact quotes and offsets, retaining canonical
parent/cell identity and measured or explicitly coarse geometry. Batches start
with 32 claims and split under actual token admission; malformed, missing,
unknown, negatively attributed and truncated decisions cannot create support.

`grounding_schedule=unresolved` independently carries full supported record
paths across units. Unsupported and unanswered claims remain eligible. This
avoids repeated verification after support, but does not search exhaustively
for contradictions. Schema diagnostic fields are still verified like other
populated leaves until the separately planned policy implementation lands.

## Verification

All commands used the existing interpreter at
`/home/gennaro/projects/FREE/prototypes/parsing_service/.venv/bin/python`, with
`PYTHONPATH=src:.` and `PYTHONDONTWRITEBYTECODE=1`, from this worktree's
`prototypes/parsing_service` directory.

- `-m pytest -q tests/test_extraction_span_grounding.py`: **20 passed**. Cases
  cover exact Unicode/control-character preservation, repeated occurrences,
  long cells, merged headers, measured/coarse geometry, negative/missing/unknown
  support, batching, refusal, truncation, cancellation and assembled scheduling.
- Existing method/structure/stage regression files: **72 passed**.
- `-m pytest -q -m 'not postgres and not live_model'`: **1,090 passed,
  72 skipped, 74 deselected**, with three existing dependency deprecations.
  This run included the first 18 new tests; two additional long-cell/occurrence
  tests subsequently passed in the 20-test focused run. No serving code changed
  between those runs.
- Six scripted full/bounded × semantic/quoted/off comparisons match the base
  checkout byte-for-byte for every request and artifact after removing only
  top-level start time and elapsed time. Evidence lives under
  `artifacts/extraction-ablation/span-grounding-20260928/` in the primary
  workspace: `reference-regression.py`, before/after JSON and
  `reference-verification.json`. Shared output SHA-256:
  `f1d993065b3875d34b069b98fa2a07c139ed7353597bb7d3e13bfd3130e06483`.
- OpenSpec strict validation and `git diff --check` pass. Manual bloat review
  covers new files; the scanner reports no findings in changed tracked code.
  Named method/scheduling controls are required experimental factors. No new
  dependency, service, queue, compatibility wrapper or automatic retry was added.

These checks establish deterministic implementation behavior. They do not
measure fresh model savings, claim entailment, retrieval recall, independently
reviewed table attribution, or authenticated product performance. The new
comparison must freeze identical upstream records before inference. All existing
R1/R2a/R3/R4 completion and final-report obligations remain open.
