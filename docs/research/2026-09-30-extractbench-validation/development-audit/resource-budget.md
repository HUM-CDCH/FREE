# Development resource and feasibility audit, 2026-09-30

Status: completed offline audit of `406263e58c030b367af75ddf1a9e16717ac9c1e5`.
This record proposes gates for future development work; it authorizes no execution.
The audit made **zero extraction, OCR, model, server or tokenizer requests** and
no downloads. It read saved development metadata, accounting and inference-only
inputs. It did not open held-out PDFs or annotations, change production or modify
source/configuration files. Private source text, gold and raw replies are omitted.

**Disposition after [Claude Code Fable 5.1 sparring](sparring-decision.md): close
the bounded increment as incomplete and fix cumulative cell admission before
resumption.** The Illinois envelope below is arithmetic, not a recommendation to
launch. A1–A3 would need three nominal / nine maximum new calls; the frozen A0
can be referenced only if all relevant identities match. Any common configuration
change requires a fresh A0. The proposed 150-minute extension is withdrawn.
The final protocol's complete-development condition applies to future challenger
selection, not to honestly closing this bounded increment with missing cells.

## Evidence and budget meanings

The [frozen study](../development-continuation/study.json) declares one worker,
4,000 layout characters per nominal chunk, 4,096 maximum generated tokens per
request, zero identical retries and one level of subdivision. Each cell has
60 fresh calls and 250,000 fresh input-plus-output tokens; the continuation has
a shared 400 fresh-call allowance. These limits are enforced when a fresh call
is admitted, not promises that every cell can finish. The projection is nominal
tasks multiplied by three for full depth-one recovery: one parent plus two
children. See [projection code](../../../../prototypes/parsing_service/experiments/harness/study.py#L168),
[recovery code](../../../../prototypes/parsing_service/experiments/harness/extract.py#L315)
and [meter admission](../../../../prototypes/parsing_service/experiments/harness/model.py#L140).

The 400 calls are **the continuation allowance**, separate from the preserved
37-call smoke charge. The [prospective continuation amendment](../development-continuation/protocol-amendment.md)
permits at most 437 development calls in those two reservations, within the
original 500-call allocation. Fifteen continuation calls were consumed; its
arithmetic balance is 385. The two-hour execution is closed, so that balance is
not permission to restart. The historical unknown request retains its additional
36,864-token upper bound. Neither replay nor a different output directory refunds
the historical calls or uncertainty. See [audit accounting](../development-continuation/audit.json).

In this report:

- **Measured** means response usage, request journal time or saved parser output.
- **Reserved** means counted input plus maximum permitted output, or the
  explicit conservative allowance for unknown usage. It is not actual usage.
- **Predicted** means call-tree arithmetic or decode extrapolation. It does not
  establish request-token fit, quality, source coverage or completion.

The saved throughput control measured approximately 7.8 generated tokens/s at
concurrency one on short synthetic requests. It found 0.143 seconds median
harness overhead and no meaningful decode-speed difference. The calculation
`calls × 4096 / 7.8` below is a **saturation decode estimate**, not an elapsed-time
upper bound or a prediction that every response will be that long. Prefill,
background load, HTTP failures and bookkeeping remain additional. The 900-second
HTTP timeout is passed to `requests.post`; multiplying it by calls is a timeout
planning allowance, not an independently enforced whole-run deadline.
See [measured summary](../throughput/summary.json),
[measurement definitions](../throughput/README.md#measurement-definitions) and
[actual HTTP adapter](../../../../prototypes/parsing_service/experiments/harness/model.py#L45).

## Native-text admission remains unresolved for two groups

The adapter uses the PDF's native lines through PDFium, with no OCR or geometry.
It rejects a whole representative when **any page has zero native characters**,
before decoding expected output or field rules. Byline has one such page, page
24 of 24. CLIN has twenty, pages 44–60 and 64–66 of 66. These are admission
failures, not evidence that the pages are blank or irrelevant. The saved parser
reproduction exactly reproduced all twelve development sources, including these
failures. See [adapter implementation](../../../../prototypes/parsing_service/experiments/harness/extractbench.py#L90),
[admission branch](../../../../prototypes/parsing_service/experiments/harness/extractbench.py#L146),
[adapter manifest](../development-continuation/adapter-manifest.json) and
[parser reproduction](../development-continuation/parser-reproduction.json).

The audit's development-only visual checks found nonblank raster content on
Byline page 24 (a branded end page), CLIN page 44 (a structured form) and CLIN
page 64 (prose and table content). These observations support treating native
text absence as an adapter limitation. They do not characterize all twenty
CLIN failure pages. No OCR or blocked-group annotation decoding was used; see
the [visual evidence in the error ledger](error-ledger.md).

Their eight cells must remain visible as blocked. Completing all twelve groups
requires a prospective, development-only decision about ingestion and its
verification. Removing pages or substituting groups would change the experiment.
An amended common ingestion path needs matching controls and new pins; this
audit did not assess the cost or reliability of an OCR alternative.

## The nominal matrix fits; its recovery tree does not

The saved [preflight](../development-continuation/preflight.json) admitted six
new representatives: 24 cells and 268 nominal requests. Counted nominal inputs
total 481,895 tokens. With every output at its maximum, their nominal reservation
totals 1,579,623 input-plus-output tokens across cells. These aggregate token
figures are not a shared token allowance; 250,000 applies separately to each cell.

| Group | Nominal calls per arm / four arms | Full recovery calls per arm / four arms | Nominal token reservation per arm | Four-arm saturation decode: nominal / recovery |
| --- | ---: | ---: | ---: | ---: |
| Illinois | 1 / 4 | 3 / 12 | 5,289–5,326 | 0.58 h / 1.75 h |
| Caterpillar | 2 / 8 | 6 / 24 | 10,642–10,716 | 1.17 h / 3.50 h |
| Lancaster | 3 / 12 | 9 / 36 | 17,017–17,128 | 1.75 h / 5.25 h |
| Viega | 9 / 36 | 27 / 108 | 55,885–56,218 | 5.25 h / 15.75 h |
| Mitchell valuation | 16 / 64 | 48 / 192 | 93,140–93,732 | 9.34 h / 28.01 h |
| Erie | 36 / 144 | 108 / 432 | 211,308–212,640 | 21.01 h / 63.02 h |
| **Admitted total** | **268** | **804** | **1,579,623 across cells** | **39.09 h / 117.28 h** |

These are cold-matrix projections, preserving the original preflight rather than
silently crediting cached requests. The full recovery bound of 804 exceeds the
400-call allowance. Erie alone requires 108 calls per arm at that bound, above
the 60-call cell cap. Its recovery-output maximum would already be 442,368 tokens
before counting any inputs, above the 250,000-token cap. At nominal maximum
outputs it has only 37,360–38,692 tokens and 24 calls left for recovery. The
runtime checks were enforced per attempt in the recorded run; the cumulative
resume limitation is documented below. They do not make every source region
processable.

DD1155 is a further, distinct blocker: 68 nominal calls per arm exceed 60. Raising
only the call cap is insufficient for nominal maximum-output admission because
`68 × 4096 = 278,528` exceeds 250,000 before any input. Its original preflight
skipped request token counting after call rejection, so exact input reservations
for DD1155 remain unavailable. No long-category group was admitted. See
[preflight decision order](../development-continuation/preflight.py#L44) and
[population accounting](../development-continuation/population.json).

The already consumed requests are one Illinois nominal call, six Viega nominal
calls and eight Viega recovery calls. With exact cache reuse, the admitted
matrix has **261 not-yet-sent nominal requests**. A nominal-only finish would
therefore total at least 276 fresh continuation calls including the eight
already consumed recovery calls. That lower bound says nothing about repairing
the failed Viega regions. At maximum outputs the 261 requests alone correspond
to 38.07 hours of saturation decode. Future forecasts must reconcile the exact
cache and cumulative ledger before counting recovery or promising completion;
the closed two-hour run cannot simply be extended under its old authorization.

## Viega shows repeated failure after subdivision

The A2 cell sent fourteen requests, consumed 24,319 input and 50,434 output tokens,
and remained unsealed. Known response time was 6,510.14 seconds, **108.50 minutes**.
Across the whole continuation it was 6,751.14 seconds versus 6,753.19 seconds of
runner wall time. This is client-observed response time, including network and
server time; it is not a saved engine-only decode measurement. See
[request journal and cache reconciliation](../development-continuation/audit.json)
and [runner finish](../development-continuation/runner-finished.json).

| Saved Viega region | Parent response | First recovery half | Second recovery half |
| --- | --- | --- | --- |
| c0 | stopped normally, 3,877 output tokens | not needed | not needed |
| c1 | stopped normally, 4,041 output tokens | not needed | not needed |
| c2 | capped at 4,096 | stopped normally, 2,332 | capped at 4,096 |
| c3 | capped at 4,096 | stopped normally, 1,546 | capped at 4,096 |
| c4 | capped at 4,096 | capped at 4,096 | capped at 4,096 |
| c5 | capped at 4,096 | stopped normally, 1,774 | capped at 4,096 |
| c6–c8 | not sent | not sent | not sent |

Nine responses were capped: four nominal parents and five recovery children.
The eight recovery calls read passage subdivisions, not field subdivisions.
Capped calls took 527.99–529.91 seconds, median **528.15 seconds**, consistent
with the measured decode rate. Subdivision reduced inputs but still left five
halves capped at the maximum declared depth. A normal stop alone does not prove
a correct extraction. The shared call layer rejects `finish_reason=length`
rather than accepting partial JSON. See [cutoff handling](../../../../prototypes/parsing_service/src/kei_exp/kie/extract/calls.py#L73)
and [subdivision construction](../../../../prototypes/parsing_service/experiments/harness/extract.py#L296).

The final request began before the 105-minute admission stop and drained normally.
`stopped_by_study_budget` names the generic denial path; it does not mean that
400 calls were spent. The [runtime amendment](../development-continuation/runtime-cap-amendment.md)
and [exit observation](../development-continuation/runtime-cap-finished.json)
document the elapsed-time stop. A same-request cache replay will retain the
nine capped replies and cannot repair their source regions. A different source
window or reply format is a new common configuration, with corresponding A0
reruns and no borrowed-control claim.

## Offline window-count sensitivity

This audit constructed chunks in memory from the seven saved development
inference inputs using the current `chunks_of` implementation. It sent no
requests and changed no study files. Counts include every primary passage in
order; they do not establish serving-token fit or extraction quality.

| Layout-character limit | Viega nominal / full recovery calls per arm | DD1155 nominal calls per arm | Six originally admitted groups: four-arm nominal calls |
| ---: | ---: | ---: | ---: |
| 1,000 | 36 / 108 | 286 | 1,084 |
| 2,000 | 18 / 54 | 138 | 540 |
| 3,000 | 12 / 36 | 91 | 356 |
| 4,000, frozen | 9 / 27 | 68 | 268 |
| 5,000 | 7 / 21 | 54 | 220 |
| 6,000 | 6 / 18 | 45 | 180 |

A 2,000-character Viega feasibility pilot has a call tree that fits 60 per arm;
1,000 does not. Applying 2,000 uniformly raises the six-group nominal matrix
above 400, and Erie alone becomes 73 nominal calls per arm. Increasing the
window to admit DD1155 has the opposite output-pressure tradeoff: at 5,000 the
seven native-passing non-smoke groups total 436 nominal calls across arms;
at 6,000 they total 360, but DD1155's full recovery tree is still 135 calls per
arm and Erie's is 72. No setting in this table is validated for token fit or
recommended as an extraction technique.

The hashed private inference inputs for the two sensitivity cases are
`9b35ed6ca8738fa30b9b139102c86a2f14654df2c4cd6712431d48d14d82073d`
(Viega) and
`0256e904d3e2a476e0eae1c9536db543551253c1f3b8320199f1aed81695d488`
(DD1155). Their source snapshots remain pinned by the
[adapter manifest](../development-continuation/adapter-manifest.json).

## Next paired development pilot and admission gates

For **unchanged frozen Illinois**, retain the sealed A0 control and prospectively
schedule A1–A3 together. The pilot adds three nominal calls or at most nine
depth-one recovery calls. Its exact nominal counted-input reservation is 3,676
tokens and its nominal maximum-output reservation is 12,288, for **15,964 tokens
total**. The measured A0 call cost 1,193 input and 1,866 output tokens and took
241.00 seconds; it does not predict the verbosity or correctness of A1–A3.
See [Illinois preflight](../development-continuation/preflight.json) and
[sealed-control accounting](../development-continuation/audit.json).

| Prospective pilot envelope | New calls | New maximum outputs | Saturation decode estimate | HTTP-timeout planning allowance |
| --- | ---: | ---: | ---: | ---: |
| Illinois A1–A3, no recovery needed | 3 | 12,288 | 26.26 min | 45 min |
| Illinois A1–A3, full frozen recovery | 9 | 36,864 | 78.77 min | 135 min |
| Illinois all four arms, common configuration changed, frozen call-tree size retained | 4 nominal / 12 recovery | 16,384 / 49,152 | 35.01 / 105.03 min | 60 / 180 min |

At the existing conservative unknown-usage reservation of 36,864 tokens per
request, nine new calls reserve at most 331,776 tokens across the three new
cells, **110,592 per cell**, below 250,000. This deliberately loose bound is not
a measured recovery-input count and does not waive served-context admission.
The saturation decode calculation is below two hours, but the 135-minute
HTTP-timeout planning allowance exceeds that wall cap. Neither calculation
justifies enlarging the user's allowance. The earlier 150-minute proposal is
**withdrawn**. The closed execution cannot restart on unused call slots alone;
any new spending needs an explicit bounded decision. Any common configuration
change also requires new counts, a fresh A0 and a new experiment identity.

Before fresh execution, require:

1. The Illinois semantic audit and evaluator contract are settled; freeze those
   identities before paired reporting. Do not silently change old scores.
2. The administrative group-completion order is declared before execution.
   Keep the full original population and A0–A3 candidates. Complete all three
   remaining Illinois cells, then report the paired group; this is not permission
   to select a challenger on a smaller completed subset.
3. Reconcile existing sealed controls, cache hashes, usage and unknown bounds.
   Charge all prior attempts. Preserve the 400-call continuation ledger and the
   separate 37-call smoke ledger; an extra allowance belongs to a newly declared
   study. The stopped runner refuses an existing `runner-started.json`, so
   rerunning its command is not an authorized resume mechanism. See
   [runner refusal and pins](../development-continuation/run_bounded.py#L69).
4. **Enforce cumulative per-cell budgets across attempts before resuming any
   unsealed cell.** The current executor creates a new meter on each attempt
   ([study.py:204](../../../../prototypes/parsing_service/experiments/harness/study.py#L204)).
   The meter starts fresh counters at zero and cached replays bypass fresh
   reservations ([model.py:132–197](../../../../prototypes/parsing_service/experiments/harness/model.py#L132)).
   The global allowance subtracts earlier finished-attempt spending
   ([study.py:302–304](../../../../prototypes/parsing_service/experiments/harness/study.py#L302));
   the cell meter does not. Thus a later attempt could spend another 60 fresh
   calls/250,000 tokens despite prior cell charges. No recorded cell exceeded
   its limits in this run, but a future resume needs a cumulative admission
   wrapper or reviewed harness correction. Replays must remain separate.

   The [offline counterexample](reproduce_budget_reset.py) exercises the real
   executor with a fabricated source and a scripted provider while socket
   connections are prohibited. With a cell call cap of two, the first attempt
   consumes one scripted call and stops unsealed; the second consumes two more
   plus one cache replay and seals. Cumulative cell calls reach three while the
   cumulative study allowance of three remains respected. It opens zero real
   development or held-out inputs and makes zero live provider calls. Reproduce
   from `prototypes/parsing_service`:

   ```bash
   PYTHONPATH=src:. /home/gebbaro/Progetti/FREE/prototypes/parsing_service/.venv/bin/python \
     ../../docs/research/2026-09-30-extractbench-validation/development-audit/reproduce_budget_reset.py
   ```

5. Before the next request is sent, verify matching source/schema/config/model
   pins and context admission, reserve a sufficient remaining call/token/wall
   allowance, and journal every fresh attempt. Unknown usage stays charged.
   Interrupted or unsealed predictions must not become scored results.
6. Require all four pilot cells to be sealed and report source-region coverage,
   failed calls, cap hits and total spending alongside paired scores. A sealed
   artifact with failed regions is an operational failure, not complete source
   processing. Do not proceed to Viega until its new common configuration and
   full four-arm resource envelope have separate prospective approval.

Completing the full development population remains blocked on ingestion,
DD1155/Erie budget feasibility and the future operational gates above. The
current evidence does not support a completion date for all twelve groups, a
challenger choice, held-out execution or production adoption.

## Reproduction without requests

Run the accounting calculation from the worktree root. It reads committed
metadata only and prints counts/usage rather than private content:

```bash
python - <<'PY'
import json
from pathlib import Path
base = Path('docs/research/2026-09-30-extractbench-validation')
preflight = json.loads((base / 'development-continuation/preflight.json').read_text())
audit = json.loads((base / 'development-continuation/audit.json').read_text())
rate = 7.8
for case in preflight['cases']:
    if not case['admitted']:
        continue
    arms = case['arms'].values()
    calls = sum(arm['calls'] for arm in arms)
    recovery = sum(arm['upper_bound_with_recovery'] for arm in arms)
    reserved = sum(arm['nominal_tokens_with_maximum_outputs'] for arm in arms)
    print(case['group'], calls, recovery, reserved,
          round(calls * 4096 / rate / 3600, 2),
          round(recovery * 4096 / rate / 3600, 2))
viega = [r for r in audit['requests'] if r['arm'] == 'A2']
print('Viega calls/capped/recovery:', len(viega),
      sum(r['finish'] == 'length' for r in viega),
      sum(not r['nominal'] for r in viega))
print('Fresh accounting:', audit['operational_spend'])
PY
```

For the optional source-only window reproduction, use the installed interpreter
from `prototypes/parsing_service`. It opens only the seven known development
inference files, never the dataset JSONLs or annotations. It imports no provider
construction and cannot invoke a serving tokenizer:

```bash
PYTHONPATH=src:. /home/gebbaro/Progetti/FREE/prototypes/parsing_service/.venv/bin/python - <<'PY'
import hashlib
import json
from pathlib import Path
from experiments.harness.config import Config
from experiments.harness.data import inline_evidence
from experiments.harness.extract import chunks_of

root = Path('../../.scratch/extractbench-v2-development/inputs')
names = [
    'long--dd1155_schedule_continuation_0011',
    'medium--1G1PC5SB6E7111015_professional_valuation',
    'medium--erie_county_2017_single_audit',
    'short--caterpillar_spec_sheet_312c_excavator',
    'short--lancaster_county_ne_requisition_po_husker_steel',
    'short--uillinois_rate_card_carpool_2024',
    'short--viega_price_list_propress_2026',
]
for name in names:
    path = root / (name + '.json')
    source = json.loads(path.read_text())
    evidence, _, _ = inline_evidence(name, source['passages'])
    counts = {}
    for limit in [1000, 2000, 3000, 4000, 5000, 6000]:
        cfg = Config.model_validate({'input': {'mode': 'layout'},
            'chunking': {'mode': 'fixed', 'max_chars': limit}})
        chunks = chunks_of(list(evidence.passages), cfg)
        assert [p.id for c in chunks for p in c.context.primary] == [
            p.id for p in evidence.passages]
        counts[limit] = len(chunks)
    print(name, hashlib.sha256(path.read_bytes()).hexdigest(), counts)
PY
```

CodeGraph was queried first and warned that it used the main worktree index rather
than this branch; current local source was then read directly. No reindex was
performed. The report's numeric conclusions derive from the pinned saved evidence
and the offline commands above, not live server observations during this audit.
