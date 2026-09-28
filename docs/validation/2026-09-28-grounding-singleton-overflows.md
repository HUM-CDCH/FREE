# Remaining singleton overflows — 2026-09-28

Status: tokenizer-only diagnosis complete; no runtime change or new generation.
This follows compact-label version 2 (PR #146), which still refuses 328/470
Age and 345/460 Hamburg claim–unit comparisons in the span-only all-NONE check.
Both are unannotated example documents, not independent evaluation gold.

The saved singleton requests prove that splitting claim batches further cannot
solve these failures. Each request already contains one claim. Its full record
and complete rendered evidence still exceed the 10,240-token input allowance.

For each distinct source catalogue that produced singleton probes, select its
minimum- and maximum-token requests (one request if they coincide). This yields
15 pinned requests across eight catalogues. Count three representations with
the same served tokenizer, schema and 2,048-token output reserve:

1. Unchanged version 2 request; all counts must equal the saved probes.
2. A passage header once, followed by short selectable labels and exact quoted
   source ranges, omitting repeated parent labels/offset metadata.
3. Original evidence but no full-record JSON; retain inventory identity and the
   selected claim's sibling fields. This is diagnostic only: removing record
   context may remove relevant subject/condition information.

| Source catalogue | Original min–max | Grouped metadata min–max | Without full record min–max |
|---|---:|---:|---:|
| Age, starts p4_s11 | 10,641–11,129 | 9,738–10,226 | 10,049–10,119 |
| Age, starts p8_s9 | 10,270–10,367 | 10,052–10,149 | 9,284–9,357 |
| Age, starts p9_s47 | 10,260–10,357 | 10,084–10,181 | 9,274–9,347 |
| Age, starts p1_s0 | 10,452–10,940 | 9,759–10,247 | 9,860–9,930 |
| Hamburg, starts p15_s6 | 11,279–11,479 | 10,593–10,793 | 10,195–10,256 |
| Hamburg, starts p1_s0 | 11,046–11,246 | 10,334–10,534 | 9,962–10,023 |
| Hamburg, starts p8_s5 | 11,188–11,388 | 10,438–10,638 | 10,104–10,165 |
| Hamburg, starts p22_s2 | 4,118 | 3,893 | 3,034 |

The first transformation retains source text but is insufficient by itself:
one sampled Age request still exceeds the budget by seven tokens, and all six
sampled Hamburg requests from its three large catalogues remain too large.
Removing the full record is also insufficient for Hamburg's largest request
and requires semantic validation. Neither transformation was adopted.

This points to a mismatch between inventory-sized source contexts and the
record-dependent grounding prompt. The next design should count complete
grounding requests when forming source units, retain table/header/qualifier
groups, and preserve exhaustive accounting over any subunits. It must not
silently drop source text, remove subject context or increase the registered
budget to hide refusals. Any such change needs a separate factor and proof that
context-dependent claims remain interpretable. For now, retain explicit refusals.

Artifacts:
`/home/gennaro/projects/FREE/artifacts/extraction-ablation/compact-span-rendering-diagnosis-20260928/`.
`probe.py` pins each selected original request and counts the variants without
calling a generation endpoint. `diagnosis.json` records the 15 paired results;
`probe-pins.json` hashes all 45 saved tokenizer responses. There were 46 tokenizer
calls including calibration and zero model calls. These are selected diagnostic
requests, not full-cohort admission totals or latency/quality estimates.
