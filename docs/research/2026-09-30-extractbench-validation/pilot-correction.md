# Pilot provenance correction, 2026-09-30

The original pilot manifests, predictions and reports are preserved. Their original
README is historical; its claim that only `study.py` differs from the checkpoint
is inaccurate. All three 99-file manifests differ from `f5827cd7` in these two files
(the other 97 match):

| File | Pilot SHA-256 | Checkpoint SHA-256 |
| --- | --- | --- |
| `evaluate.py` | `4eccb898c8c3ef6457cfb5c13cd96d0a0c1cb545689875b55768c10b6ed86eb4` | `68d151ec6b4bcf11c669ccc0ea02dd8afcdc313f811e47ae4d32ec92cc63fd2d` |
| `study.py` | `97dc5148efd10bc183fa24098b8218ecbb41a31f877ba2b3611b2de1bf46a6d3` | `8bbb49fca34a84e4e30e9a45a5850b2b3a9119cd86b3f02cb5c290a774682875` |

Checkpoint preparation removed a trailing blank line from `evaluate.py`; the archived
pilot predates the reporting guards in `study.py`. Do not infer byte identity from
semantic similarity. Evaluator v2 additionally changes exact comparison, alternative
annotations, evidence refinement, nested scoring and reporting. New execution also
fixes recovery-boundary/citation scope, budget admission and source-binding checks.
V2 re-scoring evaluates old model predictions under the newer evaluation contract;
it does not rerun extraction or simulate fixes to those original executions.

The opening “Only dev was run” statement is also too broad: the archived synthetic
pilot contains five fit and three calibration cells for `combined`, as its own
table records. The new reports cover 45 development cells plus those eight cells
(53 total), without fitting another model or using any test split. Original JSON
reports and manifests are unchanged; `rescore-integrity.json` records their hashes.

The pilot's universal “22 groups” statement is superseded by the
[method-specific audit](../2026-09-30-extraction-harness-methods.md): for its LTT HB
single-start fixed sequence, the zero-loss feasibility floor is
`ceil(log(delta)/log(1-alpha))`; for CRC it is `ceil(B/alpha-1)`. Neither is an
adequacy rule, and this screening study makes no formal certification claim.
