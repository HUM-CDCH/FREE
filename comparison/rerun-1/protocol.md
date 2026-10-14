# PR #267 Article resolution: rerun 1 of the annotated comparison

Declared before any model call of this rerun. Nothing below changes after the first call; any deviation is reported
as a deviation.

## Why

The first execution (`../results.md`) did not accept default-on resolution: in condition Q it dropped an own sample
(A1), and in both conditions it dropped second readings of own samples that carried printed values the kept copy
lacked. The maintainer chose to fix list resolution and rerun the same comparison before deciding on merge.

## What changed (code only)

Code: `6b4a2b9b02c54847b5883d7cd24588f8b3076749` (resolver blob `7a343e26c0c216ef2953c531c715ab6b108bb880`), one commit after `14c79566`:

- A list answer names the items to leave out, each with a reason (OTHER: another work's or entity's item; REPEAT:
  the same thing printed again), instead of the items to keep. An item the model does not name is kept.
- REPEAT is offered only for an item equal to another in its list, and leaves an item out only beside an equal item
  that stays. A differently filled reading of the same sample cannot be left out as a repeat.
- Each item is shown whole, without empty fields (it was cut at 200 characters), at the place in the source where
  its value printed the fewest times is (it was its first string, usually the species name).

Scalar resolution is unchanged.

## What does not change

Everything else of `../protocol.md` (sha256 `f1ee966a…`) as amended by `../amendment-1.md` (sha256 `0b3f506d…`):
corpus, sealed gold, schema (`../harness/schema.json`, sha256 `1e2a3e86…`), harness (`../harness/run_paper.py`,
sha256 `09b6ea39…`), conditions N and Q, Article settings, live vLLM servers on Baratheon, one execution per paper and
condition with no reruns or best-of-N, deterministic matching, measures, adjudication of every dropped item against the
source text, and acceptance criteria A1-A4 in both conditions. Scoring uses `../score.py` unchanged.

## Limits declared in advance

- The fix was designed from the first execution's dropped items on this same 12-paper corpus. The rerun shows whether
  those failures recur; it is not an independent test set, and acceptance on it is weaker evidence than acceptance
  on unseen papers would be.
- The live servers are not deterministic at temperature 0, so part readings differ from the first execution. Within
  each run, assembly alone and resolution still come from the same readings; differences from the first run mix
  reading variance with the code change.

## Decision rule

If every criterion holds in both conditions, the results are posted on PR #267 and the maintainer decides whether to
lift the hold. If any criterion fails in either condition, the hold stays and the results are posted without lifting
it.
