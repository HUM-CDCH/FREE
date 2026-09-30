# Prospective development continuation amendment, 2026-09-30

Status: written before any continuation generation. The user supplied the completed
clean-vLLM comparison and instructed this session to proceed. This amendment opens
only the previously reserved development work. It changes no production defaults,
model/server, parser, extraction configuration, evaluator, normalization policy,
source-group selection or held-out handling.

The original [smoke protocol](../protocol.md), reports, requests and interruption
remain immutable. Its exact-usage gate **failed**. This amendment does not relabel
that gate as passed: it prospectively permits bounded continuation when historical
unknown spending has a documented conservative bound and all earlier call charges
remain consumed. The smoke study retains 37 conservatively charged calls, 56,213
known input and 28,378 known output tokens, and one unknown request bounded by
36,864 additional tokens. Exact usage remains unknown. Neither replay nor a new
output directory refunds that spending.

The continuation keeps its original **400 fresh-call** reservation. Combined with
the smoke charge this permits at most 437 development calls, within the original
500-call allocation; the unused smoke allowance is not reassigned. The separate
synthetic throughput experiment (including its discarded setup attempt) is not
development evidence and does not replace the smoke accounting record.

## Admission and unchanged comparison

The [derived selection](selection.json) contains exactly the original nine non-smoke
development representatives and their 24 related family members. No source group
was replaced or selected using predictions. All nine PDFs were inspected by the
same pinned PDFium native-line adapter. Seven produced text on every page and
passed raw/canonical gold-as-prediction roundtrips. Two failed the frozen ingestion
rule: Byline page 24 and CLIN pages 44–60, 64–66 have no native text. This is an
adapter limitation, not proof that those pages lack meaningful content. No OCR or
page deletion is introduced.

The DD1155 source needs 68 nominal requests per arm, above the unchanged 60-call
cell cap. It remains unrun. The other six representatives form the whole admitted
matrix: **24 cells, 268 nominal calls**. There is no budget-driven ranking within
that matrix. Every nominal request fits the served 32,768-token context, and every
arm's counted inputs plus all 4,096-token output reservations fit its 250,000-token
cell cap. Gold and annotations are excluded from every request-construction input.

The theoretical recovery expansion is 804 calls before runtime caps; it is **not**
an approved allowance or a completion guarantee. Erie nominally needs 36 calls and
211,308–212,640 reserved tokens per arm, leaving only 24 calls and 37,360–38,692
tokens for recovery at those output maxima. Existing cell and global admission
checks cap actual spending. Any failed, partial or budget-stopped cells stay visible.

A0/A1/A2/A3 retain the exact configurations from `study-development.json`, including
one worker, temperature 0, seed 20260930, maximum 4,096 output tokens, one-level
subdivision, no repeated identical retries, and equivalent quote/ID refinement.
The existing deterministic cell shuffle uses seed 20260930. The admitted dataset
path differs because the three prerequisite failures remain outside inference;
the report retains them in the full nine-document continuation population.

The underlying implementation remains `677ec96f6fc0765d0396df977098b0d373ac0edb`,
with source aggregate
`3848aa62401d5185074fdd3321450d8ecc185c5372b17043bb291a7ac4fc1408`.
The separate runner is hashed in the launch manifest; it adds an admission deadline
and write-once request-usage journal without modifying successful requests or
scoring. Deployment/container identity is checked against the frozen preflight.

## Runtime and interruption policy

The default admission window is **eight hours**; a shorter user-selected window is
recorded before launch. No fresh request is admitted after that deadline. The one
in-flight request may drain under its existing 900-second HTTP timeout so usage can
be recorded. Consequently total wall time may exceed the admission window by that
drain time and local bookkeeping. A task-owned `STOP_REQUESTS` file can stop new
requests through the same mechanism. Deadline denial consumes no new call but
never refunds previous calls. Cache replays remain separate.

The runner runs independently of the chat tool's process sandbox. It preserves
per-request started/finished records, known usage and unknown usage. A crash or
unfinished attempt forbids automatic restart; reconcile the journal, response
cache and call charges before any further attempt. Nothing kills or restarts the
existing model server. No background run may silently reset its deadline or call
allowance by choosing a different output directory.

The original population is still **12 development groups / 12 representatives**,
with at most nine groups executable in this increment including the three smoke
groups. All eight held-out groups remain metadata-only: no PDF download, annotation
decoding or inference. No long-category document is admitted, so this increment
cannot establish long-document performance. An incomplete comparison cannot select
a challenger under the earlier proposal to complete all twelve development groups.
No production promotion, formal certification or leaderboard comparison follows.
