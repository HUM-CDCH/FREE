# PR #267 Article resolution: rerun 2 of the annotated comparison

Declared before any model call of this rerun. Nothing below changes after the first call; any deviation is reported
as a deviation.

## Why

Rerun 1 (`../rerun-1/results.md`, code `6b4a2b9b`) did not accept default-on resolution. Q passed every criterion;
N failed A1 and A3 because on two papers the reasoning model answered the leave-out list form with the items it meant
to keep (the same items its first-execution answer had kept), so every own item of H4 left.

## What changed (code only)

Code: `d21f99e6d7034bb004d2cd8958ddb4861405c7db` (resolver blob `5a284de09aaab69fcc72847ef0fc9c6fac715942`), one commit after `6b4a2b9b`:

- A list answer labels every item OWN, OTHER or REPEAT (REPEAT still offered only for an item equal to another in its
  list); the reply schema requires every label.
- An answer that leaves an item unlabelled keeps assembly.
- A REPEAT leaves only beside an equal item labelled OWN.

Item display (whole, without empty fields, at its least printed value) and scalar resolution are as in rerun 1.

## What does not change

Everything else of `../protocol.md` (sha256 `f1ee966a…`) as amended by `../amendment-1.md` (sha256 `0b3f506d…`):
corpus, sealed gold, schema, harness, conditions N and Q, Article settings, live vLLM servers on Baratheon, one
execution per paper and condition with no reruns or best-of-N, deterministic matching, measures, adjudication of every
dropped item against the source text, and acceptance criteria A1-A4 in both conditions. Scoring uses `../score.py`
unchanged. Seal hashes in `seal.json`.

## Limits declared in advance

- This is the third execution on the same 12 papers, and both fixes were designed from what earlier executions on
  them dropped. Acceptance here shows the observed failures did not recur; it is not evidence from unseen papers.
  Whatever the result, the maintainer decides whether to lift the hold, and a confirmation on papers outside this
  corpus is recommended before default-on release.
- The live servers are not deterministic at temperature 0; within each run, assembly alone and resolution still come
  from the same readings.

## Decision rule

If every criterion holds in both conditions, the results are posted on PR #267 and the maintainer decides whether to
lift the hold. If any criterion fails in either condition, the hold stays and the results are posted without lifting
it. No further fix-and-rerun cycle follows this one without the maintainer's decision.
