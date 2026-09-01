# Grounding lab report

Generated 2026-09-01 by `pnpm --filter grounding-lab harness` — do not hand-edit.

10 document(s), 177 claims

Bi-encoder shortlist recall@10 on the neural-fallback population (gold-linkable claims the lexical tier does not resolve): 39/42 with rendered claims, 30/42 with bare values (what the -bare configs query). A gold outside the top-10 is unrecoverable by any reranker.

## Configs

| config | accuracy@1 | correct abstain | wrong link | median ms/claim |
|---|---|---|---|---|
| lexical | 87/129 | 48/48 | 0 | 4 |
| lexical+ce | 114/129 | 35/48 | 15 | 22 |
| lexical+nli | 118/129 | 35/48 | 17 | 21 |
| lexical+ce-bare | 113/129 | 38/48 | 12 | 19 |
| lexical+nli-bare | 111/129 | 38/48 | 13 | 20 |
| ce-only | 79/129 | 35/48 | 17 | 35 |
| nli-only | 95/129 | 35/48 | 22 | 20 |

## Review policy: auto-accept links with confidence ≥ 0.5

| config | links | auto-accepted | auto precision | routed to review |
|---|---|---|---|---|
| lexical | 87 | 87 | 87/87 | 0 |
| lexical+ce | 129 | 95 | 95/95 | 34 |
| lexical+nli | 135 | 99 | 99/99 | 36 |
| lexical+ce-bare | 125 | 95 | 95/95 | 30 |
| lexical+nli-bare | 124 | 97 | 97/97 | 27 |
| ce-only | 96 | 51 | 51/51 | 45 |
| nli-only | 117 | 46 | 46/46 | 71 |

## Calibration on confidence (linked claims, full range)

| config | bucket | links | precision |
|---|---|---|---|
| lexical | 0.9–1.0 | 87 | 87/87 |
| lexical+ce | 0.0–0.1 | 14 | 8/14 |
| lexical+ce | 0.1–0.3 | 16 | 8/16 |
| lexical+ce | 0.3–0.5 | 4 | 3/4 |
| lexical+ce | 0.5–0.7 | 2 | 2/2 |
| lexical+ce | 0.7–0.9 | 2 | 2/2 |
| lexical+ce | 0.9–1.0 | 91 | 91/91 |
| lexical+nli | 0.0–0.1 | 20 | 9/20 |
| lexical+nli | 0.1–0.3 | 12 | 6/12 |
| lexical+nli | 0.3–0.5 | 4 | 4/4 |
| lexical+nli | 0.5–0.7 | 8 | 8/8 |
| lexical+nli | 0.7–0.9 | 3 | 3/3 |
| lexical+nli | 0.9–1.0 | 88 | 88/88 |
| lexical+ce-bare | 0.0–0.1 | 17 | 12/17 |
| lexical+ce-bare | 0.1–0.3 | 12 | 5/12 |
| lexical+ce-bare | 0.3–0.5 | 1 | 1/1 |
| lexical+ce-bare | 0.5–0.7 | 1 | 1/1 |
| lexical+ce-bare | 0.7–0.9 | 4 | 4/4 |
| lexical+ce-bare | 0.9–1.0 | 90 | 90/90 |
| lexical+nli-bare | 0.0–0.1 | 15 | 9/15 |
| lexical+nli-bare | 0.1–0.3 | 12 | 5/12 |
| lexical+nli-bare | 0.5–0.7 | 7 | 7/7 |
| lexical+nli-bare | 0.7–0.9 | 3 | 3/3 |
| lexical+nli-bare | 0.9–1.0 | 87 | 87/87 |
| ce-only | 0.0–0.1 | 17 | 10/17 |
| ce-only | 0.1–0.3 | 20 | 11/20 |
| ce-only | 0.3–0.5 | 8 | 7/8 |
| ce-only | 0.5–0.7 | 8 | 8/8 |
| ce-only | 0.7–0.9 | 23 | 23/23 |
| ce-only | 0.9–1.0 | 20 | 20/20 |
| nli-only | 0.0–0.1 | 27 | 12/27 |
| nli-only | 0.1–0.3 | 18 | 11/18 |
| nli-only | 0.3–0.5 | 26 | 26/26 |
| nli-only | 0.5–0.7 | 24 | 24/24 |
| nli-only | 0.7–0.9 | 18 | 18/18 |
| nli-only | 0.9–1.0 | 4 | 4/4 |

## Per-claim breakdown

| doc | claim | gold | lexical | lexical+ce | lexical+nli | lexical+ce-bare | lexical+nli-bare | ce-only | nli-only |
|---|---|---|---|---|---|---|---|---|---|
| 1790-06-17-1 | Jean | anchor_ebb61fca35b | ✓ anchor_ebb61fca35b (s=1.00 c=1.00 lexical) | ✓ anchor_ebb61fca35b (s=1.00 c=1.00 lexical) | ✓ anchor_ebb61fca35b (s=1.00 c=1.00 lexical) | ✓ anchor_ebb61fca35b (s=1.00 c=1.00 lexical) | ✓ anchor_ebb61fca35b (s=1.00 c=1.00 lexical) | ✗ — (s=0.01 c=0.01 cross-encoder) | ✗ — (s=0.39 c=0.36 nli) |
| 1790-06-17-1 | Marcel | anchor_ebb61fca35b | ✓ anchor_ebb61fca35b (s=1.00 c=1.00 lexical) | ✓ anchor_ebb61fca35b (s=1.00 c=1.00 lexical) | ✓ anchor_ebb61fca35b (s=1.00 c=1.00 lexical) | ✓ anchor_ebb61fca35b (s=1.00 c=1.00 lexical) | ✓ anchor_ebb61fca35b (s=1.00 c=1.00 lexical) | ✗ — (s=0.02 c=0.02 cross-encoder) | ✗ — (s=0.03 c=0.03 nli) |
| 1790-06-17-1 | environ 25 ans | anchor_49c796ee55f | ✓ anchor_49c796ee55f (s=1.00 c=1.00 lexical) | ✓ anchor_49c796ee55f (s=1.00 c=1.00 lexical) | ✓ anchor_49c796ee55f (s=1.00 c=1.00 lexical) | ✓ anchor_49c796ee55f (s=1.00 c=1.00 lexical) | ✓ anchor_49c796ee55f (s=1.00 c=1.00 lexical) | ✗ — (s=0.40 c=0.40 cross-encoder) | ✓ anchor_49c796ee55f (s=1.00 c=0.99 nli) |
| 1790-06-17-1 | Lallemand | anchor_49c796ee55f | ✓ anchor_49c796ee55f (s=1.00 c=1.00 lexical) | ✓ anchor_49c796ee55f (s=1.00 c=1.00 lexical) | ✓ anchor_49c796ee55f (s=1.00 c=1.00 lexical) | ✓ anchor_49c796ee55f (s=1.00 c=1.00 lexical) | ✓ anchor_49c796ee55f (s=1.00 c=1.00 lexical) | ✗ — (s=0.00 c=0.00 cross-encoder) | ✓ anchor_49c796ee55f (s=0.81 c=0.76 nli) |
| 1790-06-17-1 | New Orleans | — | ✓ — (s=0.00 c=0.00 lexical) | ✓ — (s=0.00 c=0.00 cross-encoder) | ✓ — (s=0.07 c=0.02 nli) | ✓ — (s=0.00 c=0.00 cross-encoder) | ✓ — (s=0.16 c=0.05 nli) | ✓ — (s=0.00 c=0.00 cross-encoder) | ✓ — (s=0.07 c=0.02 nli) |
| age-related-disease | Age-related disease or disease-relate… | anchor_de57395d0c4 | ✓ anchor_de57395d0c4 (s=1.00 c=1.00 lexical) | ✓ anchor_de57395d0c4 (s=1.00 c=1.00 lexical) | ✓ anchor_de57395d0c4 (s=1.00 c=1.00 lexical) | ✓ anchor_de57395d0c4 (s=1.00 c=1.00 lexical) | ✓ anchor_de57395d0c4 (s=1.00 c=1.00 lexical) | ✓ anchor_de57395d0c4 (s=1.00 c=0.00 cross-encoder) | ✗ anchor_d56548ef631 (s=0.99 c=0.05 nli*) |
| age-related-disease | Katharina Fuchs | anchor_233d1ab87aa+2 | ✗ — (s=0.00 c=0.00 lexical) | ✓ anchor_81a0115d030 (s=0.95 c=0.21 cross-encoder) | ✓ anchor_81a0115d030 (s=0.99 c=0.01 nli) | ✗ anchor_f2aeabb17a6 (s=0.65 c=0.00 cross-encoder*) | ✓ anchor_d8215394f36 (s=0.98 c=0.01 nli) | ✓ anchor_81a0115d030 (s=0.95 c=0.21 cross-encoder) | ✓ anchor_81a0115d030 (s=0.99 c=0.01 nli) |
| age-related-disease | Jo Appleby | anchor_233d1ab87aa+2 | ✗ — (s=0.00 c=0.00 lexical) | ✓ anchor_81a0115d030 (s=0.93 c=0.47 cross-encoder) | ✓ anchor_81a0115d030 (s=0.99 c=0.00 nli) | ✓ anchor_81a0115d030 (s=0.71 c=0.71 cross-encoder) | ✓ anchor_81a0115d030 (s=0.97 c=0.67 nli) | ✓ anchor_81a0115d030 (s=0.93 c=0.47 cross-encoder) | ✓ anchor_81a0115d030 (s=0.99 c=0.00 nli) |
| age-related-disease | 10.1016/j.ijpp.2026.02.003 | anchor_6adfba012ee | ✓ anchor_6adfba012ee (s=1.00 c=1.00 lexical) | ✓ anchor_6adfba012ee (s=1.00 c=1.00 lexical) | ✓ anchor_6adfba012ee (s=1.00 c=1.00 lexical) | ✓ anchor_6adfba012ee (s=1.00 c=1.00 lexical) | ✓ anchor_6adfba012ee (s=1.00 c=1.00 lexical) | ✓ anchor_6adfba012ee (s=1.00 c=0.83 cross-encoder) | ✓ anchor_6adfba012ee (s=0.87 c=0.67 nli) |
| age-related-disease | k.fuchs@ufg.uni-kiel.de | anchor_fdffe173700 | ✓ anchor_fdffe173700 (s=1.00 c=1.00 lexical) | ✓ anchor_fdffe173700 (s=1.00 c=1.00 lexical) | ✓ anchor_fdffe173700 (s=1.00 c=1.00 lexical) | ✓ anchor_fdffe173700 (s=1.00 c=1.00 lexical) | ✓ anchor_fdffe173700 (s=1.00 c=1.00 lexical) | ✓ anchor_fdffe173700 (s=0.95 c=0.63 cross-encoder) | ✓ anchor_fdffe173700 (s=0.93 c=0.49 nli) |
| age-related-disease | University of Leicester | anchor_028b35c6855 | ✓ anchor_028b35c6855 (s=1.00 c=1.00 lexical) | ✓ anchor_028b35c6855 (s=1.00 c=1.00 lexical) | ✓ anchor_028b35c6855 (s=1.00 c=1.00 lexical) | ✓ anchor_028b35c6855 (s=1.00 c=1.00 lexical) | ✓ anchor_028b35c6855 (s=1.00 c=1.00 lexical) | ✗ — (s=0.10 c=0.09 cross-encoder) | ✓ anchor_028b35c6855 (s=0.82 c=0.37 nli) |
| age-related-disease | Kiel University | anchor_1eeb7fa3207 | ✗ — (s=0.00 c=0.00 lexical) | ✗ — (s=0.23 c=0.23 cross-encoder) | ✓ anchor_1eeb7fa3207 (s=0.85 c=0.45 nli) | ✓ anchor_1eeb7fa3207 (s=0.95 c=0.95 cross-encoder) | ✓ anchor_1eeb7fa3207 (s=0.99 c=0.84 nli) | ✗ — (s=0.23 c=0.23 cross-encoder) | ✓ anchor_1eeb7fa3207 (s=0.85 c=0.45 nli) |
| age-related-disease | Vanderbilt University Medical Center | anchor_f51c592e3bd | ✓ anchor_f51c592e3bd (s=1.00 c=1.00 lexical) | ✓ anchor_f51c592e3bd (s=1.00 c=1.00 lexical) | ✓ anchor_f51c592e3bd (s=1.00 c=1.00 lexical) | ✓ anchor_f51c592e3bd (s=1.00 c=1.00 lexical) | ✓ anchor_f51c592e3bd (s=1.00 c=1.00 lexical) | ✗ — (s=0.29 c=0.28 cross-encoder) | ✓ anchor_f51c592e3bd (s=0.72 c=0.36 nli) |
| age-related-disease | Mississippi State University | anchor_78e15c3560d+1 | ✗ — (s=0.00 c=0.00 lexical) | ✗ — (s=0.21 c=0.16 cross-encoder) | ✓ anchor_60e37591ea7 (s=0.80 c=0.06 nli) | ✓ anchor_60e37591ea7 (s=0.97 c=0.03 cross-encoder) | ✓ anchor_60e37591ea7 (s=0.98 c=0.01 nli) | ✗ — (s=0.21 c=0.16 cross-encoder) | ✓ anchor_60e37591ea7 (s=0.80 c=0.06 nli) |
| age-related-disease | 60 % | anchor_4ab699d3e12 | ✓ anchor_4ab699d3e12 (s=1.00 c=1.00 lexical) | ✓ anchor_4ab699d3e12 (s=1.00 c=1.00 lexical) | ✓ anchor_4ab699d3e12 (s=1.00 c=1.00 lexical) | ✓ anchor_4ab699d3e12 (s=1.00 c=1.00 lexical) | ✓ anchor_4ab699d3e12 (s=1.00 c=1.00 lexical) | ✓ anchor_4ab699d3e12 (s=0.67 c=0.67 cross-encoder) | ✗ — (s=0.19 c=0.19 nli) |
| age-related-disease | TA3 | anchor_efadde47e89+2 | ✗ — (s=0.00 c=0.00 lexical) | ✓ anchor_efadde47e89 (s=0.95 c=0.39 cross-encoder) | ✓ anchor_efadde47e89 (s=1.00 c=0.71 nli) | ✓ anchor_efadde47e89 (s=0.71 c=0.16 cross-encoder) | ✓ anchor_e55003c01d7 (s=0.96 c=0.10 nli) | ✓ anchor_efadde47e89 (s=0.95 c=0.39 cross-encoder) | ✓ anchor_efadde47e89 (s=1.00 c=0.71 nli) |
| age-related-disease | Kathryn E. Marklein | anchor_d8215394f36+1 | ✗ — (s=0.00 c=0.00 lexical) | ✓ anchor_d8215394f36 (s=0.78 c=0.45 cross-encoder) | ✓ anchor_d8215394f36 (s=0.99 c=0.56 nli) | ✗ — (s=0.36 c=0.05 cross-encoder) | ✗ anchor_a755511f155 (s=0.97 c=0.08 nli*) | ✓ anchor_d8215394f36 (s=0.78 c=0.45 cross-encoder) | ✓ anchor_d8215394f36 (s=0.99 c=0.56 nli) |
| age-related-disease | progeria | anchor_f0fb6b5010c | ✓ anchor_f0fb6b5010c (s=1.00 c=1.00 lexical) | ✓ anchor_f0fb6b5010c (s=1.00 c=1.00 lexical) | ✓ anchor_f0fb6b5010c (s=1.00 c=1.00 lexical) | ✓ anchor_f0fb6b5010c (s=1.00 c=1.00 lexical) | ✓ anchor_f0fb6b5010c (s=1.00 c=1.00 lexical) | ✓ anchor_f0fb6b5010c (s=0.88 c=0.83 cross-encoder) | ✓ anchor_f0fb6b5010c (s=0.97 c=0.46 nli) |
| age-related-disease | International Journal of Paleopathology | anchor_dcaf435b4d3 | ✓ anchor_dcaf435b4d3 (s=1.00 c=1.00 lexical) | ✓ anchor_dcaf435b4d3 (s=1.00 c=1.00 lexical) | ✓ anchor_dcaf435b4d3 (s=1.00 c=1.00 lexical) | ✓ anchor_dcaf435b4d3 (s=1.00 c=1.00 lexical) | ✓ anchor_dcaf435b4d3 (s=1.00 c=1.00 lexical) | ✓ anchor_dcaf435b4d3 (s=1.00 c=0.33 cross-encoder) | ✗ anchor_006051a310b (s=0.98 c=0.02 nli*) |
| age-related-disease | Im Dol 2-6 | anchor_773ccee8569 | ✗ — (s=0.00 c=0.00 lexical) | ✓ anchor_773ccee8569 (s=0.77 c=0.25 cross-encoder*) | ✓ anchor_773ccee8569 (s=0.51 c=0.16 nli*) | ✗ — (s=0.01 c=0.01 cross-encoder) | ✗ — (s=0.47 c=0.18 nli) | ✓ anchor_773ccee8569 (s=0.77 c=0.25 cross-encoder*) | ✓ anchor_773ccee8569 (s=0.51 c=0.16 nli*) |
| age-related-disease | 10.1016/j.ijpp.2026.02.004 | — | ✓ — (s=0.00 c=0.00 lexical) | ✗ anchor_6adfba012ee (s=0.97 c=0.25 cross-encoder*) | ✓ — (s=0.28 c=0.04 nli) | ✗ anchor_6adfba012ee (s=0.88 c=0.25 cross-encoder*) | ✓ — (s=0.27 c=0.00 nli) | ✗ anchor_6adfba012ee (s=0.97 c=0.25 cross-encoder*) | ✓ — (s=0.28 c=0.04 nli) |
| age-related-disease | Katherine Fuchs | — | ✓ — (s=0.00 c=0.00 lexical) | ✗ anchor_81a0115d030 (s=0.94 c=0.06 cross-encoder*) | ✗ anchor_81a0115d030 (s=0.99 c=0.03 nli*) | ✗ anchor_f2aeabb17a6 (s=0.83 c=0.00 cross-encoder*) | ✗ anchor_d8215394f36 (s=0.98 c=0.00 nli*) | ✗ anchor_81a0115d030 (s=0.94 c=0.06 cross-encoder*) | ✗ anchor_81a0115d030 (s=0.99 c=0.03 nli*) |
| age-related-disease | TA4 | — | ✓ — (s=0.00 c=0.00 lexical) | ✓ — (s=0.21 c=0.10 cross-encoder) | ✓ — (s=0.25 c=0.02 nli) | ✓ — (s=0.02 c=0.01 cross-encoder) | ✓ — (s=0.32 c=0.08 nli) | ✓ — (s=0.21 c=0.10 cross-encoder) | ✓ — (s=0.25 c=0.02 nli) |
| age-related-disease | University of Oxford | — | ✓ — (s=0.00 c=0.00 lexical) | ✓ — (s=0.01 c=0.01 cross-encoder) | ✗ anchor_0b580d940fe (s=0.87 c=0.25 nli*) | ✓ — (s=0.17 c=0.10 cross-encoder) | ✗ anchor_0b580d940fe (s=0.65 c=0.25 nli*) | ✓ — (s=0.01 c=0.01 cross-encoder) | ✗ anchor_0b580d940fe (s=0.87 c=0.25 nli*) |
| age-related-disease | Aarhus University | — | ✓ — (s=0.00 c=0.00 lexical) | ✓ — (s=0.00 c=0.00 cross-encoder) | ✓ — (s=0.35 c=0.20 nli) | ✓ — (s=0.01 c=0.00 cross-encoder) | ✓ — (s=0.43 c=0.41 nli) | ✓ — (s=0.00 c=0.00 cross-encoder) | ✓ — (s=0.35 c=0.20 nli) |
| brondbylund | TAK 1506 | anchor_c16f6dfbfed+2 | ✗ — (s=0.00 c=0.00 lexical) | ✓ anchor_74f5629f2e4 (s=0.99 c=0.02 cross-encoder) | ✓ anchor_74f5629f2e4 (s=1.00 c=0.00 nli) | ✓ anchor_c16f6dfbfed (s=0.90 c=0.87 cross-encoder) | ✓ anchor_c16f6dfbfed (s=0.99 c=0.75 nli) | ✓ anchor_74f5629f2e4 (s=0.99 c=0.02 cross-encoder) | ✓ anchor_74f5629f2e4 (s=1.00 c=0.00 nli) |
| brondbylund | Maria Lisette Jacobsen | anchor_772d564bd37+1 | ✗ — (s=0.00 c=0.00 lexical) | ✗ — (s=0.26 c=0.18 cross-encoder) | ✓ anchor_772d564bd37 (s=0.95 c=0.57 nli) | ✓ anchor_772d564bd37 (s=0.99 c=0.06 cross-encoder) | ✓ anchor_8b51fb9a6d9 (s=0.97 c=0.66 nli) | ✗ — (s=0.26 c=0.18 cross-encoder) | ✓ anchor_772d564bd37 (s=0.95 c=0.57 nli) |
| brondbylund | 542 g | anchor_b0152f15cb9 | ✓ anchor_b0152f15cb9 (s=1.00 c=1.00 lexical) | ✓ anchor_b0152f15cb9 (s=1.00 c=1.00 lexical) | ✓ anchor_b0152f15cb9 (s=1.00 c=1.00 lexical) | ✓ anchor_b0152f15cb9 (s=1.00 c=1.00 lexical) | ✓ anchor_b0152f15cb9 (s=1.00 c=1.00 lexical) | ✓ anchor_b0152f15cb9 (s=0.76 c=0.75 cross-encoder) | ✓ anchor_b0152f15cb9 (s=0.96 c=0.73 nli) |
| brondbylund | ca. 1 år | anchor_3e88c36c6ac | ✓ anchor_3e88c36c6ac (s=1.00 c=1.00 lexical) | ✓ anchor_3e88c36c6ac (s=1.00 c=1.00 lexical) | ✓ anchor_3e88c36c6ac (s=1.00 c=1.00 lexical) | ✓ anchor_3e88c36c6ac (s=1.00 c=1.00 lexical) | ✓ anchor_3e88c36c6ac (s=1.00 c=1.00 lexical) | ✓ anchor_3e88c36c6ac (s=0.58 c=0.47 cross-encoder) | ✓ anchor_3e88c36c6ac (s=0.86 c=0.44 nli) |
| brondbylund | 900 e. Kr. | anchor_e32d087632c | ✓ anchor_e32d087632c (s=1.00 c=1.00 lexical) | ✓ anchor_e32d087632c (s=1.00 c=1.00 lexical) | ✓ anchor_e32d087632c (s=1.00 c=1.00 lexical) | ✓ anchor_e32d087632c (s=1.00 c=1.00 lexical) | ✓ anchor_e32d087632c (s=1.00 c=1.00 lexical) | ✗ — (s=0.33 c=0.32 cross-encoder) | ✓ anchor_e32d087632c (s=0.65 c=0.33 nli) |
| brondbylund | 18 | anchor_735960dfc73 | ✗ — (s=0.00 c=0.00 lexical) | ✗ — (s=0.29 c=0.23 cross-encoder) | ✗ — (s=0.21 c=0.02 nli) | ✗ — (s=0.03 c=0.01 cross-encoder) | ✗ — (s=0.27 c=0.00 nli) | ✗ — (s=0.29 c=0.23 cross-encoder) | ✗ — (s=0.21 c=0.02 nli) |
| brondbylund | Lars Nissen | anchor_edc60e8a2e9 | ✓ anchor_edc60e8a2e9 (s=1.00 c=1.00 lexical) | ✓ anchor_edc60e8a2e9 (s=1.00 c=1.00 lexical) | ✓ anchor_edc60e8a2e9 (s=1.00 c=1.00 lexical) | ✓ anchor_edc60e8a2e9 (s=1.00 c=1.00 lexical) | ✓ anchor_edc60e8a2e9 (s=1.00 c=1.00 lexical) | ✓ anchor_edc60e8a2e9 (s=1.00 c=1.00 cross-encoder) | ✓ anchor_edc60e8a2e9 (s=0.99 c=0.84 nli) |
| brondbylund | Lind & Risør | anchor_5cd63a98820 | ✓ anchor_5cd63a98820 (s=1.00 c=1.00 lexical) | ✓ anchor_5cd63a98820 (s=1.00 c=1.00 lexical) | ✓ anchor_5cd63a98820 (s=1.00 c=1.00 lexical) | ✓ anchor_5cd63a98820 (s=1.00 c=1.00 lexical) | ✓ anchor_5cd63a98820 (s=1.00 c=1.00 lexical) | ✗ — (s=0.03 c=0.03 cross-encoder) | ✓ anchor_5cd63a98820 (s=0.91 c=0.32 nli) |
| brondbylund | FHM 4296/2382 | anchor_76a638133bd | ✓ anchor_76a638133bd (s=1.00 c=1.00 lexical) | ✓ anchor_76a638133bd (s=1.00 c=1.00 lexical) | ✓ anchor_76a638133bd (s=1.00 c=1.00 lexical) | ✓ anchor_76a638133bd (s=1.00 c=1.00 lexical) | ✓ anchor_76a638133bd (s=1.00 c=1.00 lexical) | ✓ anchor_76a638133bd (s=0.95 c=0.94 cross-encoder) | ✓ anchor_76a638133bd (s=0.93 c=0.62 nli) |
| brondbylund | Brøndbyøster sogn | anchor_1449a8a3f1c | ✓ anchor_1449a8a3f1c (s=1.00 c=1.00 lexical) | ✓ anchor_1449a8a3f1c (s=1.00 c=1.00 lexical) | ✓ anchor_1449a8a3f1c (s=1.00 c=1.00 lexical) | ✓ anchor_1449a8a3f1c (s=1.00 c=1.00 lexical) | ✓ anchor_1449a8a3f1c (s=1.00 c=1.00 lexical) | ✓ anchor_1449a8a3f1c (s=0.78 c=0.67 cross-encoder) | ✓ anchor_1449a8a3f1c (s=0.90 c=0.18 nli) |
| brondbylund | 5000 m2 | — | ✓ — (s=0.00 c=0.00 lexical) | ✓ — (s=0.41 c=0.41 cross-encoder) | ✓ — (s=0.08 c=0.05 nli) | ✓ — (s=0.00 c=0.00 cross-encoder) | ✓ — (s=0.13 c=0.03 nli) | ✓ — (s=0.41 c=0.41 cross-encoder) | ✓ — (s=0.08 c=0.05 nli) |
| brondbylund | 1200 f.Kr. | — | ✓ — (s=0.00 c=0.00 lexical) | ✓ — (s=0.24 c=0.13 cross-encoder) | ✓ — (s=0.24 c=0.02 nli) | ✗ anchor_81c1d5b50e2 (s=0.59 c=0.25 cross-encoder*) | ✓ — (s=0.23 c=0.06 nli) | ✓ — (s=0.24 c=0.13 cross-encoder) | ✓ — (s=0.24 c=0.02 nli) |
| brondbylund | TAK 1507 | — | ✓ — (s=0.00 c=0.00 lexical) | ✓ — (s=0.20 c=0.02 cross-encoder) | ✓ — (s=0.35 c=0.01 nli) | ✓ — (s=0.04 c=0.03 cross-encoder) | ✓ — (s=0.24 c=0.00 nli) | ✓ — (s=0.20 c=0.02 cross-encoder) | ✓ — (s=0.35 c=0.01 nli) |
| brondbylund | 543 g | — | ✓ — (s=0.00 c=0.00 lexical) | ✓ — (s=0.01 c=0.01 cross-encoder) | ✓ — (s=0.25 c=0.03 nli) | ✓ — (s=0.00 c=0.00 cross-encoder) | ✓ — (s=0.29 c=0.05 nli) | ✓ — (s=0.01 c=0.01 cross-encoder) | ✓ — (s=0.25 c=0.03 nli) |
| brondbylund | ca. 2 år | — | ✓ — (s=0.00 c=0.00 lexical) | ✓ — (s=0.05 c=0.02 cross-encoder) | ✓ — (s=0.29 c=0.17 nli) | ✓ — (s=0.04 c=0.00 cross-encoder) | ✓ — (s=0.38 c=0.12 nli) | ✓ — (s=0.05 c=0.02 cross-encoder) | ✓ — (s=0.29 c=0.17 nli) |
| brondbylund | 150 | — | ✓ — (s=0.00 c=0.00 lexical) | ✓ — (s=0.02 c=0.01 cross-encoder) | ✓ — (s=0.07 c=0.04 nli) | ✓ — (s=0.03 c=0.02 cross-encoder) | ✓ — (s=0.23 c=0.01 nli) | ✓ — (s=0.02 c=0.01 cross-encoder) | ✓ — (s=0.07 c=0.04 nli) |
| brondbylund | 19 | — | ✓ — (s=0.00 c=0.00 lexical) | ✓ — (s=0.01 c=0.01 cross-encoder) | ✓ — (s=0.17 c=0.02 nli) | ✓ — (s=0.06 c=0.02 cross-encoder) | ✓ — (s=0.34 c=0.02 nli) | ✓ — (s=0.01 c=0.01 cross-encoder) | ✓ — (s=0.17 c=0.02 nli) |
| catfish-collagen | Properties of Skin Collagen from Sout… | anchor_4b6b6143a77+1 | ✗ — (s=0.00 c=0.00 lexical) | ✓ anchor_4b6b6143a77 (s=1.00 c=0.00 cross-encoder) | ✗ anchor_857734ffdce (s=0.78 c=0.03 nli*) | ✓ anchor_4b6b6143a77 (s=1.00 c=0.00 cross-encoder) | ✗ anchor_0bc6609454d (s=0.95 c=0.01 nli*) | ✓ anchor_4b6b6143a77 (s=1.00 c=0.00 cross-encoder) | ✗ anchor_857734ffdce (s=0.78 c=0.03 nli*) |
| catfish-collagen | zhangxi@mail.hzau.edu.cn | anchor_cd670a8ada5 | ✓ anchor_cd670a8ada5 (s=1.00 c=1.00 lexical) | ✓ anchor_cd670a8ada5 (s=1.00 c=1.00 lexical) | ✓ anchor_cd670a8ada5 (s=1.00 c=1.00 lexical) | ✓ anchor_cd670a8ada5 (s=1.00 c=1.00 lexical) | ✓ anchor_cd670a8ada5 (s=1.00 c=1.00 lexical) | ✓ anchor_cd670a8ada5 (s=1.00 c=0.42 cross-encoder) | ✓ anchor_cd670a8ada5 (s=0.99 c=0.27 nli) |
| catfish-collagen | +86-18672306015 | anchor_cd670a8ada5 | ✓ anchor_cd670a8ada5 (s=1.00 c=1.00 lexical) | ✓ anchor_cd670a8ada5 (s=1.00 c=1.00 lexical) | ✓ anchor_cd670a8ada5 (s=1.00 c=1.00 lexical) | ✓ anchor_cd670a8ada5 (s=1.00 c=1.00 lexical) | ✓ anchor_cd670a8ada5 (s=1.00 c=1.00 lexical) | ✓ anchor_cd670a8ada5 (s=0.98 c=0.98 cross-encoder) | ✓ anchor_cd670a8ada5 (s=0.99 c=0.39 nli) |
| catfish-collagen | Carlos José Dias Pereira | anchor_281439a9f96 | ✗ — (s=0.00 c=0.00 lexical) | ✓ anchor_281439a9f96 (s=1.00 c=0.25 cross-encoder*) | ✓ anchor_281439a9f96 (s=0.95 c=0.25 nli*) | ✓ anchor_281439a9f96 (s=0.95 c=0.25 cross-encoder*) | ✓ anchor_281439a9f96 (s=0.86 c=0.25 nli*) | ✓ anchor_281439a9f96 (s=1.00 c=0.25 cross-encoder*) | ✓ anchor_281439a9f96 (s=0.95 c=0.25 nli*) |
| catfish-collagen | 1 August 2024 | anchor_f781e0cbbe1 | ✓ anchor_f781e0cbbe1 (s=1.00 c=1.00 lexical) | ✓ anchor_f781e0cbbe1 (s=1.00 c=1.00 lexical) | ✓ anchor_f781e0cbbe1 (s=1.00 c=1.00 lexical) | ✓ anchor_f781e0cbbe1 (s=1.00 c=1.00 lexical) | ✓ anchor_f781e0cbbe1 (s=1.00 c=1.00 lexical) | ✓ anchor_f781e0cbbe1 (s=1.00 c=0.43 cross-encoder) | ✓ anchor_f781e0cbbe1 (s=0.98 c=0.95 nli) |
| catfish-collagen | 13 September 2024 | anchor_2c556afc880 | ✓ anchor_2c556afc880 (s=1.00 c=1.00 lexical) | ✓ anchor_2c556afc880 (s=1.00 c=1.00 lexical) | ✓ anchor_2c556afc880 (s=1.00 c=1.00 lexical) | ✓ anchor_2c556afc880 (s=1.00 c=1.00 lexical) | ✓ anchor_2c556afc880 (s=1.00 c=1.00 lexical) | ✓ anchor_2c556afc880 (s=1.00 c=0.29 cross-encoder) | ✓ anchor_2c556afc880 (s=0.98 c=0.75 nli) |
| catfish-collagen | Hokkaido University | anchor_156d421e102 | ✓ anchor_156d421e102 (s=1.00 c=1.00 lexical) | ✓ anchor_156d421e102 (s=1.00 c=1.00 lexical) | ✓ anchor_156d421e102 (s=1.00 c=1.00 lexical) | ✓ anchor_156d421e102 (s=1.00 c=1.00 lexical) | ✓ anchor_156d421e102 (s=1.00 c=1.00 lexical) | ✗ — (s=0.13 c=0.13 cross-encoder) | ✓ anchor_156d421e102 (s=0.87 c=0.50 nli) |
| catfish-collagen | takagi@fish.hokudai.ac.jp | anchor_156d421e102 | ✓ anchor_156d421e102 (s=1.00 c=1.00 lexical) | ✓ anchor_156d421e102 (s=1.00 c=1.00 lexical) | ✓ anchor_156d421e102 (s=1.00 c=1.00 lexical) | ✓ anchor_156d421e102 (s=1.00 c=1.00 lexical) | ✓ anchor_156d421e102 (s=1.00 c=1.00 lexical) | ✓ anchor_156d421e102 (s=0.97 c=0.97 cross-encoder) | ✓ anchor_156d421e102 (s=0.98 c=0.06 nli) |
| catfish-collagen | 6 weeks | anchor_7d5aa15172d | ✓ anchor_7d5aa15172d (s=1.00 c=1.00 lexical) | ✓ anchor_7d5aa15172d (s=1.00 c=1.00 lexical) | ✓ anchor_7d5aa15172d (s=1.00 c=1.00 lexical) | ✓ anchor_7d5aa15172d (s=1.00 c=1.00 lexical) | ✓ anchor_7d5aa15172d (s=1.00 c=1.00 lexical) | ✗ — (s=0.00 c=0.00 cross-encoder) | ✗ — (s=0.45 c=0.01 nli) |
| catfish-collagen | 27.09 ± 0.89 g | anchor_a986c2a37ab | ✓ anchor_a986c2a37ab (s=1.00 c=1.00 lexical) | ✓ anchor_a986c2a37ab (s=1.00 c=1.00 lexical) | ✓ anchor_a986c2a37ab (s=1.00 c=1.00 lexical) | ✓ anchor_a986c2a37ab (s=1.00 c=1.00 lexical) | ✓ anchor_a986c2a37ab (s=1.00 c=1.00 lexical) | ✓ anchor_a986c2a37ab (s=0.99 c=0.98 cross-encoder) | ✓ anchor_a986c2a37ab (s=1.00 c=0.39 nli) |
| catfish-collagen | 8.66 ± 0.11% | anchor_b73a9b0ba0d+1 | ✗ — (s=0.00 c=0.00 lexical) | ✓ anchor_b73a9b0ba0d (s=1.00 c=0.81 cross-encoder) | ✓ anchor_b73a9b0ba0d (s=0.99 c=0.57 nli) | ✗ — (s=0.30 c=0.29 cross-encoder) | ✗ — (s=0.37 c=0.00 nli) | ✓ anchor_b73a9b0ba0d (s=1.00 c=0.81 cross-encoder) | ✓ anchor_b73a9b0ba0d (s=0.99 c=0.57 nli) |
| catfish-collagen | 61.78 ± 3.91% | anchor_eb71e1b5f9a+2 | ✗ — (s=0.00 c=0.00 lexical) | ✓ anchor_eb71e1b5f9a (s=0.94 c=0.93 cross-encoder) | ✓ anchor_eb71e1b5f9a (s=0.75 c=0.09 nli) | ✓ anchor_eb71e1b5f9a (s=0.95 c=0.83 cross-encoder) | ✓ anchor_eb71e1b5f9a (s=0.97 c=0.07 nli) | ✓ anchor_eb71e1b5f9a (s=0.94 c=0.93 cross-encoder) | ✓ anchor_eb71e1b5f9a (s=0.75 c=0.09 nli) |
| catfish-collagen | SPSS Base 25 | anchor_58009cbd2db | ✓ anchor_58009cbd2db (s=1.00 c=1.00 lexical) | ✓ anchor_58009cbd2db (s=1.00 c=1.00 lexical) | ✓ anchor_58009cbd2db (s=1.00 c=1.00 lexical) | ✓ anchor_58009cbd2db (s=1.00 c=1.00 lexical) | ✓ anchor_58009cbd2db (s=1.00 c=1.00 lexical) | ✓ anchor_58009cbd2db (s=0.91 c=0.79 cross-encoder) | ✓ anchor_58009cbd2db (s=1.00 c=0.71 nli) |
| catfish-collagen | GACGCTGTATGTGAAACGGC | anchor_8d86be60f2f+1 | ✓ anchor_c850e50e68a (s=1.00 c=1.00 lexical) | ✓ anchor_c850e50e68a (s=1.00 c=1.00 lexical) | ✓ anchor_c850e50e68a (s=1.00 c=1.00 lexical) | ✓ anchor_c850e50e68a (s=1.00 c=1.00 lexical) | ✓ anchor_c850e50e68a (s=1.00 c=1.00 lexical) | ✓ anchor_c850e50e68a (s=0.95 c=0.13 cross-encoder) | ✓ anchor_8d86be60f2f (s=0.87 c=0.01 nli*) |
| catfish-collagen | TATCTCCCCTTGGTCCCGAT | anchor_4faa09e9a48+1 | ✓ anchor_223d719df99 (s=1.00 c=1.00 lexical) | ✓ anchor_223d719df99 (s=1.00 c=1.00 lexical) | ✓ anchor_223d719df99 (s=1.00 c=1.00 lexical) | ✓ anchor_223d719df99 (s=1.00 c=1.00 lexical) | ✓ anchor_223d719df99 (s=1.00 c=1.00 lexical) | ✓ anchor_223d719df99 (s=0.93 c=0.14 cross-encoder) | ✓ anchor_223d719df99 (s=0.86 c=0.00 nli) |
| catfish-collagen | Nicolet IS50 | anchor_32cca9ee8ba | ✓ anchor_32cca9ee8ba (s=1.00 c=1.00 lexical) | ✓ anchor_32cca9ee8ba (s=1.00 c=1.00 lexical) | ✓ anchor_32cca9ee8ba (s=1.00 c=1.00 lexical) | ✓ anchor_32cca9ee8ba (s=1.00 c=1.00 lexical) | ✓ anchor_32cca9ee8ba (s=1.00 c=1.00 lexical) | ✗ — (s=0.01 c=0.01 cross-encoder) | ✗ — (s=0.39 c=0.00 nli) |
| catfish-collagen | 12,000 × g | anchor_161b1292bbd | ✓ anchor_161b1292bbd (s=1.00 c=1.00 lexical) | ✓ anchor_161b1292bbd (s=1.00 c=1.00 lexical) | ✓ anchor_161b1292bbd (s=1.00 c=1.00 lexical) | ✓ anchor_161b1292bbd (s=1.00 c=1.00 lexical) | ✓ anchor_161b1292bbd (s=1.00 c=1.00 lexical) | ✓ anchor_161b1292bbd (s=0.90 c=0.89 cross-encoder) | ✓ anchor_161b1292bbd (s=0.64 c=0.46 nli) |
| catfish-collagen | zhangxi@mail.hzau.edu.com | — | ✓ — (s=0.00 c=0.00 lexical) | ✗ anchor_cd670a8ada5 (s=0.99 c=0.25 cross-encoder*) | ✓ — (s=0.36 c=0.08 nli) | ✗ anchor_cd670a8ada5 (s=0.97 c=0.25 cross-encoder*) | ✓ — (s=0.24 c=0.00 nli) | ✗ anchor_cd670a8ada5 (s=0.99 c=0.25 cross-encoder*) | ✓ — (s=0.36 c=0.08 nli) |
| catfish-collagen | 8.66 ± 0.12% | — | ✓ — (s=0.00 c=0.00 lexical) | ✗ anchor_b73a9b0ba0d (s=0.99 c=0.25 cross-encoder*) | ✓ — (s=0.40 c=0.03 nli) | ✓ — (s=0.23 c=0.22 cross-encoder) | ✓ — (s=0.37 c=0.00 nli) | ✗ anchor_b73a9b0ba0d (s=0.99 c=0.25 cross-encoder*) | ✓ — (s=0.40 c=0.03 nli) |
| catfish-collagen | col1a3-F | — | ✓ — (s=0.00 c=0.00 lexical) | ✓ — (s=0.48 c=0.20 cross-encoder) | ✗ anchor_6ddcdb9f480 (s=0.59 c=0.06 nli*) | ✗ anchor_6ddcdb9f480 (s=0.78 c=0.10 cross-encoder*) | ✗ anchor_6ddcdb9f480 (s=0.65 c=0.25 nli*) | ✓ — (s=0.48 c=0.20 cross-encoder) | ✗ anchor_6ddcdb9f480 (s=0.59 c=0.06 nli*) |
| catfish-collagen | Kyoto University | — | ✓ — (s=0.00 c=0.00 lexical) | ✓ — (s=0.00 c=0.00 cross-encoder) | ✓ — (s=0.30 c=0.00 nli) | ✓ — (s=0.01 c=0.00 cross-encoder) | ✓ — (s=0.09 c=0.07 nli) | ✓ — (s=0.00 c=0.00 cross-encoder) | ✓ — (s=0.30 c=0.00 nli) |
| catfish-collagen | 15 September 2024 | — | ✓ — (s=0.00 c=0.00 lexical) | ✗ anchor_0bacf2a5f9c (s=0.74 c=0.00 cross-encoder*) | ✓ — (s=0.21 c=0.00 nli) | ✗ anchor_0bacf2a5f9c (s=0.90 c=0.00 cross-encoder*) | ✓ — (s=0.13 c=0.00 nli) | ✗ anchor_0bacf2a5f9c (s=0.74 c=0.00 cross-encoder*) | ✓ — (s=0.21 c=0.00 nli) |
| ellekilde | Grav 8 | anchor_540e94d0e16+1 | ✗ — (s=0.00 c=0.00 lexical) | ✓ anchor_540e94d0e16 (s=1.00 c=0.14 cross-encoder) | ✓ anchor_39473e76ce2 (s=0.96 c=0.12 nli) | ✓ anchor_540e94d0e16 (s=1.00 c=0.06 cross-encoder) | ✓ anchor_39473e76ce2 (s=0.92 c=0.03 nli) | ✓ anchor_540e94d0e16 (s=1.00 c=0.14 cross-encoder) | ✓ anchor_39473e76ce2 (s=0.96 c=0.12 nli) |
| ellekilde | over 45 år | anchor_3b23e3358bf | ✓ anchor_3b23e3358bf (s=1.00 c=1.00 lexical) | ✓ anchor_3b23e3358bf (s=1.00 c=1.00 lexical) | ✓ anchor_3b23e3358bf (s=1.00 c=1.00 lexical) | ✓ anchor_3b23e3358bf (s=1.00 c=1.00 lexical) | ✓ anchor_3b23e3358bf (s=1.00 c=1.00 lexical) | ✗ — (s=0.01 c=0.01 cross-encoder) | ✗ — (s=0.28 c=0.06 nli) |
| ellekilde | jernspænde | anchor_13264f1691a+1 | ✗ — (s=0.00 c=0.00 lexical) | ✗ — (s=0.44 c=0.22 cross-encoder) | ✗ anchor_e3488d84d89 (s=0.96 c=0.02 nli*) | ✓ anchor_13264f1691a (s=0.97 c=0.10 cross-encoder) | ✓ anchor_3b23e3358bf (s=0.99 c=0.01 nli) | ✗ — (s=0.44 c=0.22 cross-encoder) | ✗ anchor_e3488d84d89 (s=0.96 c=0.02 nli*) |
| ellekilde | 25-35 år | anchor_faa3abc3e1c | ✓ anchor_faa3abc3e1c (s=1.00 c=1.00 lexical) | ✓ anchor_faa3abc3e1c (s=1.00 c=1.00 lexical) | ✓ anchor_faa3abc3e1c (s=1.00 c=1.00 lexical) | ✓ anchor_faa3abc3e1c (s=1.00 c=1.00 lexical) | ✓ anchor_faa3abc3e1c (s=1.00 c=1.00 lexical) | ✗ — (s=0.28 c=0.26 cross-encoder) | ✓ anchor_faa3abc3e1c (s=0.65 c=0.12 nli) |
| ellekilde | Yngre romersk jernalder per. C3 | anchor_64a5a183460 | ✗ — (s=0.00 c=0.00 lexical) | ✓ anchor_64a5a183460 (s=1.00 c=0.02 cross-encoder) | ✗ anchor_504ddb27457 (s=0.98 c=0.04 nli) | ✓ anchor_64a5a183460 (s=1.00 c=0.00 cross-encoder) | ✗ anchor_504ddb27457 (s=0.99 c=0.02 nli) | ✓ anchor_64a5a183460 (s=1.00 c=0.02 cross-encoder) | ✗ anchor_504ddb27457 (s=0.98 c=0.04 nli) |
| ellekilde | Perle af mat rødligt glas | anchor_0dacceee60e | ✓ anchor_0dacceee60e (s=1.00 c=1.00 lexical) | ✓ anchor_0dacceee60e (s=1.00 c=1.00 lexical) | ✓ anchor_0dacceee60e (s=1.00 c=1.00 lexical) | ✓ anchor_0dacceee60e (s=1.00 c=1.00 lexical) | ✓ anchor_0dacceee60e (s=1.00 c=1.00 lexical) | ✓ anchor_0dacceee60e (s=0.83 c=0.09 cross-encoder) | ✗ anchor_75304c9b7fe (s=0.89 c=0.06 nli*) |
| ellekilde | Lå mellem de to underarmsknogler (24-18) | anchor_d6a0d525a81 | ✓ anchor_d6a0d525a81 (s=1.00 c=1.00 lexical) | ✓ anchor_d6a0d525a81 (s=1.00 c=1.00 lexical) | ✓ anchor_d6a0d525a81 (s=1.00 c=1.00 lexical) | ✓ anchor_d6a0d525a81 (s=1.00 c=1.00 lexical) | ✓ anchor_d6a0d525a81 (s=1.00 c=1.00 lexical) | ✗ anchor_aae8606ee4f (s=0.95 c=0.02 cross-encoder*) | ✗ anchor_a50f61fd724 (s=0.70 c=0.02 nli*) |
| ellekilde | 16-18 år | anchor_0f6b71abf27 | ✓ anchor_0f6b71abf27 (s=1.00 c=1.00 lexical) | ✓ anchor_0f6b71abf27 (s=1.00 c=1.00 lexical) | ✓ anchor_0f6b71abf27 (s=1.00 c=1.00 lexical) | ✓ anchor_0f6b71abf27 (s=1.00 c=1.00 lexical) | ✓ anchor_0f6b71abf27 (s=1.00 c=1.00 lexical) | ✗ — (s=0.03 c=0.02 cross-encoder) | ✗ anchor_c3e1dfba9be (s=0.98 c=0.25 nli*) |
| ellekilde | 15 | anchor_61cb7f12f88 | ✗ — (s=0.00 c=0.00 lexical) | ✓ anchor_61cb7f12f88 (s=0.77 c=0.71 cross-encoder) | ✗ — (s=0.07 c=0.01 nli) | ✗ — (s=0.09 c=0.09 cross-encoder) | ✗ — (s=0.26 c=0.07 nli) | ✓ anchor_61cb7f12f88 (s=0.77 c=0.71 cross-encoder) | ✗ — (s=0.07 c=0.01 nli) |
| ellekilde | 2.8 x 1.3 meter | anchor_72d2d735426 | ✓ anchor_72d2d735426 (s=1.00 c=1.00 lexical) | ✓ anchor_72d2d735426 (s=1.00 c=1.00 lexical) | ✓ anchor_72d2d735426 (s=1.00 c=1.00 lexical) | ✓ anchor_72d2d735426 (s=1.00 c=1.00 lexical) | ✓ anchor_72d2d735426 (s=1.00 c=1.00 lexical) | ✓ anchor_72d2d735426 (s=0.99 c=0.77 cross-encoder) | ✓ anchor_72d2d735426 (s=0.99 c=0.69 nli) |
| ellekilde | 1450 BP | — | ✓ — (s=0.00 c=0.00 lexical) | ✓ — (s=0.00 c=0.00 cross-encoder) | ✓ — (s=0.27 c=0.04 nli) | ✓ — (s=0.00 c=0.00 cross-encoder) | ✓ — (s=0.29 c=0.03 nli) | ✓ — (s=0.00 c=0.00 cross-encoder) | ✓ — (s=0.27 c=0.04 nli) |
| ellekilde | Nationalmuseet i København | — | ✓ — (s=0.00 c=0.00 lexical) | ✓ — (s=0.00 c=0.00 cross-encoder) | ✓ — (s=0.30 c=0.05 nli) | ✓ — (s=0.00 c=0.00 cross-encoder) | ✓ — (s=0.22 c=0.00 nli) | ✓ — (s=0.00 c=0.00 cross-encoder) | ✓ — (s=0.30 c=0.05 nli) |
| ellekilde | Yngre romersk jernalder per. C2 | — | ✓ — (s=0.00 c=0.00 lexical) | ✗ anchor_14aff27f2a5 (s=0.97 c=0.00 cross-encoder*) | ✓ — (s=0.38 c=0.00 nli) | ✗ anchor_b3f723502a1 (s=0.84 c=0.08 cross-encoder*) | ✓ — (s=0.39 c=0.00 nli) | ✗ anchor_14aff27f2a5 (s=0.97 c=0.00 cross-encoder*) | ✓ — (s=0.38 c=0.00 nli) |
| ellekilde | 17-18 år | — | ✓ — (s=0.00 c=0.00 lexical) | ✓ — (s=0.02 c=0.00 cross-encoder) | ✗ anchor_c3e1dfba9be (s=0.97 c=0.03 nli*) | ✓ — (s=0.03 c=0.01 cross-encoder) | ✗ anchor_c3e1dfba9be (s=0.93 c=0.11 nli*) | ✓ — (s=0.02 c=0.00 cross-encoder) | ✗ anchor_c3e1dfba9be (s=0.97 c=0.03 nli*) |
| ellekilde | 8-5 | — | ✓ — (s=0.00 c=0.00 lexical) | ✓ — (s=0.06 c=0.04 cross-encoder) | ✗ anchor_39473e76ce2 (s=0.63 c=0.10 nli*) | ✓ — (s=0.02 c=0.01 cross-encoder) | ✗ anchor_39473e76ce2 (s=0.52 c=0.02 nli*) | ✓ — (s=0.06 c=0.04 cross-encoder) | ✗ anchor_39473e76ce2 (s=0.63 c=0.10 nli*) |
| free-ports-hamburg | Free ports, political economy, and ea… | anchor_715a690ae19+1 | ✗ — (s=0.00 c=0.00 lexical) | ✓ anchor_715a690ae19 (s=1.00 c=0.04 cross-encoder) | ✓ anchor_715a690ae19 (s=0.94 c=0.27 nli) | ✓ anchor_715a690ae19 (s=1.00 c=0.05 cross-encoder) | ✗ — (s=0.33 c=0.15 nli) | ✓ anchor_715a690ae19 (s=1.00 c=0.04 cross-encoder) | ✓ anchor_715a690ae19 (s=0.94 c=0.27 nli) |
| free-ports-hamburg | Esther Sahle | anchor_88f4fa65a5b+3 | ✗ — (s=0.00 c=0.00 lexical) | ✓ anchor_5f4b01d8e7c (s=0.90 c=0.00 cross-encoder) | ✓ anchor_44e6909168b (s=0.83 c=0.00 nli) | ✓ anchor_5f4b01d8e7c (s=0.94 c=0.01 cross-encoder) | ✓ anchor_5f4b01d8e7c (s=0.76 c=0.02 nli) | ✓ anchor_5f4b01d8e7c (s=0.90 c=0.00 cross-encoder) | ✓ anchor_44e6909168b (s=0.83 c=0.00 nli) |
| free-ports-hamburg | University of Copenhagen, Saxo Institute | anchor_f526f6d7993 | ✓ anchor_f526f6d7993 (s=1.00 c=1.00 lexical) | ✓ anchor_f526f6d7993 (s=1.00 c=1.00 lexical) | ✓ anchor_f526f6d7993 (s=1.00 c=1.00 lexical) | ✓ anchor_f526f6d7993 (s=1.00 c=1.00 lexical) | ✓ anchor_f526f6d7993 (s=1.00 c=1.00 lexical) | ✗ — (s=0.09 c=0.09 cross-encoder) | ✗ — (s=0.31 c=0.05 nli) |
| free-ports-hamburg | Cambridge University Press | anchor_bf89e84c6f5 | ✗ — (s=0.00 c=0.00 lexical) | ✓ anchor_bf89e84c6f5 (s=0.96 c=0.58 cross-encoder) | ✓ anchor_bf89e84c6f5 (s=1.00 c=0.40 nli) | ✓ anchor_bf89e84c6f5 (s=0.61 c=0.40 cross-encoder) | ✓ anchor_bf89e84c6f5 (s=0.88 c=0.23 nli) | ✓ anchor_bf89e84c6f5 (s=0.96 c=0.58 cross-encoder) | ✓ anchor_bf89e84c6f5 (s=1.00 c=0.40 nli) |
| free-ports-hamburg | 1591 | anchor_4d4f009f7ea | ✗ — (s=0.00 c=0.00 lexical) | ✗ anchor_bd257a4cdd6 (s=0.87 c=0.35 cross-encoder) | ✗ — (s=0.25 c=0.08 nli) | ✓ anchor_4d4f009f7ea (s=0.70 c=0.70 cross-encoder) | ✓ anchor_4d4f009f7ea (s=0.73 c=0.59 nli) | ✗ anchor_bd257a4cdd6 (s=0.87 c=0.35 cross-encoder) | ✗ — (s=0.25 c=0.08 nli) |
| free-ports-hamburg | Livorno | anchor_b771fc1a940 | ✗ — (s=0.00 c=0.00 lexical) | ✗ anchor_d102ccfec30 (s=0.99 c=0.00 cross-encoder*) | ✗ anchor_4d4f009f7ea (s=0.93 c=0.03 nli*) | ✓ anchor_b771fc1a940 (s=0.94 c=0.09 cross-encoder) | ✓ anchor_b771fc1a940 (s=0.82 c=0.05 nli) | ✗ anchor_d102ccfec30 (s=0.99 c=0.00 cross-encoder*) | ✗ anchor_4d4f009f7ea (s=0.93 c=0.03 nli*) |
| free-ports-hamburg | 1664 | anchor_e6b6e28c620 | ✓ anchor_e6b6e28c620 (s=1.00 c=1.00 lexical) | ✓ anchor_e6b6e28c620 (s=1.00 c=1.00 lexical) | ✓ anchor_e6b6e28c620 (s=1.00 c=1.00 lexical) | ✓ anchor_e6b6e28c620 (s=1.00 c=1.00 lexical) | ✓ anchor_e6b6e28c620 (s=1.00 c=1.00 lexical) | ✗ — (s=0.38 c=0.08 cross-encoder) | ✗ — (s=0.20 c=0.00 nli) |
| free-ports-hamburg | 1706 | anchor_1215213c04a | ✓ anchor_1215213c04a (s=1.00 c=1.00 lexical) | ✓ anchor_1215213c04a (s=1.00 c=1.00 lexical) | ✓ anchor_1215213c04a (s=1.00 c=1.00 lexical) | ✓ anchor_1215213c04a (s=1.00 c=1.00 lexical) | ✓ anchor_1215213c04a (s=1.00 c=1.00 lexical) | ✗ — (s=0.34 c=0.09 cross-encoder) | ✗ — (s=0.19 c=0.06 nli) |
| free-ports-hamburg | 1766 | anchor_1ec2abd17b7 | ✗ — (s=0.00 c=0.00 lexical) | ✓ anchor_1ec2abd17b7 (s=0.99 c=0.00 cross-encoder) | ✗ — (s=0.19 c=0.00 nli) | ✗ anchor_ff608eaf4a3 (s=0.60 c=0.28 cross-encoder) | ✗ — (s=0.47 c=0.04 nli) | ✓ anchor_1ec2abd17b7 (s=0.99 c=0.00 cross-encoder) | ✗ — (s=0.19 c=0.00 nli) |
| free-ports-hamburg | University of Oxford | — | ✓ — (s=0.00 c=0.00 lexical) | ✓ — (s=0.01 c=0.00 cross-encoder) | ✗ anchor_8894d3a6add (s=0.83 c=0.25 nli*) | ✓ — (s=0.08 c=0.07 cross-encoder) | ✗ anchor_cbc55de770a (s=0.92 c=0.25 nli*) | ✓ — (s=0.01 c=0.00 cross-encoder) | ✗ anchor_8894d3a6add (s=0.83 c=0.25 nli*) |
| free-ports-hamburg | Esther Sahler | — | ✓ — (s=0.00 c=0.00 lexical) | ✗ anchor_0818d48dc5c (s=0.82 c=0.00 cross-encoder*) | ✗ anchor_44e6909168b (s=0.82 c=0.01 nli*) | ✗ anchor_5f4b01d8e7c (s=0.89 c=0.01 cross-encoder*) | ✗ anchor_5f4b01d8e7c (s=0.85 c=0.02 nli*) | ✗ anchor_0818d48dc5c (s=0.82 c=0.00 cross-encoder*) | ✗ anchor_44e6909168b (s=0.82 c=0.01 nli*) |
| free-ports-hamburg | 1592 | — | ✓ — (s=0.00 c=0.00 lexical) | ✗ anchor_bd257a4cdd6 (s=0.73 c=0.25 cross-encoder*) | ✗ anchor_de458808503 (s=0.69 c=0.19 nli*) | ✓ — (s=0.01 c=0.00 cross-encoder) | ✓ — (s=0.08 c=0.02 nli) | ✗ anchor_bd257a4cdd6 (s=0.73 c=0.25 cross-encoder*) | ✗ anchor_de458808503 (s=0.69 c=0.19 nli*) |
| free-ports-hamburg | 159 | — | ✓ — (s=0.00 c=0.00 lexical) | ✗ anchor_bd257a4cdd6 (s=0.85 c=0.25 cross-encoder*) | ✓ — (s=0.47 c=0.03 nli) | ✓ — (s=0.17 c=0.05 cross-encoder) | ✓ — (s=0.30 c=0.00 nli) | ✗ anchor_bd257a4cdd6 (s=0.85 c=0.25 cross-encoder*) | ✓ — (s=0.47 c=0.03 nli) |
| herredsvejen | SBM1694 | anchor_fb53d73b0be | ✓ anchor_fb53d73b0be (s=1.00 c=1.00 lexical) | ✓ anchor_fb53d73b0be (s=1.00 c=1.00 lexical) | ✓ anchor_fb53d73b0be (s=1.00 c=1.00 lexical) | ✓ anchor_fb53d73b0be (s=1.00 c=1.00 lexical) | ✓ anchor_fb53d73b0be (s=1.00 c=1.00 lexical) | ✗ — (s=0.43 c=0.42 cross-encoder) | ✓ anchor_fb53d73b0be (s=0.94 c=0.42 nli) |
| herredsvejen | Merethe Schifter Bagge | anchor_30e2ff5d0f8+2 | ✗ — (s=0.00 c=0.00 lexical) | ✓ anchor_d33917c2342 (s=0.84 c=0.04 cross-encoder) | ✗ — (s=0.25 c=0.05 nli) | ✓ anchor_941fb6c38aa (s=0.98 c=0.98 cross-encoder) | ✓ anchor_941fb6c38aa (s=0.89 c=0.58 nli) | ✓ anchor_d33917c2342 (s=0.84 c=0.04 cross-encoder) | ✗ — (s=0.25 c=0.05 nli) |
| herredsvejen | 23-09-2019 | anchor_122c7838e35+2 | ✓ anchor_122c7838e35 (s=1.00 c=1.00 lexical) | ✓ anchor_122c7838e35 (s=1.00 c=1.00 lexical) | ✓ anchor_122c7838e35 (s=1.00 c=1.00 lexical) | ✓ anchor_122c7838e35 (s=1.00 c=1.00 lexical) | ✓ anchor_122c7838e35 (s=1.00 c=1.00 lexical) | ✓ anchor_122c7838e35 (s=0.98 c=0.67 cross-encoder) | ✓ anchor_036fde44f39 (s=0.95 c=0.24 nli*) |
| herredsvejen | 20. november 2019 | anchor_c20ee246bb9+1 | ✗ — (s=0.00 c=0.00 lexical) | ✗ — (s=0.28 c=0.02 cross-encoder) | ✓ anchor_c20ee246bb9 (s=0.96 c=0.34 nli) | ✓ anchor_d33917c2342 (s=0.91 c=0.10 cross-encoder) | ✗ — (s=0.33 c=0.15 nli) | ✗ — (s=0.28 c=0.02 cross-encoder) | ✓ anchor_c20ee246bb9 (s=0.96 c=0.34 nli) |
| herredsvejen | 19/06370 | anchor_122c7838e35 | ✓ anchor_122c7838e35 (s=1.00 c=1.00 lexical) | ✓ anchor_122c7838e35 (s=1.00 c=1.00 lexical) | ✓ anchor_122c7838e35 (s=1.00 c=1.00 lexical) | ✓ anchor_122c7838e35 (s=1.00 c=1.00 lexical) | ✓ anchor_122c7838e35 (s=1.00 c=1.00 lexical) | ✓ anchor_122c7838e35 (s=0.99 c=0.93 cross-encoder) | ✓ anchor_122c7838e35 (s=0.99 c=0.56 nli) |
| herredsvejen | 576 | anchor_7227d563157 | ✓ anchor_7227d563157 (s=1.00 c=1.00 lexical) | ✓ anchor_7227d563157 (s=1.00 c=1.00 lexical) | ✓ anchor_7227d563157 (s=1.00 c=1.00 lexical) | ✓ anchor_7227d563157 (s=1.00 c=1.00 lexical) | ✓ anchor_7227d563157 (s=1.00 c=1.00 lexical) | ✓ anchor_7227d563157 (s=0.56 c=0.56 cross-encoder) | ✓ anchor_7227d563157 (s=0.96 c=0.47 nli) |
| herredsvejen | 362 | anchor_7227d563157 | ✓ anchor_7227d563157 (s=1.00 c=1.00 lexical) | ✓ anchor_7227d563157 (s=1.00 c=1.00 lexical) | ✓ anchor_7227d563157 (s=1.00 c=1.00 lexical) | ✓ anchor_7227d563157 (s=1.00 c=1.00 lexical) | ✓ anchor_7227d563157 (s=1.00 c=1.00 lexical) | ✗ — (s=0.48 c=0.48 cross-encoder) | ✓ anchor_7227d563157 (s=0.97 c=0.85 nli) |
| herredsvejen | Poul Kragh | anchor_c0395884a7d | ✓ anchor_c0395884a7d (s=1.00 c=1.00 lexical) | ✓ anchor_c0395884a7d (s=1.00 c=1.00 lexical) | ✓ anchor_c0395884a7d (s=1.00 c=1.00 lexical) | ✓ anchor_c0395884a7d (s=1.00 c=1.00 lexical) | ✓ anchor_c0395884a7d (s=1.00 c=1.00 lexical) | ✓ anchor_c0395884a7d (s=1.00 c=1.00 cross-encoder) | ✓ anchor_c0395884a7d (s=0.98 c=0.68 nli) |
| herredsvejen | Skanderborg Kommune, Teknik og Miljø | anchor_97f36f8b78f | ✓ anchor_97f36f8b78f (s=1.00 c=1.00 lexical) | ✓ anchor_97f36f8b78f (s=1.00 c=1.00 lexical) | ✓ anchor_97f36f8b78f (s=1.00 c=1.00 lexical) | ✓ anchor_97f36f8b78f (s=1.00 c=1.00 lexical) | ✓ anchor_97f36f8b78f (s=1.00 c=1.00 lexical) | ✗ — (s=0.39 c=0.39 cross-encoder) | ✓ anchor_97f36f8b78f (s=0.90 c=0.43 nli) |
| herredsvejen | Lars Lykke Jensen | anchor_97f36f8b78f | ✓ anchor_97f36f8b78f (s=1.00 c=1.00 lexical) | ✓ anchor_97f36f8b78f (s=1.00 c=1.00 lexical) | ✓ anchor_97f36f8b78f (s=1.00 c=1.00 lexical) | ✓ anchor_97f36f8b78f (s=1.00 c=1.00 lexical) | ✓ anchor_97f36f8b78f (s=1.00 c=1.00 lexical) | ✗ — (s=0.47 c=0.47 cross-encoder) | ✓ anchor_97f36f8b78f (s=0.66 c=0.33 nli) |
| herredsvejen | ca. 23 m | anchor_e1d16a1197c | ✓ anchor_e1d16a1197c (s=1.00 c=1.00 lexical) | ✓ anchor_e1d16a1197c (s=1.00 c=1.00 lexical) | ✓ anchor_e1d16a1197c (s=1.00 c=1.00 lexical) | ✓ anchor_e1d16a1197c (s=1.00 c=1.00 lexical) | ✓ anchor_e1d16a1197c (s=1.00 c=1.00 lexical) | ✗ — (s=0.47 c=0.47 cross-encoder) | ✓ anchor_e1d16a1197c (s=0.95 c=0.77 nli) |
| herredsvejen | 13,5 m | anchor_68f25e6d447 | ✓ anchor_68f25e6d447 (s=1.00 c=1.00 lexical) | ✓ anchor_68f25e6d447 (s=1.00 c=1.00 lexical) | ✓ anchor_68f25e6d447 (s=1.00 c=1.00 lexical) | ✓ anchor_68f25e6d447 (s=1.00 c=1.00 lexical) | ✓ anchor_68f25e6d447 (s=1.00 c=1.00 lexical) | ✓ anchor_68f25e6d447 (s=0.82 c=0.82 cross-encoder) | ✗ — (s=0.15 c=0.05 nli) |
| herredsvejen | X233 | anchor_18313ce3b66+2 | ✗ — (s=0.00 c=0.00 lexical) | ✓ anchor_5d3db8876b9 (s=0.69 c=0.66 cross-encoder) | ✓ anchor_5d3db8876b9 (s=0.88 c=0.79 nli) | ✓ anchor_5d3db8876b9 (s=0.99 c=0.07 cross-encoder) | ✓ anchor_a4e5b2d0e6d (s=0.86 c=0.73 nli) | ✓ anchor_5d3db8876b9 (s=0.69 c=0.66 cross-encoder) | ✓ anchor_5d3db8876b9 (s=0.88 c=0.79 nli) |
| herredsvejen | 6 x 4 mm | anchor_5d3db8876b9 | ✓ anchor_5d3db8876b9 (s=1.00 c=1.00 lexical) | ✓ anchor_5d3db8876b9 (s=1.00 c=1.00 lexical) | ✓ anchor_5d3db8876b9 (s=1.00 c=1.00 lexical) | ✓ anchor_5d3db8876b9 (s=1.00 c=1.00 lexical) | ✓ anchor_5d3db8876b9 (s=1.00 c=1.00 lexical) | ✓ anchor_5d3db8876b9 (s=0.87 c=0.87 cross-encoder) | ✓ anchor_5d3db8876b9 (s=0.99 c=0.81 nli) |
| herredsvejen | AAR 33273 | anchor_63fdd9a6f47 | ✓ anchor_63fdd9a6f47 (s=1.00 c=1.00 lexical) | ✓ anchor_63fdd9a6f47 (s=1.00 c=1.00 lexical) | ✓ anchor_63fdd9a6f47 (s=1.00 c=1.00 lexical) | ✓ anchor_63fdd9a6f47 (s=1.00 c=1.00 lexical) | ✓ anchor_63fdd9a6f47 (s=1.00 c=1.00 lexical) | ✓ anchor_63fdd9a6f47 (s=0.96 c=0.96 cross-encoder) | ✓ anchor_63fdd9a6f47 (s=0.94 c=0.61 nli) |
| herredsvejen | 41 fragmenter | anchor_8b631316cef | ✓ anchor_8b631316cef (s=1.00 c=1.00 lexical) | ✓ anchor_8b631316cef (s=1.00 c=1.00 lexical) | ✓ anchor_8b631316cef (s=1.00 c=1.00 lexical) | ✓ anchor_8b631316cef (s=1.00 c=1.00 lexical) | ✓ anchor_8b631316cef (s=1.00 c=1.00 lexical) | ✗ — (s=0.24 c=0.22 cross-encoder) | ✗ — (s=0.31 c=0.16 nli) |
| herredsvejen | 5.853 m2 | anchor_5a1c177ea58 | ✓ anchor_5a1c177ea58 (s=1.00 c=1.00 lexical) | ✓ anchor_5a1c177ea58 (s=1.00 c=1.00 lexical) | ✓ anchor_5a1c177ea58 (s=1.00 c=1.00 lexical) | ✓ anchor_5a1c177ea58 (s=1.00 c=1.00 lexical) | ✓ anchor_5a1c177ea58 (s=1.00 c=1.00 lexical) | ✓ anchor_5a1c177ea58 (s=0.85 c=0.85 cross-encoder) | ✓ anchor_5a1c177ea58 (s=1.00 c=0.30 nli) |
| herredsvejen | 1300 m2 | anchor_9f47ea13623 | ✗ — (s=0.00 c=0.00 lexical) | ✓ anchor_9f47ea13623 (s=0.95 c=0.25 cross-encoder*) | ✓ anchor_9f47ea13623 (s=0.84 c=0.25 nli*) | ✗ — (s=0.01 c=0.01 cross-encoder) | ✗ — (s=0.09 c=0.02 nli) | ✓ anchor_9f47ea13623 (s=0.95 c=0.25 cross-encoder*) | ✓ anchor_9f47ea13623 (s=0.84 c=0.25 nli*) |
| herredsvejen | SBM1695 | — | ✓ — (s=0.00 c=0.00 lexical) | ✓ — (s=0.04 c=0.03 cross-encoder) | ✗ anchor_038aa087fb6 (s=0.51 c=0.07 nli*) | ✓ — (s=0.41 c=0.30 cross-encoder) | ✗ anchor_d6fefec2b30 (s=0.51 c=0.13 nli*) | ✓ — (s=0.04 c=0.03 cross-encoder) | ✗ anchor_038aa087fb6 (s=0.51 c=0.07 nli*) |
| herredsvejen | AAR 33274 | — | ✓ — (s=0.00 c=0.00 lexical) | ✗ anchor_63fdd9a6f47 (s=0.77 c=0.25 cross-encoder*) | ✓ — (s=0.33 c=0.10 nli) | ✓ — (s=0.01 c=0.00 cross-encoder) | ✓ — (s=0.40 c=0.15 nli) | ✗ anchor_63fdd9a6f47 (s=0.77 c=0.25 cross-encoder*) | ✓ — (s=0.33 c=0.10 nli) |
| herredsvejen | Merete Schifter Bagge | — | ✓ — (s=0.00 c=0.00 lexical) | ✗ anchor_d33917c2342 (s=0.83 c=0.06 cross-encoder*) | ✓ — (s=0.31 c=0.12 nli) | ✗ anchor_941fb6c38aa (s=0.96 c=0.25 cross-encoder*) | ✗ anchor_941fb6c38aa (s=0.94 c=0.25 nli*) | ✗ anchor_d33917c2342 (s=0.83 c=0.06 cross-encoder*) | ✓ — (s=0.31 c=0.12 nli) |
| herredsvejen | K14 | — | ✓ — (s=0.00 c=0.00 lexical) | ✓ — (s=0.02 c=0.01 cross-encoder) | ✓ — (s=0.36 c=0.31 nli) | ✓ — (s=0.09 c=0.08 cross-encoder) | ✓ — (s=0.29 c=0.03 nli) | ✓ — (s=0.02 c=0.01 cross-encoder) | ✓ — (s=0.36 c=0.31 nli) |
| herredsvejen | Nationalmuseet | — | ✓ — (s=0.00 c=0.00 lexical) | ✓ — (s=0.00 c=0.00 cross-encoder) | ✓ — (s=0.12 c=0.02 nli) | ✓ — (s=0.00 c=0.00 cross-encoder) | ✓ — (s=0.22 c=0.06 nli) | ✓ — (s=0.00 c=0.00 cross-encoder) | ✓ — (s=0.12 c=0.02 nli) |
| hojbakkegaard | TAK 1177 | anchor_9a60b8b8638+3 | ✗ — (s=0.00 c=0.00 lexical) | ✓ anchor_9a60b8b8638 (s=1.00 c=0.18 cross-encoder) | ✓ anchor_704826c0edd (s=0.95 c=0.01 nli) | ✓ anchor_9a60b8b8638 (s=1.00 c=0.03 cross-encoder) | ✓ anchor_d850df38f5a (s=0.91 c=0.01 nli) | ✓ anchor_9a60b8b8638 (s=1.00 c=0.18 cross-encoder) | ✓ anchor_704826c0edd (s=0.95 c=0.01 nli) |
| hojbakkegaard | 020214-65, -66 | anchor_83f13172419 | ✓ anchor_83f13172419 (s=1.00 c=1.00 lexical) | ✓ anchor_83f13172419 (s=1.00 c=1.00 lexical) | ✓ anchor_83f13172419 (s=1.00 c=1.00 lexical) | ✓ anchor_83f13172419 (s=1.00 c=1.00 lexical) | ✓ anchor_83f13172419 (s=1.00 c=1.00 lexical) | ✓ anchor_83f13172419 (s=1.00 c=1.00 cross-encoder) | ✓ anchor_83f13172419 (s=0.93 c=0.59 nli) |
| hojbakkegaard | Tom Giersing | anchor_51b6ddcfa56 | ✓ anchor_51b6ddcfa56 (s=1.00 c=1.00 lexical) | ✓ anchor_51b6ddcfa56 (s=1.00 c=1.00 lexical) | ✓ anchor_51b6ddcfa56 (s=1.00 c=1.00 lexical) | ✓ anchor_51b6ddcfa56 (s=1.00 c=1.00 lexical) | ✓ anchor_51b6ddcfa56 (s=1.00 c=1.00 lexical) | ✓ anchor_51b6ddcfa56 (s=1.00 c=1.00 cross-encoder) | ✓ anchor_51b6ddcfa56 (s=0.98 c=0.64 nli) |
| hojbakkegaard | Mette Brosolat Ohlsen | anchor_a76cdef2866+1 | ✗ — (s=0.00 c=0.00 lexical) | ✓ anchor_a76cdef2866 (s=0.98 c=0.97 cross-encoder) | ✓ anchor_a76cdef2866 (s=0.98 c=0.56 nli) | ✓ anchor_a76cdef2866 (s=0.89 c=0.06 cross-encoder) | ✓ anchor_a76cdef2866 (s=0.89 c=0.28 nli) | ✓ anchor_a76cdef2866 (s=0.98 c=0.97 cross-encoder) | ✓ anchor_a76cdef2866 (s=0.98 c=0.56 nli) |
| hojbakkegaard | ca. 210-250 e.Kr | anchor_1df768b7d8f | ✓ anchor_1df768b7d8f (s=1.00 c=1.00 lexical) | ✓ anchor_1df768b7d8f (s=1.00 c=1.00 lexical) | ✓ anchor_1df768b7d8f (s=1.00 c=1.00 lexical) | ✓ anchor_1df768b7d8f (s=1.00 c=1.00 lexical) | ✓ anchor_1df768b7d8f (s=1.00 c=1.00 lexical) | ✓ anchor_1df768b7d8f (s=0.99 c=0.87 cross-encoder) | ✓ anchor_1df768b7d8f (s=0.95 c=0.42 nli) |
| hojbakkegaard | ca. 400 e.Kr. | anchor_4cb663f7eac | ✗ — (s=0.00 c=0.00 lexical) | ✓ anchor_4cb663f7eac (s=0.96 c=0.22 cross-encoder) | ✓ anchor_4cb663f7eac (s=0.97 c=0.07 nli) | ✓ anchor_4cb663f7eac (s=0.95 c=0.23 cross-encoder) | ✓ anchor_4cb663f7eac (s=0.88 c=0.02 nli) | ✓ anchor_4cb663f7eac (s=0.96 c=0.22 cross-encoder) | ✓ anchor_4cb663f7eac (s=0.97 c=0.07 nli) |
| hojbakkegaard | 32 | anchor_546040a3e1e | ✓ anchor_546040a3e1e (s=1.00 c=1.00 lexical) | ✓ anchor_546040a3e1e (s=1.00 c=1.00 lexical) | ✓ anchor_546040a3e1e (s=1.00 c=1.00 lexical) | ✓ anchor_546040a3e1e (s=1.00 c=1.00 lexical) | ✓ anchor_546040a3e1e (s=1.00 c=1.00 lexical) | ✗ — (s=0.35 c=0.14 cross-encoder) | ✗ — (s=0.16 c=0.02 nli) |
| hojbakkegaard | 2.20 meter | anchor_e183d0f5fc4 | ✓ anchor_e183d0f5fc4 (s=1.00 c=1.00 lexical) | ✓ anchor_e183d0f5fc4 (s=1.00 c=1.00 lexical) | ✓ anchor_e183d0f5fc4 (s=1.00 c=1.00 lexical) | ✓ anchor_e183d0f5fc4 (s=1.00 c=1.00 lexical) | ✓ anchor_e183d0f5fc4 (s=1.00 c=1.00 lexical) | ✗ anchor_2d0ddabc9de (s=0.85 c=0.13 cross-encoder*) | ✓ anchor_e183d0f5fc4 (s=1.00 c=0.60 nli) |
| hojbakkegaard | Lone Brorson | anchor_1b0366f3c39 | ✓ anchor_1b0366f3c39 (s=1.00 c=1.00 lexical) | ✓ anchor_1b0366f3c39 (s=1.00 c=1.00 lexical) | ✓ anchor_1b0366f3c39 (s=1.00 c=1.00 lexical) | ✓ anchor_1b0366f3c39 (s=1.00 c=1.00 lexical) | ✓ anchor_1b0366f3c39 (s=1.00 c=1.00 lexical) | ✓ anchor_1b0366f3c39 (s=0.96 c=0.96 cross-encoder) | ✓ anchor_1b0366f3c39 (s=0.99 c=0.70 nli) |
| hojbakkegaard | Jan Poulsen | anchor_04f72452ee4 | ✓ anchor_04f72452ee4 (s=1.00 c=1.00 lexical) | ✓ anchor_04f72452ee4 (s=1.00 c=1.00 lexical) | ✓ anchor_04f72452ee4 (s=1.00 c=1.00 lexical) | ✓ anchor_04f72452ee4 (s=1.00 c=1.00 lexical) | ✓ anchor_04f72452ee4 (s=1.00 c=1.00 lexical) | ✓ anchor_04f72452ee4 (s=0.84 c=0.84 cross-encoder) | ✓ anchor_04f72452ee4 (s=0.93 c=0.60 nli) |
| hojbakkegaard | 2004-08-13 | anchor_143c9746911 | ✗ — (s=0.00 c=0.00 lexical) | ✓ anchor_143c9746911 (s=0.92 c=0.25 cross-encoder*) | ✓ anchor_143c9746911 (s=0.97 c=0.25 nli*) | ✗ — (s=0.01 c=0.01 cross-encoder) | ✗ — (s=0.41 c=0.06 nli) | ✓ anchor_143c9746911 (s=0.92 c=0.25 cross-encoder*) | ✓ anchor_143c9746911 (s=0.97 c=0.25 nli*) |
| hojbakkegaard | 55.6702 N | — | ✓ — (s=0.00 c=0.00 lexical) | ✓ — (s=0.04 c=0.04 cross-encoder) | ✓ — (s=0.48 c=0.13 nli) | ✓ — (s=0.07 c=0.07 cross-encoder) | ✗ anchor_198a586cff1 (s=0.60 c=0.22 nli*) | ✓ — (s=0.04 c=0.04 cross-encoder) | ✓ — (s=0.48 c=0.13 nli) |
| hojbakkegaard | 3950 BP | — | ✓ — (s=0.00 c=0.00 lexical) | ✓ — (s=0.00 c=0.00 cross-encoder) | ✓ — (s=0.27 c=0.02 nli) | ✓ — (s=0.00 c=0.00 cross-encoder) | ✓ — (s=0.30 c=0.01 nli) | ✓ — (s=0.00 c=0.00 cross-encoder) | ✓ — (s=0.27 c=0.02 nli) |
| hojbakkegaard | TAK 1178 | — | ✓ — (s=0.00 c=0.00 lexical) | ✗ anchor_9a60b8b8638 (s=0.53 c=0.25 cross-encoder*) | ✓ — (s=0.31 c=0.01 nli) | ✓ — (s=0.15 c=0.11 cross-encoder) | ✓ — (s=0.22 c=0.05 nli) | ✗ anchor_9a60b8b8638 (s=0.53 c=0.25 cross-encoder*) | ✓ — (s=0.31 c=0.01 nli) |
| hojbakkegaard | 020214-67 | — | ✓ — (s=0.00 c=0.00 lexical) | ✗ anchor_83f13172419 (s=0.75 c=0.25 cross-encoder*) | ✓ — (s=0.20 c=0.01 nli) | ✗ anchor_83f13172419 (s=0.70 c=0.25 cross-encoder*) | ✓ — (s=0.25 c=0.03 nli) | ✗ anchor_83f13172419 (s=0.75 c=0.25 cross-encoder*) | ✓ — (s=0.20 c=0.01 nli) |
| hojbakkegaard | 33 | — | ✓ — (s=0.00 c=0.00 lexical) | ✓ — (s=0.04 c=0.02 cross-encoder) | ✓ — (s=0.10 c=0.00 nli) | ✓ — (s=0.02 c=0.02 cross-encoder) | ✓ — (s=0.30 c=0.16 nli) | ✓ — (s=0.04 c=0.02 cross-encoder) | ✓ — (s=0.10 c=0.00 nli) |
| hojbakkegaard | 17. august 2004 | — | ✓ — (s=0.00 c=0.00 lexical) | ✓ — (s=0.32 c=0.31 cross-encoder) | ✓ — (s=0.33 c=0.06 nli) | ✓ — (s=0.07 c=0.06 cross-encoder) | ✓ — (s=0.28 c=0.01 nli) | ✓ — (s=0.32 c=0.31 cross-encoder) | ✓ — (s=0.33 c=0.06 nli) |
| hvissinge | TAK 1728 | anchor_a4fb0e662bb+1 | ✗ — (s=0.00 c=0.00 lexical) | ✗ — (s=0.25 c=0.24 cross-encoder) | ✓ anchor_a4fb0e662bb (s=0.98 c=0.63 nli) | ✗ — (s=0.39 c=0.39 cross-encoder) | ✓ anchor_a4fb0e662bb (s=0.86 c=0.62 nli) | ✗ — (s=0.25 c=0.24 cross-encoder) | ✓ anchor_a4fb0e662bb (s=0.98 c=0.63 nli) |
| hvissinge | Bo Jensen | anchor_e6a27f42262+2 | ✗ — (s=0.00 c=0.00 lexical) | ✗ — (s=0.18 c=0.17 cross-encoder) | ✓ anchor_e6a27f42262 (s=0.97 c=0.63 nli) | ✓ anchor_e6a27f42262 (s=0.96 c=0.91 cross-encoder) | ✓ anchor_e6a27f42262 (s=0.55 c=0.26 nli) | ✗ — (s=0.18 c=0.17 cross-encoder) | ✓ anchor_e6a27f42262 (s=0.97 c=0.63 nli) |
| hvissinge | Linda Boye | anchor_b658d978bc5+2 | ✗ — (s=0.00 c=0.00 lexical) | ✓ anchor_b658d978bc5 (s=0.99 c=0.99 cross-encoder) | ✓ anchor_b658d978bc5 (s=1.00 c=0.75 nli) | ✗ — (s=0.00 c=0.00 cross-encoder) | ✗ — (s=0.29 c=0.02 nli) | ✓ anchor_b658d978bc5 (s=0.99 c=0.99 cross-encoder) | ✓ anchor_b658d978bc5 (s=1.00 c=0.75 nli) |
| hvissinge | 20-06-2016 | anchor_b9626568d28 | ✓ anchor_b9626568d28 (s=1.00 c=1.00 lexical) | ✓ anchor_b9626568d28 (s=1.00 c=1.00 lexical) | ✓ anchor_b9626568d28 (s=1.00 c=1.00 lexical) | ✓ anchor_b9626568d28 (s=1.00 c=1.00 lexical) | ✓ anchor_b9626568d28 (s=1.00 c=1.00 lexical) | ✓ anchor_b9626568d28 (s=0.85 c=0.83 cross-encoder) | ✓ anchor_b9626568d28 (s=0.98 c=0.86 nli) |
| hvissinge | 27-07-2016 | anchor_a155015fd9f+1 | ✗ — (s=0.00 c=0.00 lexical) | ✓ anchor_a155015fd9f (s=0.97 c=0.08 cross-encoder) | ✓ anchor_a155015fd9f (s=1.00 c=0.39 nli) | ✗ — (s=0.01 c=0.01 cross-encoder) | ✗ — (s=0.35 c=0.02 nli) | ✓ anchor_a155015fd9f (s=0.97 c=0.08 cross-encoder) | ✓ anchor_a155015fd9f (s=1.00 c=0.39 nli) |
| hvissinge | 267 | anchor_39bb0aa22e1 | ✓ anchor_39bb0aa22e1 (s=1.00 c=1.00 lexical) | ✓ anchor_39bb0aa22e1 (s=1.00 c=1.00 lexical) | ✓ anchor_39bb0aa22e1 (s=1.00 c=1.00 lexical) | ✓ anchor_39bb0aa22e1 (s=1.00 c=1.00 lexical) | ✓ anchor_39bb0aa22e1 (s=1.00 c=1.00 lexical) | ✓ anchor_39bb0aa22e1 (s=0.82 c=0.82 cross-encoder) | ✓ anchor_39bb0aa22e1 (s=0.99 c=0.75 nli) |
| hvissinge | cirka 173 cm | anchor_cc1c4dac3dd | ✓ anchor_cc1c4dac3dd (s=1.00 c=1.00 lexical) | ✓ anchor_cc1c4dac3dd (s=1.00 c=1.00 lexical) | ✓ anchor_cc1c4dac3dd (s=1.00 c=1.00 lexical) | ✓ anchor_cc1c4dac3dd (s=1.00 c=1.00 lexical) | ✓ anchor_cc1c4dac3dd (s=1.00 c=1.00 lexical) | ✓ anchor_cc1c4dac3dd (s=0.79 c=0.74 cross-encoder) | ✓ anchor_cc1c4dac3dd (s=0.98 c=0.89 nli) |
| hvissinge | 135 cm | anchor_0a1cae114ce | ✓ anchor_0a1cae114ce (s=1.00 c=1.00 lexical) | ✓ anchor_0a1cae114ce (s=1.00 c=1.00 lexical) | ✓ anchor_0a1cae114ce (s=1.00 c=1.00 lexical) | ✓ anchor_0a1cae114ce (s=1.00 c=1.00 lexical) | ✓ anchor_0a1cae114ce (s=1.00 c=1.00 lexical) | ✓ anchor_0a1cae114ce (s=0.79 c=0.78 cross-encoder) | ✓ anchor_0a1cae114ce (s=1.00 c=0.93 nli) |
| hvissinge | 172 cm | anchor_c1c385a8c88 | ✓ anchor_c1c385a8c88 (s=1.00 c=1.00 lexical) | ✓ anchor_c1c385a8c88 (s=1.00 c=1.00 lexical) | ✓ anchor_c1c385a8c88 (s=1.00 c=1.00 lexical) | ✓ anchor_c1c385a8c88 (s=1.00 c=1.00 lexical) | ✓ anchor_c1c385a8c88 (s=1.00 c=1.00 lexical) | ✓ anchor_c1c385a8c88 (s=0.72 c=0.65 cross-encoder) | ✓ anchor_c1c385a8c88 (s=0.80 c=0.78 nli) |
| hvissinge | 58 cm | anchor_942ba80df00 | ✗ — (s=0.00 c=0.00 lexical) | ✗ — (s=0.48 c=0.48 cross-encoder) | ✓ anchor_942ba80df00 (s=1.00 c=0.92 nli) | ✗ — (s=0.40 c=0.33 cross-encoder) | ✓ anchor_942ba80df00 (s=0.99 c=0.65 nli) | ✗ — (s=0.48 c=0.48 cross-encoder) | ✓ anchor_942ba80df00 (s=1.00 c=0.92 nli) |
| hvissinge | Kurt Herskind | anchor_b27b10f35d8 | ✓ anchor_b27b10f35d8 (s=1.00 c=1.00 lexical) | ✓ anchor_b27b10f35d8 (s=1.00 c=1.00 lexical) | ✓ anchor_b27b10f35d8 (s=1.00 c=1.00 lexical) | ✓ anchor_b27b10f35d8 (s=1.00 c=1.00 lexical) | ✓ anchor_b27b10f35d8 (s=1.00 c=1.00 lexical) | ✗ — (s=0.00 c=0.00 cross-encoder) | ✗ — (s=0.24 c=0.07 nli) |
| hvissinge | Hanus Jensen | anchor_5d9e995eec8 | ✓ anchor_5d9e995eec8 (s=1.00 c=1.00 lexical) | ✓ anchor_5d9e995eec8 (s=1.00 c=1.00 lexical) | ✓ anchor_5d9e995eec8 (s=1.00 c=1.00 lexical) | ✓ anchor_5d9e995eec8 (s=1.00 c=1.00 lexical) | ✓ anchor_5d9e995eec8 (s=1.00 c=1.00 lexical) | ✓ anchor_5d9e995eec8 (s=0.75 c=0.74 cross-encoder) | ✗ — (s=0.03 c=0.01 nli) |
| hvissinge | Glostrup Kommune | anchor_b9626568d28 | ✗ — (s=0.00 c=0.00 lexical) | ✗ — (s=0.00 c=0.00 cross-encoder) | ✗ — (s=0.28 c=0.13 nli) | ✗ — (s=0.02 c=0.02 cross-encoder) | ✗ — (s=0.29 c=0.02 nli) | ✗ — (s=0.00 c=0.00 cross-encoder) | ✗ — (s=0.28 c=0.13 nli) |
| hvissinge | TV Lorry | anchor_23b8da0efab | ✓ anchor_23b8da0efab (s=1.00 c=1.00 lexical) | ✓ anchor_23b8da0efab (s=1.00 c=1.00 lexical) | ✓ anchor_23b8da0efab (s=1.00 c=1.00 lexical) | ✓ anchor_23b8da0efab (s=1.00 c=1.00 lexical) | ✓ anchor_23b8da0efab (s=1.00 c=1.00 lexical) | ✗ — (s=0.11 c=0.11 cross-encoder) | ✓ anchor_23b8da0efab (s=1.00 c=0.59 nli) |
| hvissinge | Morten Knudsen | anchor_773b5fe2c12+1 | ✗ — (s=0.00 c=0.00 lexical) | ✗ — (s=0.33 c=0.32 cross-encoder) | ✗ — (s=0.44 c=0.19 nli) | ✓ anchor_773b5fe2c12 (s=0.61 c=0.16 cross-encoder) | ✗ — (s=0.28 c=0.03 nli) | ✗ — (s=0.33 c=0.32 cross-encoder) | ✗ — (s=0.44 c=0.19 nli) |
| hvissinge | år 1-400 | anchor_367c8a273ff | ✓ anchor_367c8a273ff (s=1.00 c=1.00 lexical) | ✓ anchor_367c8a273ff (s=1.00 c=1.00 lexical) | ✓ anchor_367c8a273ff (s=1.00 c=1.00 lexical) | ✓ anchor_367c8a273ff (s=1.00 c=1.00 lexical) | ✓ anchor_367c8a273ff (s=1.00 c=1.00 lexical) | ✓ anchor_367c8a273ff (s=0.95 c=0.84 cross-encoder) | ✓ anchor_367c8a273ff (s=0.78 c=0.71 nli) |
| hvissinge | 29 | anchor_d30fc0e8717+1 | ✗ — (s=0.00 c=0.00 lexical) | ✗ — (s=0.04 c=0.04 cross-encoder) | ✓ anchor_68434d38cc2 (s=1.00 c=0.55 nli) | ✗ — (s=0.03 c=0.02 cross-encoder) | ✗ — (s=0.36 c=0.04 nli) | ✗ — (s=0.04 c=0.04 cross-encoder) | ✓ anchor_68434d38cc2 (s=1.00 c=0.55 nli) |
| hvissinge | TAK 1729 | — | ✓ — (s=0.00 c=0.00 lexical) | ✓ — (s=0.00 c=0.00 cross-encoder) | ✓ — (s=0.39 c=0.03 nli) | ✓ — (s=0.02 c=0.02 cross-encoder) | ✓ — (s=0.29 c=0.09 nli) | ✓ — (s=0.00 c=0.00 cross-encoder) | ✓ — (s=0.39 c=0.03 nli) |
| hvissinge | grav 12 | — | ✓ — (s=0.00 c=0.00 lexical) | ✓ — (s=0.14 c=0.11 cross-encoder) | ✓ — (s=0.09 c=0.05 nli) | ✓ — (s=0.03 c=0.02 cross-encoder) | ✓ — (s=0.22 c=0.04 nli) | ✓ — (s=0.14 c=0.11 cross-encoder) | ✓ — (s=0.09 c=0.05 nli) |
| hvissinge | Bo Jansen | — | ✓ — (s=0.00 c=0.00 lexical) | ✓ — (s=0.01 c=0.01 cross-encoder) | ✗ anchor_e6a27f42262 (s=0.98 c=0.25 nli*) | ✓ — (s=0.01 c=0.01 cross-encoder) | ✓ — (s=0.30 c=0.01 nli) | ✓ — (s=0.01 c=0.01 cross-encoder) | ✗ anchor_e6a27f42262 (s=0.98 c=0.25 nli*) |
| hvissinge | 05-09-2016 | — | ✓ — (s=0.00 c=0.00 lexical) | ✓ — (s=0.07 c=0.03 cross-encoder) | ✗ anchor_b9626568d28 (s=0.69 c=0.25 nli*) | ✓ — (s=0.02 c=0.02 cross-encoder) | ✓ — (s=0.34 c=0.01 nli) | ✓ — (s=0.07 c=0.03 cross-encoder) | ✗ anchor_b9626568d28 (s=0.69 c=0.25 nli*) |
| hvissinge | Roskilde Kommune | — | ✓ — (s=0.00 c=0.00 lexical) | ✓ — (s=0.00 c=0.00 cross-encoder) | ✓ — (s=0.26 c=0.02 nli) | ✓ — (s=0.01 c=0.01 cross-encoder) | ✓ — (s=0.31 c=0.05 nli) | ✓ — (s=0.00 c=0.00 cross-encoder) | ✓ — (s=0.26 c=0.02 nli) |
| katrinesminde | SBM1116 | anchor_936759daa7a | ✓ anchor_936759daa7a (s=1.00 c=1.00 lexical) | ✓ anchor_936759daa7a (s=1.00 c=1.00 lexical) | ✓ anchor_936759daa7a (s=1.00 c=1.00 lexical) | ✓ anchor_936759daa7a (s=1.00 c=1.00 lexical) | ✓ anchor_936759daa7a (s=1.00 c=1.00 lexical) | ✗ — (s=0.40 c=0.40 cross-encoder) | ✓ anchor_936759daa7a (s=0.88 c=0.37 nli) |
| katrinesminde | Merethe Schifter Christensen | anchor_868bd0498cb+1 | ✗ — (s=0.00 c=0.00 lexical) | ✓ anchor_868bd0498cb (s=0.97 c=0.94 cross-encoder) | ✓ anchor_868bd0498cb (s=1.00 c=0.57 nli) | ✗ — (s=0.00 c=0.00 cross-encoder) | ✗ — (s=0.27 c=0.02 nli) | ✓ anchor_868bd0498cb (s=0.97 c=0.94 cross-encoder) | ✓ anchor_868bd0498cb (s=1.00 c=0.57 nli) |
| katrinesminde | Louise Søndergaard | anchor_868bd0498cb | ✓ anchor_868bd0498cb (s=1.00 c=1.00 lexical) | ✓ anchor_868bd0498cb (s=1.00 c=1.00 lexical) | ✓ anchor_868bd0498cb (s=1.00 c=1.00 lexical) | ✓ anchor_868bd0498cb (s=1.00 c=1.00 lexical) | ✓ anchor_868bd0498cb (s=1.00 c=1.00 lexical) | ✓ anchor_868bd0498cb (s=0.92 c=0.86 cross-encoder) | ✓ anchor_868bd0498cb (s=0.98 c=0.37 nli) |
| katrinesminde | Anja Vegebjerg Jensen | anchor_868bd0498cb | ✓ anchor_868bd0498cb (s=1.00 c=1.00 lexical) | ✓ anchor_868bd0498cb (s=1.00 c=1.00 lexical) | ✓ anchor_868bd0498cb (s=1.00 c=1.00 lexical) | ✓ anchor_868bd0498cb (s=1.00 c=1.00 lexical) | ✓ anchor_868bd0498cb (s=1.00 c=1.00 lexical) | ✓ anchor_868bd0498cb (s=0.96 c=0.95 cross-encoder) | ✓ anchor_868bd0498cb (s=0.98 c=0.41 nli) |
| katrinesminde | René D. Jensen | anchor_4d990a5f52f | ✓ anchor_4d990a5f52f (s=1.00 c=1.00 lexical) | ✓ anchor_4d990a5f52f (s=1.00 c=1.00 lexical) | ✓ anchor_4d990a5f52f (s=1.00 c=1.00 lexical) | ✓ anchor_4d990a5f52f (s=1.00 c=1.00 lexical) | ✓ anchor_4d990a5f52f (s=1.00 c=1.00 lexical) | ✓ anchor_4d990a5f52f (s=0.73 c=0.73 cross-encoder) | ✓ anchor_4d990a5f52f (s=0.97 c=0.70 nli) |
| katrinesminde | 13. oktober 2009 | anchor_868bd0498cb | ✓ anchor_868bd0498cb (s=1.00 c=1.00 lexical) | ✓ anchor_868bd0498cb (s=1.00 c=1.00 lexical) | ✓ anchor_868bd0498cb (s=1.00 c=1.00 lexical) | ✓ anchor_868bd0498cb (s=1.00 c=1.00 lexical) | ✓ anchor_868bd0498cb (s=1.00 c=1.00 lexical) | ✓ anchor_868bd0498cb (s=0.97 c=0.95 cross-encoder) | ✓ anchor_868bd0498cb (s=0.89 c=0.32 nli) |
| katrinesminde | 2529 m2 | anchor_2c90234c21b | ✓ anchor_2c90234c21b (s=1.00 c=1.00 lexical) | ✓ anchor_2c90234c21b (s=1.00 c=1.00 lexical) | ✓ anchor_2c90234c21b (s=1.00 c=1.00 lexical) | ✓ anchor_2c90234c21b (s=1.00 c=1.00 lexical) | ✓ anchor_2c90234c21b (s=1.00 c=1.00 lexical) | ✓ anchor_2c90234c21b (s=0.96 c=0.96 cross-encoder) | ✓ anchor_2c90234c21b (s=0.99 c=0.51 nli) |
| katrinesminde | 116 | anchor_5560879bdef | ✓ anchor_5560879bdef (s=1.00 c=1.00 lexical) | ✓ anchor_5560879bdef (s=1.00 c=1.00 lexical) | ✓ anchor_5560879bdef (s=1.00 c=1.00 lexical) | ✓ anchor_5560879bdef (s=1.00 c=1.00 lexical) | ✓ anchor_5560879bdef (s=1.00 c=1.00 lexical) | ✗ — (s=0.18 c=0.18 cross-encoder) | ✓ anchor_5560879bdef (s=0.99 c=0.44 nli) |
| katrinesminde | 88 | anchor_5560879bdef | ✓ anchor_5560879bdef (s=1.00 c=1.00 lexical) | ✓ anchor_5560879bdef (s=1.00 c=1.00 lexical) | ✓ anchor_5560879bdef (s=1.00 c=1.00 lexical) | ✓ anchor_5560879bdef (s=1.00 c=1.00 lexical) | ✓ anchor_5560879bdef (s=1.00 c=1.00 lexical) | ✗ — (s=0.00 c=0.00 cross-encoder) | ✗ — (s=0.22 c=0.07 nli) |
| katrinesminde | 75,5 m | anchor_7bb2600dce8 | ✓ anchor_7bb2600dce8 (s=1.00 c=1.00 lexical) | ✓ anchor_7bb2600dce8 (s=1.00 c=1.00 lexical) | ✓ anchor_7bb2600dce8 (s=1.00 c=1.00 lexical) | ✓ anchor_7bb2600dce8 (s=1.00 c=1.00 lexical) | ✓ anchor_7bb2600dce8 (s=1.00 c=1.00 lexical) | ✓ anchor_7bb2600dce8 (s=0.97 c=0.96 cross-encoder) | ✓ anchor_7bb2600dce8 (s=0.93 c=0.58 nli) |
| katrinesminde | X44 | anchor_ae8ba8e09da+1 | ✗ — (s=0.00 c=0.00 lexical) | ✗ — (s=0.27 c=0.14 cross-encoder) | ✓ anchor_ae8ba8e09da (s=0.97 c=0.01 nli) | ✓ anchor_ae8ba8e09da (s=0.73 c=0.70 cross-encoder) | ✓ anchor_ae8ba8e09da (s=0.88 c=0.68 nli) | ✗ — (s=0.27 c=0.14 cross-encoder) | ✓ anchor_ae8ba8e09da (s=0.97 c=0.01 nli) |
| katrinesminde | 47 | anchor_61604d00261 | ✓ anchor_61604d00261 (s=1.00 c=1.00 lexical) | ✓ anchor_61604d00261 (s=1.00 c=1.00 lexical) | ✓ anchor_61604d00261 (s=1.00 c=1.00 lexical) | ✓ anchor_61604d00261 (s=1.00 c=1.00 lexical) | ✓ anchor_61604d00261 (s=1.00 c=1.00 lexical) | ✗ — (s=0.01 c=0.01 cross-encoder) | ✓ anchor_61604d00261 (s=0.82 c=0.41 nli) |
| katrinesminde | ca. 83 kg | anchor_6b6d1414f14 | ✓ anchor_6b6d1414f14 (s=1.00 c=1.00 lexical) | ✓ anchor_6b6d1414f14 (s=1.00 c=1.00 lexical) | ✓ anchor_6b6d1414f14 (s=1.00 c=1.00 lexical) | ✓ anchor_6b6d1414f14 (s=1.00 c=1.00 lexical) | ✓ anchor_6b6d1414f14 (s=1.00 c=1.00 lexical) | ✓ anchor_6b6d1414f14 (s=0.86 c=0.86 cross-encoder) | ✗ — (s=0.36 c=0.12 nli) |
| katrinesminde | X118 | anchor_ad6c01b6a27 | ✓ anchor_ad6c01b6a27 (s=1.00 c=1.00 lexical) | ✓ anchor_ad6c01b6a27 (s=1.00 c=1.00 lexical) | ✓ anchor_ad6c01b6a27 (s=1.00 c=1.00 lexical) | ✓ anchor_ad6c01b6a27 (s=1.00 c=1.00 lexical) | ✓ anchor_ad6c01b6a27 (s=1.00 c=1.00 lexical) | ✗ — (s=0.00 c=0.00 cross-encoder) | ✗ — (s=0.26 c=0.15 nli) |
| katrinesminde | Peter Jensen | anchor_e4405369f2b | ✓ anchor_e4405369f2b (s=1.00 c=1.00 lexical) | ✓ anchor_e4405369f2b (s=1.00 c=1.00 lexical) | ✓ anchor_e4405369f2b (s=1.00 c=1.00 lexical) | ✓ anchor_e4405369f2b (s=1.00 c=1.00 lexical) | ✓ anchor_e4405369f2b (s=1.00 c=1.00 lexical) | ✓ anchor_e4405369f2b (s=0.84 c=0.84 cross-encoder) | ✓ anchor_e4405369f2b (s=0.99 c=0.48 nli) |
| katrinesminde | 26-11-2009 | anchor_e9d01929435 | ✓ anchor_e9d01929435 (s=1.00 c=1.00 lexical) | ✓ anchor_e9d01929435 (s=1.00 c=1.00 lexical) | ✓ anchor_e9d01929435 (s=1.00 c=1.00 lexical) | ✓ anchor_e9d01929435 (s=1.00 c=1.00 lexical) | ✓ anchor_e9d01929435 (s=1.00 c=1.00 lexical) | ✗ — (s=0.06 c=0.04 cross-encoder) | ✗ — (s=0.49 c=0.03 nli) |
| katrinesminde | Adelgade 5 | anchor_f6cfd3b8c2c | ✓ anchor_f6cfd3b8c2c (s=1.00 c=1.00 lexical) | ✓ anchor_f6cfd3b8c2c (s=1.00 c=1.00 lexical) | ✓ anchor_f6cfd3b8c2c (s=1.00 c=1.00 lexical) | ✓ anchor_f6cfd3b8c2c (s=1.00 c=1.00 lexical) | ✓ anchor_f6cfd3b8c2c (s=1.00 c=1.00 lexical) | ✓ anchor_f6cfd3b8c2c (s=0.99 c=0.99 cross-encoder) | ✓ anchor_f6cfd3b8c2c (s=1.00 c=0.77 nli) |
| katrinesminde | 7,73 % | anchor_797362f97eb | ✓ anchor_797362f97eb (s=1.00 c=1.00 lexical) | ✓ anchor_797362f97eb (s=1.00 c=1.00 lexical) | ✓ anchor_797362f97eb (s=1.00 c=1.00 lexical) | ✓ anchor_797362f97eb (s=1.00 c=1.00 lexical) | ✓ anchor_797362f97eb (s=1.00 c=1.00 lexical) | ✗ — (s=0.42 c=0.42 cross-encoder) | ✓ anchor_797362f97eb (s=0.98 c=0.56 nli) |
| katrinesminde | SBM1117 | — | ✓ — (s=0.00 c=0.00 lexical) | ✓ — (s=0.02 c=0.01 cross-encoder) | ✗ anchor_e9d01929435 (s=0.52 c=0.08 nli*) | ✓ — (s=0.36 c=0.33 cross-encoder) | ✓ — (s=0.47 c=0.17 nli) | ✓ — (s=0.02 c=0.01 cross-encoder) | ✗ anchor_e9d01929435 (s=0.52 c=0.08 nli*) |
| katrinesminde | X119 | — | ✓ — (s=0.00 c=0.00 lexical) | ✓ — (s=0.00 c=0.00 cross-encoder) | ✓ — (s=0.19 c=0.09 nli) | ✓ — (s=0.03 c=0.02 cross-encoder) | ✓ — (s=0.23 c=0.13 nli) | ✓ — (s=0.00 c=0.00 cross-encoder) | ✓ — (s=0.19 c=0.09 nli) |
| katrinesminde | Merethe Schifter Bagge | — | ✓ — (s=0.00 c=0.00 lexical) | ✓ — (s=0.02 c=0.01 cross-encoder) | ✓ — (s=0.43 c=0.03 nli) | ✓ — (s=0.00 c=0.00 cross-encoder) | ✓ — (s=0.39 c=0.04 nli) | ✓ — (s=0.02 c=0.01 cross-encoder) | ✓ — (s=0.43 c=0.03 nli) |
| katrinesminde | 14. oktober 2009 | — | ✓ — (s=0.00 c=0.00 lexical) | ✓ — (s=0.49 c=0.48 cross-encoder) | ✗ anchor_4d990a5f52f (s=0.52 c=0.25 nli*) | ✓ — (s=0.01 c=0.00 cross-encoder) | ✓ — (s=0.34 c=0.03 nli) | ✓ — (s=0.49 c=0.48 cross-encoder) | ✗ anchor_4d990a5f52f (s=0.52 c=0.25 nli*) |
| katrinesminde | Nationalmuseet | — | ✓ — (s=0.00 c=0.00 lexical) | ✓ — (s=0.00 c=0.00 cross-encoder) | ✓ — (s=0.23 c=0.09 nli) | ✓ — (s=0.01 c=0.01 cross-encoder) | ✓ — (s=0.23 c=0.02 nli) | ✓ — (s=0.00 c=0.00 cross-encoder) | ✓ — (s=0.23 c=0.09 nli) |

> **Historical evidence only (2026-09-01):** every LLM section below predates
> the `_smoke`-fixture exclusion (totals count 182 claims / 133 linkable) and
> strict production-parity response validation. Do not compare these rows with
> the current 177-claim pipeline result or use them for a production decision.
> Rerun `llm_baseline` / `llm_codex` to refresh any model retained as current.

## LLM baseline (qwen3.8:latest, 38 per-record calls)

| model | accuracy@1 | correct abstain | wrong link | protocol failures | avg ms/claim |
|---|---|---|---|---|---|
| qwen3.8:latest | 129/133 | 44/49 | 9 | 0 | 1466 |

### Per-claim audit

| doc | claim | LLM pick |
|---|---|---|
| 1790-06-17-1 | Jean | ✓ anchor_ebb61fca35b |
| 1790-06-17-1 | New Orleans | ✓ — |
| 1790-06-17-1 | Marcel | ✓ anchor_ebb61fca35b |
| 1790-06-17-1 | environ 25 ans | ✓ anchor_49c796ee55f |
| 1790-06-17-1 | Lallemand | ✓ anchor_49c796ee55f |
| _smoke | 1234.56 | ✓ smoke-a4 |
| _smoke | 42 | ✓ smoke-a1 |
| _smoke | Copenhagen | ✓ — |
| _smoke | 1790-06-17 | ✓ smoke-a2 |
| _smoke | P. Madsen | ✓ smoke-a5 |
| age-related-disease | Age-related disease or disease-relate… | ✓ anchor_de57395d0c4 |
| age-related-disease | Katharina Fuchs | ✓ anchor_233d1ab87aa |
| age-related-disease | Jo Appleby | ✓ anchor_233d1ab87aa |
| age-related-disease | 10.1016/j.ijpp.2026.02.003 | ✓ anchor_6adfba012ee |
| age-related-disease | k.fuchs@ufg.uni-kiel.de | ✓ anchor_fdffe173700 |
| age-related-disease | University of Leicester | ✓ anchor_028b35c6855 |
| age-related-disease | Kiel University | ✓ anchor_1eeb7fa3207 |
| age-related-disease | Vanderbilt University Medical Center | ✓ anchor_f51c592e3bd |
| age-related-disease | Mississippi State University | ✓ anchor_78e15c3560d |
| age-related-disease | 60 % | ✓ anchor_4ab699d3e12 |
| age-related-disease | TA3 | ✓ anchor_4ab699d3e12 |
| age-related-disease | Kathryn E. Marklein | ✓ anchor_233d1ab87aa |
| age-related-disease | progeria | ✓ anchor_f0fb6b5010c |
| age-related-disease | International Journal of Paleopathology | ✓ anchor_dcaf435b4d3 |
| age-related-disease | Im Dol 2-6 | ✓ anchor_773ccee8569 |
| age-related-disease | 10.1016/j.ijpp.2026.02.004 | ✓ — |
| age-related-disease | Katherine Fuchs | ✓ — |
| age-related-disease | TA4 | ✗ anchor_efadde47e89 |
| age-related-disease | University of Oxford | ✓ — |
| age-related-disease | Aarhus University | ✓ — |
| brondbylund | TAK 1506 | ✓ anchor_4be8009e760 |
| brondbylund | Maria Lisette Jacobsen | ✓ anchor_772d564bd37 |
| brondbylund | ca. 1 år | ✓ anchor_3e88c36c6ac |
| brondbylund | 900 e. Kr. | ✓ anchor_e32d087632c |
| brondbylund | 18 | ✓ anchor_735960dfc73 |
| brondbylund | Lars Nissen | ✓ anchor_edc60e8a2e9 |
| brondbylund | Lind & Risør | ✓ anchor_5cd63a98820 |
| brondbylund | FHM 4296/2382 | ✓ anchor_76a638133bd |
| brondbylund | Brøndbyøster sogn | ✓ anchor_1449a8a3f1c |
| brondbylund | 5000 m2 | ✓ — |
| brondbylund | TAK 1507 | ✓ — |
| brondbylund | ca. 2 år | ✓ — |
| brondbylund | 19 | ✓ — |
| brondbylund | 542 g | ✓ anchor_b0152f15cb9 |
| brondbylund | 1200 f.Kr. | ✓ — |
| brondbylund | 543 g | ✓ — |
| brondbylund | 150 | ✓ — |
| catfish-collagen | Properties of Skin Collagen from Sout… | ✓ anchor_4b6b6143a77 |
| catfish-collagen | zhangxi@mail.hzau.edu.cn | ✓ anchor_cd670a8ada5 |
| catfish-collagen | +86-18672306015 | ✓ anchor_cd670a8ada5 |
| catfish-collagen | Carlos José Dias Pereira | ✓ anchor_281439a9f96 |
| catfish-collagen | 1 August 2024 | ✓ anchor_f781e0cbbe1 |
| catfish-collagen | 13 September 2024 | ✓ anchor_2c556afc880 |
| catfish-collagen | Hokkaido University | ✓ anchor_156d421e102 |
| catfish-collagen | takagi@fish.hokudai.ac.jp | ✓ anchor_156d421e102 |
| catfish-collagen | 6 weeks | ✓ anchor_7d5aa15172d |
| catfish-collagen | 27.09 ± 0.89 g | ✓ anchor_a986c2a37ab |
| catfish-collagen | 8.66 ± 0.11% | ✓ anchor_8aa33654155 |
| catfish-collagen | 61.78 ± 3.91% | ✓ anchor_8aa33654155 |
| catfish-collagen | SPSS Base 25 | ✓ anchor_58009cbd2db |
| catfish-collagen | GACGCTGTATGTGAAACGGC | ✓ anchor_8d86be60f2f |
| catfish-collagen | TATCTCCCCTTGGTCCCGAT | ✓ anchor_4faa09e9a48 |
| catfish-collagen | Nicolet IS50 | ✓ anchor_32cca9ee8ba |
| catfish-collagen | 12,000 × g | ✓ anchor_161b1292bbd |
| catfish-collagen | zhangxi@mail.hzau.edu.com | ✓ — |
| catfish-collagen | 8.66 ± 0.12% | ✓ — |
| catfish-collagen | col1a3-F | ✓ — |
| catfish-collagen | Kyoto University | ✓ — |
| catfish-collagen | 15 September 2024 | ✓ — |
| ellekilde | Grav 8 | ✓ anchor_540e94d0e16 |
| ellekilde | over 45 år | ✓ anchor_3b23e3358bf |
| ellekilde | jernspænde | ✓ anchor_3b23e3358bf |
| ellekilde | 1450 BP | ✓ — |
| ellekilde | 8-5 | ✓ — |
| ellekilde | 25-35 år | ✓ anchor_faa3abc3e1c |
| ellekilde | Yngre romersk jernalder per. C3 | ✓ anchor_64a5a183460 |
| ellekilde | Perle af mat rødligt glas | ✗ anchor_3f25b580fb3 |
| ellekilde | Lå mellem de to underarmsknogler (24-18) | ✗ anchor_a50f61fd724 |
| ellekilde | Yngre romersk jernalder per. C2 | ✓ — |
| ellekilde | 16-18 år | ✓ anchor_0f6b71abf27 |
| ellekilde | 15 | ✓ anchor_61cb7f12f88 |
| ellekilde | 2.8 x 1.3 meter | ✓ anchor_72d2d735426 |
| ellekilde | 17-18 år | ✓ — |
| ellekilde | Nationalmuseet i København | ✓ — |
| free-ports-hamburg | Free ports, political economy, and ea… | ✓ anchor_715a690ae19 |
| free-ports-hamburg | Esther Sahle | ✓ anchor_88f4fa65a5b |
| free-ports-hamburg | University of Copenhagen, Saxo Institute | ✓ anchor_f526f6d7993 |
| free-ports-hamburg | Cambridge University Press | ✓ anchor_bf89e84c6f5 |
| free-ports-hamburg | University of Oxford | ✓ — |
| free-ports-hamburg | Esther Sahler | ✓ — |
| free-ports-hamburg | 1591 | ✗ anchor_b771fc1a940 |
| free-ports-hamburg | Livorno | ✓ anchor_b771fc1a940 |
| free-ports-hamburg | 1592 | ✓ — |
| free-ports-hamburg | 159 | ✓ — |
| free-ports-hamburg | 1664 | ✓ anchor_e6b6e28c620 |
| free-ports-hamburg | 1706 | ✓ anchor_1215213c04a |
| free-ports-hamburg | 1766 | ✗ anchor_0bbd16ebafa |
| herredsvejen | SBM1694 | ✓ anchor_fb53d73b0be |
| herredsvejen | Merethe Schifter Bagge | ✓ anchor_30e2ff5d0f8 |
| herredsvejen | 23-09-2019 | ✓ anchor_122c7838e35 |
| herredsvejen | 20. november 2019 | ✓ anchor_c20ee246bb9 |
| herredsvejen | 19/06370 | ✓ anchor_122c7838e35 |
| herredsvejen | 576 | ✓ anchor_7227d563157 |
| herredsvejen | 362 | ✓ anchor_7227d563157 |
| herredsvejen | Poul Kragh | ✓ anchor_c0395884a7d |
| herredsvejen | Skanderborg Kommune, Teknik og Miljø | ✓ anchor_97f36f8b78f |
| herredsvejen | Lars Lykke Jensen | ✓ anchor_97f36f8b78f |
| herredsvejen | ca. 23 m | ✓ anchor_e1d16a1197c |
| herredsvejen | 41 fragmenter | ✓ anchor_8b631316cef |
| herredsvejen | 5.853 m2 | ✓ anchor_5a1c177ea58 |
| herredsvejen | 1300 m2 | ✓ anchor_9f47ea13623 |
| herredsvejen | SBM1695 | ✓ — |
| herredsvejen | Merete Schifter Bagge | ✗ anchor_941fb6c38aa |
| herredsvejen | Nationalmuseet | ✓ — |
| herredsvejen | 13,5 m | ✓ anchor_68f25e6d447 |
| herredsvejen | K14 | ✗ anchor_af485397ff0 |
| herredsvejen | X233 | ✓ anchor_5d3db8876b9 |
| herredsvejen | 6 x 4 mm | ✓ anchor_5d3db8876b9 |
| herredsvejen | AAR 33273 | ✓ anchor_63fdd9a6f47 |
| herredsvejen | AAR 33274 | ✓ — |
| hojbakkegaard | TAK 1177 | ✓ anchor_d850df38f5a |
| hojbakkegaard | 020214-65, -66 | ✓ anchor_83f13172419 |
| hojbakkegaard | Tom Giersing | ✓ anchor_51b6ddcfa56 |
| hojbakkegaard | Mette Brosolat Ohlsen | ✓ anchor_133c36120cd |
| hojbakkegaard | Lone Brorson | ✓ anchor_1b0366f3c39 |
| hojbakkegaard | Jan Poulsen | ✓ anchor_04f72452ee4 |
| hojbakkegaard | 2004-08-13 | ✓ anchor_143c9746911 |
| hojbakkegaard | 55.6702 N | ✓ — |
| hojbakkegaard | TAK 1178 | ✓ — |
| hojbakkegaard | 020214-67 | ✓ — |
| hojbakkegaard | 17. august 2004 | ✗ anchor_143c9746911 |
| hojbakkegaard | ca. 210-250 e.Kr | ✓ anchor_1df768b7d8f |
| hojbakkegaard | 3950 BP | ✓ — |
| hojbakkegaard | ca. 400 e.Kr. | ✓ anchor_4cb663f7eac |
| hojbakkegaard | 32 | ✓ anchor_546040a3e1e |
| hojbakkegaard | 33 | ✓ — |
| hojbakkegaard | 2.20 meter | ✓ anchor_e183d0f5fc4 |
| hvissinge | TAK 1728 | ✓ anchor_a4fb0e662bb |
| hvissinge | Bo Jensen | ✓ anchor_e6a27f42262 |
| hvissinge | Linda Boye | ✓ anchor_b658d978bc5 |
| hvissinge | 20-06-2016 | ✓ anchor_b9626568d28 |
| hvissinge | 27-07-2016 | ✓ anchor_b27b10f35d8 |
| hvissinge | 267 | ✓ anchor_39bb0aa22e1 |
| hvissinge | 58 cm | ✓ anchor_942ba80df00 |
| hvissinge | Kurt Herskind | ✓ anchor_b27b10f35d8 |
| hvissinge | Hanus Jensen | ✓ anchor_5d9e995eec8 |
| hvissinge | Glostrup Kommune | ✓ anchor_b9626568d28 |
| hvissinge | TV Lorry | ✓ anchor_23b8da0efab |
| hvissinge | Morten Knudsen | ✓ anchor_773b5fe2c12 |
| hvissinge | år 1-400 | ✓ anchor_367c8a273ff |
| hvissinge | 29 | ✓ anchor_d30fc0e8717 |
| hvissinge | TAK 1729 | ✓ — |
| hvissinge | Bo Jansen | ✓ — |
| hvissinge | 05-09-2016 | ✓ — |
| hvissinge | Roskilde Kommune | ✓ — |
| hvissinge | cirka 173 cm | ✓ anchor_cc1c4dac3dd |
| hvissinge | 135 cm | ✓ anchor_0a1cae114ce |
| hvissinge | 172 cm | ✓ anchor_c1c385a8c88 |
| hvissinge | grav 12 | ✓ — |
| katrinesminde | SBM1116 | ✓ anchor_936759daa7a |
| katrinesminde | Merethe Schifter Christensen | ✓ anchor_f4cec97caf0 |
| katrinesminde | René D. Jensen | ✓ anchor_4d990a5f52f |
| katrinesminde | 13. oktober 2009 | ✓ anchor_868bd0498cb |
| katrinesminde | 2529 m2 | ✓ anchor_2c90234c21b |
| katrinesminde | 116 | ✓ anchor_5560879bdef |
| katrinesminde | 88 | ✓ anchor_5560879bdef |
| katrinesminde | 75,5 m | ✓ anchor_7bb2600dce8 |
| katrinesminde | 47 | ✓ anchor_61604d00261 |
| katrinesminde | ca. 83 kg | ✓ anchor_6b6d1414f14 |
| katrinesminde | Peter Jensen | ✓ anchor_e4405369f2b |
| katrinesminde | 26-11-2009 | ✓ anchor_e9d01929435 |
| katrinesminde | Adelgade 5 | ✓ anchor_f6cfd3b8c2c |
| katrinesminde | 7,73 % | ✓ anchor_797362f97eb |
| katrinesminde | SBM1117 | ✓ — |
| katrinesminde | Merethe Schifter Bagge | ✓ — |
| katrinesminde | 14. oktober 2009 | ✓ — |
| katrinesminde | Nationalmuseet | ✓ — |
| katrinesminde | Louise Søndergaard | ✓ anchor_868bd0498cb |
| katrinesminde | Anja Vegebjerg Jensen | ✓ anchor_868bd0498cb |
| katrinesminde | X44 | ✓ anchor_8e310c1ff1c |
| katrinesminde | X118 | ✓ anchor_ad6c01b6a27 |
| katrinesminde | X119 | ✗ anchor_da6be3d1487 |


## LLM baseline (qwen3:32b, 38 per-record calls)

| model | accuracy@1 | correct abstain | wrong link | protocol failures | avg ms/claim |
|---|---|---|---|---|---|
| qwen3:32b | 100/133 | 3/49 | 79 | 0 | 7252 |

### Per-claim audit

| doc | claim | LLM pick |
|---|---|---|
| 1790-06-17-1 | Jean | ✓ anchor_ebb61fca35b |
| 1790-06-17-1 | New Orleans | ✓ — |
| 1790-06-17-1 | Marcel | ✓ anchor_ebb61fca35b |
| 1790-06-17-1 | environ 25 ans | ✓ anchor_49c796ee55f |
| 1790-06-17-1 | Lallemand | ✓ anchor_49c796ee55f |
| _smoke | 1234.56 | ✓ smoke-a4 |
| _smoke | 42 | ✓ smoke-a1 |
| _smoke | Copenhagen | ✓ — |
| _smoke | 1790-06-17 | ✓ smoke-a2 |
| _smoke | P. Madsen | ✓ smoke-a5 |
| age-related-disease | Age-related disease or disease-relate… | ✓ anchor_de57395d0c4 |
| age-related-disease | Katharina Fuchs | ✓ anchor_233d1ab87aa |
| age-related-disease | Jo Appleby | ✓ anchor_233d1ab87aa |
| age-related-disease | 10.1016/j.ijpp.2026.02.003 | ✓ anchor_6adfba012ee |
| age-related-disease | k.fuchs@ufg.uni-kiel.de | ✓ anchor_fdffe173700 |
| age-related-disease | University of Leicester | ✓ anchor_028b35c6855 |
| age-related-disease | Kiel University | ✓ anchor_1eeb7fa3207 |
| age-related-disease | Vanderbilt University Medical Center | ✓ anchor_f51c592e3bd |
| age-related-disease | Mississippi State University | ✓ anchor_78e15c3560d |
| age-related-disease | 60 % | ✓ anchor_4ab699d3e12 |
| age-related-disease | TA3 | ✗ anchor_1610236b7e2 |
| age-related-disease | Kathryn E. Marklein | ✓ anchor_233d1ab87aa |
| age-related-disease | progeria | ✓ anchor_f0fb6b5010c |
| age-related-disease | International Journal of Paleopathology | ✓ anchor_dcaf435b4d3 |
| age-related-disease | Im Dol 2-6 | ✓ anchor_773ccee8569 |
| age-related-disease | 10.1016/j.ijpp.2026.02.004 | ✗ anchor_78e15c3560d |
| age-related-disease | Katherine Fuchs | ✗ anchor_233d1ab87aa |
| age-related-disease | TA4 | ✗ anchor_1610236b7e2 |
| age-related-disease | University of Oxford | ✗ anchor_161ba7a6e7b |
| age-related-disease | Aarhus University | ✗ anchor_c900f0797a4 |
| brondbylund | TAK 1506 | ✓ anchor_4be8009e760 |
| brondbylund | Maria Lisette Jacobsen | ✓ anchor_772d564bd37 |
| brondbylund | ca. 1 år | ✓ anchor_3e88c36c6ac |
| brondbylund | 900 e. Kr. | ✓ anchor_e32d087632c |
| brondbylund | 18 | ✗ anchor_dbbc4c7a5fd |
| brondbylund | Lars Nissen | ✓ anchor_edc60e8a2e9 |
| brondbylund | Lind & Risør | ✓ anchor_5cd63a98820 |
| brondbylund | FHM 4296/2382 | ✓ anchor_76a638133bd |
| brondbylund | Brøndbyøster sogn | ✓ anchor_1449a8a3f1c |
| brondbylund | 5000 m2 | ✗ anchor_735960dfc73 |
| brondbylund | TAK 1507 | ✗ anchor_ac31fa76a1a |
| brondbylund | ca. 2 år | ✗ anchor_b0a1c645cf4 |
| brondbylund | 19 | ✗ anchor_41d4196ce25 |
| brondbylund | 542 g | ✓ anchor_b0152f15cb9 |
| brondbylund | 1200 f.Kr. | ✗ anchor_dbbc4c7a5fd |
| brondbylund | 543 g | ✗ anchor_b0152f15cb9 |
| brondbylund | 150 | ✗ anchor_74f5629f2e4 |
| catfish-collagen | Properties of Skin Collagen from Sout… | ✓ anchor_4b6b6143a77 |
| catfish-collagen | zhangxi@mail.hzau.edu.cn | ✓ anchor_cd670a8ada5 |
| catfish-collagen | +86-18672306015 | ✓ anchor_cd670a8ada5 |
| catfish-collagen | Carlos José Dias Pereira | ✓ anchor_281439a9f96 |
| catfish-collagen | 1 August 2024 | ✓ anchor_f781e0cbbe1 |
| catfish-collagen | 13 September 2024 | ✓ anchor_2c556afc880 |
| catfish-collagen | Hokkaido University | ✓ anchor_156d421e102 |
| catfish-collagen | takagi@fish.hokudai.ac.jp | ✓ anchor_156d421e102 |
| catfish-collagen | 6 weeks | ✓ anchor_7d5aa15172d |
| catfish-collagen | 27.09 ± 0.89 g | ✓ anchor_a986c2a37ab |
| catfish-collagen | 8.66 ± 0.11% | ✗ anchor_0c5fb3a6440 |
| catfish-collagen | 61.78 ± 3.91% | ✗ anchor_0bc6609454d |
| catfish-collagen | SPSS Base 25 | ✗ anchor_0d34ed10397 |
| catfish-collagen | GACGCTGTATGTGAAACGGC | ✓ anchor_8d86be60f2f |
| catfish-collagen | TATCTCCCCTTGGTCCCGAT | ✓ anchor_4faa09e9a48 |
| catfish-collagen | Nicolet IS50 | ✓ anchor_32cca9ee8ba |
| catfish-collagen | 12,000 × g | ✓ anchor_161b1292bbd |
| catfish-collagen | zhangxi@mail.hzau.edu.com | ✗ anchor_cd670a8ada5 |
| catfish-collagen | 8.66 ± 0.12% | ✗ anchor_b73a9b0ba0d |
| catfish-collagen | col1a3-F | ✗ anchor_2cbffc2c6ba |
| catfish-collagen | Kyoto University | ✗ anchor_156d421e102 |
| catfish-collagen | 15 September 2024 | ✗ anchor_2c556afc880 |
| ellekilde | Grav 8 | ✓ anchor_540e94d0e16 |
| ellekilde | over 45 år | ✓ anchor_3b23e3358bf |
| ellekilde | jernspænde | ✗ anchor_e3488d84d89 |
| ellekilde | 1450 BP | ✗ anchor_527871ac406 |
| ellekilde | 8-5 | ✗ anchor_23a14c6aff2 |
| ellekilde | 25-35 år | ✓ anchor_faa3abc3e1c |
| ellekilde | Yngre romersk jernalder per. C3 | ✗ anchor_527871ac406 |
| ellekilde | Perle af mat rødligt glas | ✗ anchor_93ea748833a |
| ellekilde | Lå mellem de to underarmsknogler (24-18) | ✓ anchor_d6a0d525a81 |
| ellekilde | Yngre romersk jernalder per. C2 | ✗ anchor_64a5a183460 |
| ellekilde | 16-18 år | ✓ anchor_0f6b71abf27 |
| ellekilde | 15 | ✗ anchor_faa3abc3e1c |
| ellekilde | 2.8 x 1.3 meter | ✓ anchor_72d2d735426 |
| ellekilde | 17-18 år | ✗ anchor_0f6b71abf27 |
| ellekilde | Nationalmuseet i København | ✓ — |
| free-ports-hamburg | Free ports, political economy, and ea… | ✓ anchor_715a690ae19 |
| free-ports-hamburg | Esther Sahle | ✓ anchor_88f4fa65a5b |
| free-ports-hamburg | University of Copenhagen, Saxo Institute | ✓ anchor_f526f6d7993 |
| free-ports-hamburg | Cambridge University Press | ✓ anchor_bf89e84c6f5 |
| free-ports-hamburg | University of Oxford | ✗ anchor_0818d48dc5c |
| free-ports-hamburg | Esther Sahler | ✗ anchor_0818d48dc5c |
| free-ports-hamburg | 1591 | ✗ anchor_34403ee97ca |
| free-ports-hamburg | Livorno | ✗ anchor_34403ee97ca |
| free-ports-hamburg | 1592 | ✗ anchor_f7839146cb5 |
| free-ports-hamburg | 159 | ✗ anchor_34403ee97ca |
| free-ports-hamburg | 1664 | ✓ anchor_e6b6e28c620 |
| free-ports-hamburg | 1706 | ✓ anchor_1215213c04a |
| free-ports-hamburg | 1766 | ✓ anchor_1ec2abd17b7 |
| herredsvejen | SBM1694 | ✓ anchor_fb53d73b0be |
| herredsvejen | Merethe Schifter Bagge | ✓ anchor_30e2ff5d0f8 |
| herredsvejen | 23-09-2019 | ✓ anchor_122c7838e35 |
| herredsvejen | 20. november 2019 | ✗ anchor_0d133d6816a |
| herredsvejen | 19/06370 | ✓ anchor_122c7838e35 |
| herredsvejen | 576 | ✓ anchor_7227d563157 |
| herredsvejen | 362 | ✓ anchor_7227d563157 |
| herredsvejen | Poul Kragh | ✗ anchor_d33917c2342 |
| herredsvejen | Skanderborg Kommune, Teknik og Miljø | ✓ anchor_97f36f8b78f |
| herredsvejen | Lars Lykke Jensen | ✓ anchor_97f36f8b78f |
| herredsvejen | ca. 23 m | ✓ anchor_e1d16a1197c |
| herredsvejen | 41 fragmenter | ✗ anchor_840a8fb5eb4 |
| herredsvejen | 5.853 m2 | ✗ anchor_f1170ea194e |
| herredsvejen | 1300 m2 | ✗ anchor_1a587462ce9 |
| herredsvejen | SBM1695 | ✗ anchor_d8028f7a3c5 |
| herredsvejen | Merete Schifter Bagge | ✗ anchor_941fb6c38aa |
| herredsvejen | Nationalmuseet | ✗ anchor_686dbea5cee |
| herredsvejen | 13,5 m | ✓ anchor_68f25e6d447 |
| herredsvejen | K14 | ✗ anchor_af485397ff0 |
| herredsvejen | X233 | ✓ anchor_5d3db8876b9 |
| herredsvejen | 6 x 4 mm | ✓ anchor_5d3db8876b9 |
| herredsvejen | AAR 33273 | ✗ anchor_d94ff41dbe2 |
| herredsvejen | AAR 33274 | ✗ anchor_d94ff41dbe2 |
| hojbakkegaard | TAK 1177 | ✓ anchor_d850df38f5a |
| hojbakkegaard | 020214-65, -66 | ✓ anchor_83f13172419 |
| hojbakkegaard | Tom Giersing | ✓ anchor_51b6ddcfa56 |
| hojbakkegaard | Mette Brosolat Ohlsen | ✓ anchor_133c36120cd |
| hojbakkegaard | Lone Brorson | ✗ anchor_04f72452ee4 |
| hojbakkegaard | Jan Poulsen | ✓ anchor_04f72452ee4 |
| hojbakkegaard | 2004-08-13 | ✓ anchor_143c9746911 |
| hojbakkegaard | 55.6702 N | ✗ anchor_698792a8e7d |
| hojbakkegaard | TAK 1178 | ✗ anchor_56537ba0ba1 |
| hojbakkegaard | 020214-67 | ✗ anchor_83f13172419 |
| hojbakkegaard | 17. august 2004 | ✗ anchor_143c9746911 |
| hojbakkegaard | ca. 210-250 e.Kr | ✗ anchor_c7d98a4fce8 |
| hojbakkegaard | 3950 BP | ✗ anchor_306587fc903 |
| hojbakkegaard | ca. 400 e.Kr. | ✗ anchor_b57c6e94243 |
| hojbakkegaard | 32 | ✓ anchor_546040a3e1e |
| hojbakkegaard | 33 | ✗ anchor_bb78e1bac61 |
| hojbakkegaard | 2.20 meter | ✗ anchor_17e3d58bd9e |
| hvissinge | TAK 1728 | ✓ anchor_a4fb0e662bb |
| hvissinge | Bo Jensen | ✓ anchor_e6a27f42262 |
| hvissinge | Linda Boye | ✓ anchor_b658d978bc5 |
| hvissinge | 20-06-2016 | ✓ anchor_b9626568d28 |
| hvissinge | 27-07-2016 | ✗ anchor_39bb0aa22e1 |
| hvissinge | 267 | ✗ anchor_a754fdbfa11 |
| hvissinge | 58 cm | ✗ anchor_bd24323c008 |
| hvissinge | Kurt Herskind | ✗ anchor_6ef04ceeb95 |
| hvissinge | Hanus Jensen | ✗ anchor_db563096424 |
| hvissinge | Glostrup Kommune | ✓ anchor_b9626568d28 |
| hvissinge | TV Lorry | ✓ anchor_23b8da0efab |
| hvissinge | Morten Knudsen | ✓ anchor_773b5fe2c12 |
| hvissinge | år 1-400 | ✓ anchor_367c8a273ff |
| hvissinge | 29 | ✗ anchor_a754fdbfa11 |
| hvissinge | TAK 1729 | ✗ anchor_23cdfff3a21 |
| hvissinge | Bo Jansen | ✗ anchor_128ce55fd50 |
| hvissinge | 05-09-2016 | ✗ anchor_39bb0aa22e1 |
| hvissinge | Roskilde Kommune | ✗ anchor_b9626568d28 |
| hvissinge | cirka 173 cm | ✗ anchor_db563096424 |
| hvissinge | 135 cm | ✓ anchor_0a1cae114ce |
| hvissinge | 172 cm | ✗ anchor_77c5a0f1e3e |
| hvissinge | grav 12 | ✗ anchor_39b0dd18535 |
| katrinesminde | SBM1116 | ✓ anchor_936759daa7a |
| katrinesminde | Merethe Schifter Christensen | ✓ anchor_f4cec97caf0 |
| katrinesminde | René D. Jensen | ✓ anchor_4d990a5f52f |
| katrinesminde | 13. oktober 2009 | ✓ anchor_868bd0498cb |
| katrinesminde | 2529 m2 | ✗ anchor_5560879bdef |
| katrinesminde | 116 | ✓ anchor_5560879bdef |
| katrinesminde | 88 | ✓ anchor_5560879bdef |
| katrinesminde | 75,5 m | ✓ anchor_7bb2600dce8 |
| katrinesminde | 47 | ✗ anchor_5560879bdef |
| katrinesminde | ca. 83 kg | ✓ anchor_6b6d1414f14 |
| katrinesminde | Peter Jensen | ✓ anchor_e4405369f2b |
| katrinesminde | 26-11-2009 | ✓ anchor_e9d01929435 |
| katrinesminde | Adelgade 5 | ✓ anchor_f6cfd3b8c2c |
| katrinesminde | 7,73 % | ✓ anchor_797362f97eb |
| katrinesminde | SBM1117 | ✗ anchor_936759daa7a |
| katrinesminde | Merethe Schifter Bagge | ✗ anchor_f4cec97caf0 |
| katrinesminde | 14. oktober 2009 | ✗ anchor_4d990a5f52f |
| katrinesminde | Nationalmuseet | ✗ anchor_f6cfd3b8c2c |
| katrinesminde | Louise Søndergaard | ✓ anchor_868bd0498cb |
| katrinesminde | Anja Vegebjerg Jensen | ✓ anchor_868bd0498cb |
| katrinesminde | X44 | ✗ anchor_ccffc03404f |
| katrinesminde | X118 | ✗ anchor_6b6d1414f14 |
| katrinesminde | X119 | ✗ anchor_8c038f6038b |


## LLM baseline (qwen3.8:27b, 38 per-record calls)

| model | accuracy@1 | correct abstain | wrong link | protocol failures | avg ms/claim |
|---|---|---|---|---|---|
| qwen3.8:27b | 130/133 | 48/49 | 4 | 0 | 8594 |

### Per-claim audit

| doc | claim | LLM pick |
|---|---|---|
| 1790-06-17-1 | Jean | ✓ anchor_ebb61fca35b |
| 1790-06-17-1 | New Orleans | ✓ — |
| 1790-06-17-1 | Marcel | ✓ anchor_ebb61fca35b |
| 1790-06-17-1 | environ 25 ans | ✓ anchor_49c796ee55f |
| 1790-06-17-1 | Lallemand | ✓ anchor_49c796ee55f |
| _smoke | 1234.56 | ✓ smoke-a4 |
| _smoke | 42 | ✓ smoke-a1 |
| _smoke | Copenhagen | ✓ — |
| _smoke | 1790-06-17 | ✓ smoke-a2 |
| _smoke | P. Madsen | ✓ smoke-a5 |
| age-related-disease | Age-related disease or disease-relate… | ✓ anchor_de57395d0c4 |
| age-related-disease | Katharina Fuchs | ✓ anchor_233d1ab87aa |
| age-related-disease | Jo Appleby | ✓ anchor_233d1ab87aa |
| age-related-disease | 10.1016/j.ijpp.2026.02.003 | ✓ anchor_6adfba012ee |
| age-related-disease | k.fuchs@ufg.uni-kiel.de | ✓ anchor_fdffe173700 |
| age-related-disease | University of Leicester | ✓ anchor_028b35c6855 |
| age-related-disease | Kiel University | ✓ anchor_1eeb7fa3207 |
| age-related-disease | Vanderbilt University Medical Center | ✓ anchor_f51c592e3bd |
| age-related-disease | Mississippi State University | ✓ anchor_78e15c3560d |
| age-related-disease | 60 % | ✓ anchor_4ab699d3e12 |
| age-related-disease | TA3 | ✓ anchor_4ab699d3e12 |
| age-related-disease | Kathryn E. Marklein | ✓ anchor_233d1ab87aa |
| age-related-disease | progeria | ✓ anchor_f0fb6b5010c |
| age-related-disease | International Journal of Paleopathology | ✓ anchor_dcaf435b4d3 |
| age-related-disease | Im Dol 2-6 | ✓ anchor_773ccee8569 |
| age-related-disease | 10.1016/j.ijpp.2026.02.004 | ✓ — |
| age-related-disease | Katherine Fuchs | ✓ — |
| age-related-disease | TA4 | ✓ — |
| age-related-disease | University of Oxford | ✓ — |
| age-related-disease | Aarhus University | ✓ — |
| brondbylund | TAK 1506 | ✓ anchor_74f5629f2e4 |
| brondbylund | Maria Lisette Jacobsen | ✓ anchor_772d564bd37 |
| brondbylund | ca. 1 år | ✓ anchor_3e88c36c6ac |
| brondbylund | 900 e. Kr. | ✓ anchor_e32d087632c |
| brondbylund | 18 | ✓ anchor_735960dfc73 |
| brondbylund | Lars Nissen | ✓ anchor_edc60e8a2e9 |
| brondbylund | Lind & Risør | ✓ anchor_5cd63a98820 |
| brondbylund | FHM 4296/2382 | ✓ anchor_76a638133bd |
| brondbylund | Brøndbyøster sogn | ✓ anchor_1449a8a3f1c |
| brondbylund | 5000 m2 | ✓ — |
| brondbylund | TAK 1507 | ✓ — |
| brondbylund | ca. 2 år | ✓ — |
| brondbylund | 19 | ✓ — |
| brondbylund | 542 g | ✓ anchor_b0152f15cb9 |
| brondbylund | 1200 f.Kr. | ✓ — |
| brondbylund | 543 g | ✓ — |
| brondbylund | 150 | ✓ — |
| catfish-collagen | Properties of Skin Collagen from Sout… | ✓ anchor_4b6b6143a77 |
| catfish-collagen | zhangxi@mail.hzau.edu.cn | ✓ anchor_cd670a8ada5 |
| catfish-collagen | +86-18672306015 | ✓ anchor_cd670a8ada5 |
| catfish-collagen | Carlos José Dias Pereira | ✓ anchor_281439a9f96 |
| catfish-collagen | 1 August 2024 | ✓ anchor_f781e0cbbe1 |
| catfish-collagen | 13 September 2024 | ✓ anchor_2c556afc880 |
| catfish-collagen | Hokkaido University | ✓ anchor_156d421e102 |
| catfish-collagen | takagi@fish.hokudai.ac.jp | ✓ anchor_156d421e102 |
| catfish-collagen | 6 weeks | ✓ anchor_7d5aa15172d |
| catfish-collagen | 27.09 ± 0.89 g | ✓ anchor_a986c2a37ab |
| catfish-collagen | 8.66 ± 0.11% | ✓ anchor_8aa33654155 |
| catfish-collagen | 61.78 ± 3.91% | ✓ anchor_8aa33654155 |
| catfish-collagen | SPSS Base 25 | ✓ anchor_58009cbd2db |
| catfish-collagen | GACGCTGTATGTGAAACGGC | ✓ anchor_8d86be60f2f |
| catfish-collagen | TATCTCCCCTTGGTCCCGAT | ✓ anchor_4faa09e9a48 |
| catfish-collagen | Nicolet IS50 | ✓ anchor_32cca9ee8ba |
| catfish-collagen | 12,000 × g | ✓ anchor_161b1292bbd |
| catfish-collagen | zhangxi@mail.hzau.edu.com | ✓ — |
| catfish-collagen | 8.66 ± 0.12% | ✓ — |
| catfish-collagen | col1a3-F | ✓ — |
| catfish-collagen | Kyoto University | ✓ — |
| catfish-collagen | 15 September 2024 | ✓ — |
| ellekilde | Grav 8 | ✓ anchor_540e94d0e16 |
| ellekilde | over 45 år | ✓ anchor_3b23e3358bf |
| ellekilde | jernspænde | ✓ anchor_3b23e3358bf |
| ellekilde | 1450 BP | ✓ — |
| ellekilde | 8-5 | ✓ — |
| ellekilde | 25-35 år | ✓ anchor_faa3abc3e1c |
| ellekilde | Yngre romersk jernalder per. C3 | ✓ anchor_64a5a183460 |
| ellekilde | Perle af mat rødligt glas | ✓ anchor_0dacceee60e |
| ellekilde | Lå mellem de to underarmsknogler (24-18) | ✓ anchor_d6a0d525a81 |
| ellekilde | Yngre romersk jernalder per. C2 | ✓ — |
| ellekilde | 16-18 år | ✓ anchor_0f6b71abf27 |
| ellekilde | 15 | ✓ anchor_61cb7f12f88 |
| ellekilde | 2.8 x 1.3 meter | ✓ anchor_72d2d735426 |
| ellekilde | 17-18 år | ✓ — |
| ellekilde | Nationalmuseet i København | ✓ — |
| free-ports-hamburg | Free ports, political economy, and ea… | ✓ anchor_715a690ae19 |
| free-ports-hamburg | Esther Sahle | ✓ anchor_88f4fa65a5b |
| free-ports-hamburg | University of Copenhagen, Saxo Institute | ✓ anchor_f526f6d7993 |
| free-ports-hamburg | Cambridge University Press | ✓ anchor_bf89e84c6f5 |
| free-ports-hamburg | University of Oxford | ✓ — |
| free-ports-hamburg | Esther Sahler | ✓ — |
| free-ports-hamburg | 1591 | ✗ anchor_b771fc1a940 |
| free-ports-hamburg | Livorno | ✓ anchor_b771fc1a940 |
| free-ports-hamburg | 1592 | ✓ — |
| free-ports-hamburg | 159 | ✓ — |
| free-ports-hamburg | 1664 | ✗ anchor_ad698f0b6a4 |
| free-ports-hamburg | 1706 | ✓ anchor_1215213c04a |
| free-ports-hamburg | 1766 | ✗ anchor_0bbd16ebafa |
| herredsvejen | SBM1694 | ✓ anchor_fb53d73b0be |
| herredsvejen | Merethe Schifter Bagge | ✓ anchor_30e2ff5d0f8 |
| herredsvejen | 23-09-2019 | ✓ anchor_122c7838e35 |
| herredsvejen | 20. november 2019 | ✓ anchor_c20ee246bb9 |
| herredsvejen | 19/06370 | ✓ anchor_122c7838e35 |
| herredsvejen | 576 | ✓ anchor_7227d563157 |
| herredsvejen | 362 | ✓ anchor_7227d563157 |
| herredsvejen | Poul Kragh | ✓ anchor_c0395884a7d |
| herredsvejen | Skanderborg Kommune, Teknik og Miljø | ✓ anchor_97f36f8b78f |
| herredsvejen | Lars Lykke Jensen | ✓ anchor_97f36f8b78f |
| herredsvejen | ca. 23 m | ✓ anchor_e1d16a1197c |
| herredsvejen | 41 fragmenter | ✓ anchor_8b631316cef |
| herredsvejen | 5.853 m2 | ✓ anchor_5a1c177ea58 |
| herredsvejen | 1300 m2 | ✓ anchor_9f47ea13623 |
| herredsvejen | SBM1695 | ✓ — |
| herredsvejen | Merete Schifter Bagge | ✗ anchor_30e2ff5d0f8 |
| herredsvejen | Nationalmuseet | ✓ — |
| herredsvejen | 13,5 m | ✓ anchor_68f25e6d447 |
| herredsvejen | K14 | ✓ — |
| herredsvejen | X233 | ✓ anchor_5d3db8876b9 |
| herredsvejen | 6 x 4 mm | ✓ anchor_5d3db8876b9 |
| herredsvejen | AAR 33273 | ✓ anchor_63fdd9a6f47 |
| herredsvejen | AAR 33274 | ✓ — |
| hojbakkegaard | TAK 1177 | ✓ anchor_9a60b8b8638 |
| hojbakkegaard | 020214-65, -66 | ✓ anchor_83f13172419 |
| hojbakkegaard | Tom Giersing | ✓ anchor_51b6ddcfa56 |
| hojbakkegaard | Mette Brosolat Ohlsen | ✓ anchor_133c36120cd |
| hojbakkegaard | Lone Brorson | ✓ anchor_1b0366f3c39 |
| hojbakkegaard | Jan Poulsen | ✓ anchor_04f72452ee4 |
| hojbakkegaard | 2004-08-13 | ✓ anchor_143c9746911 |
| hojbakkegaard | 55.6702 N | ✓ — |
| hojbakkegaard | TAK 1178 | ✓ — |
| hojbakkegaard | 020214-67 | ✓ — |
| hojbakkegaard | 17. august 2004 | ✓ — |
| hojbakkegaard | ca. 210-250 e.Kr | ✓ anchor_1df768b7d8f |
| hojbakkegaard | 3950 BP | ✓ — |
| hojbakkegaard | ca. 400 e.Kr. | ✓ anchor_4cb663f7eac |
| hojbakkegaard | 32 | ✓ anchor_546040a3e1e |
| hojbakkegaard | 33 | ✓ — |
| hojbakkegaard | 2.20 meter | ✓ anchor_e183d0f5fc4 |
| hvissinge | TAK 1728 | ✓ anchor_a4fb0e662bb |
| hvissinge | Bo Jensen | ✓ anchor_e6a27f42262 |
| hvissinge | Linda Boye | ✓ anchor_b658d978bc5 |
| hvissinge | 20-06-2016 | ✓ anchor_b9626568d28 |
| hvissinge | 27-07-2016 | ✓ anchor_b27b10f35d8 |
| hvissinge | 267 | ✓ anchor_39bb0aa22e1 |
| hvissinge | 58 cm | ✓ anchor_942ba80df00 |
| hvissinge | Kurt Herskind | ✓ anchor_b27b10f35d8 |
| hvissinge | Hanus Jensen | ✓ anchor_5d9e995eec8 |
| hvissinge | Glostrup Kommune | ✓ anchor_b9626568d28 |
| hvissinge | TV Lorry | ✓ anchor_23b8da0efab |
| hvissinge | Morten Knudsen | ✓ anchor_773b5fe2c12 |
| hvissinge | år 1-400 | ✓ anchor_367c8a273ff |
| hvissinge | 29 | ✓ anchor_d30fc0e8717 |
| hvissinge | TAK 1729 | ✓ — |
| hvissinge | Bo Jansen | ✓ — |
| hvissinge | 05-09-2016 | ✓ — |
| hvissinge | Roskilde Kommune | ✓ — |
| hvissinge | cirka 173 cm | ✓ anchor_cc1c4dac3dd |
| hvissinge | 135 cm | ✓ anchor_0a1cae114ce |
| hvissinge | 172 cm | ✓ anchor_c1c385a8c88 |
| hvissinge | grav 12 | ✓ — |
| katrinesminde | SBM1116 | ✓ anchor_936759daa7a |
| katrinesminde | Merethe Schifter Christensen | ✓ anchor_f4cec97caf0 |
| katrinesminde | René D. Jensen | ✓ anchor_4d990a5f52f |
| katrinesminde | 13. oktober 2009 | ✓ anchor_868bd0498cb |
| katrinesminde | 2529 m2 | ✓ anchor_2c90234c21b |
| katrinesminde | 116 | ✓ anchor_5560879bdef |
| katrinesminde | 88 | ✓ anchor_5560879bdef |
| katrinesminde | 75,5 m | ✓ anchor_7bb2600dce8 |
| katrinesminde | 47 | ✓ anchor_61604d00261 |
| katrinesminde | ca. 83 kg | ✓ anchor_6b6d1414f14 |
| katrinesminde | Peter Jensen | ✓ anchor_e4405369f2b |
| katrinesminde | 26-11-2009 | ✓ anchor_e9d01929435 |
| katrinesminde | Adelgade 5 | ✓ anchor_f6cfd3b8c2c |
| katrinesminde | 7,73 % | ✓ anchor_797362f97eb |
| katrinesminde | SBM1117 | ✓ — |
| katrinesminde | Merethe Schifter Bagge | ✓ — |
| katrinesminde | 14. oktober 2009 | ✓ — |
| katrinesminde | Nationalmuseet | ✓ — |
| katrinesminde | Louise Søndergaard | ✓ anchor_868bd0498cb |
| katrinesminde | Anja Vegebjerg Jensen | ✓ anchor_868bd0498cb |
| katrinesminde | X44 | ✓ anchor_8e310c1ff1c |
| katrinesminde | X118 | ✓ anchor_ad6c01b6a27 |
| katrinesminde | X119 | ✓ — |


## LLM baseline (hf.co/bartowski/ai9stars_G9v3-3B-GGUF:Q8_0, 38 per-record calls)

| model | accuracy@1 | correct abstain | wrong link | protocol failures | avg ms/claim |
|---|---|---|---|---|---|
| hf.co/bartowski/ai9stars_G9v3-3B-GGUF:Q8_0 | 57/133 | 11/49 | 94 | 6 | 626 |

### Per-claim audit

| doc | claim | LLM pick |
|---|---|---|
| 1790-06-17-1 | Jean | ✗ — (protocol failure) |
| 1790-06-17-1 | New Orleans | ✗ — (protocol failure) |
| 1790-06-17-1 | Marcel | ✗ — |
| 1790-06-17-1 | environ 25 ans | ✓ anchor_49c796ee55f |
| 1790-06-17-1 | Lallemand | ✓ anchor_49c796ee55f |
| _smoke | 1234.56 | ✓ smoke-a4 |
| _smoke | 42 | ✓ smoke-a1 |
| _smoke | Copenhagen | ✓ — |
| _smoke | 1790-06-17 | ✗ — |
| _smoke | P. Madsen | ✓ smoke-a5 |
| age-related-disease | Age-related disease or disease-relate… | ✓ anchor_de57395d0c4 |
| age-related-disease | Katharina Fuchs | ✗ — |
| age-related-disease | Jo Appleby | ✗ — |
| age-related-disease | 10.1016/j.ijpp.2026.02.003 | ✓ anchor_6adfba012ee |
| age-related-disease | k.fuchs@ufg.uni-kiel.de | ✓ anchor_fdffe173700 |
| age-related-disease | University of Leicester | ✗ anchor_1eeb7fa3207 |
| age-related-disease | Kiel University | ✓ anchor_1eeb7fa3207 |
| age-related-disease | Vanderbilt University Medical Center | ✓ anchor_f51c592e3bd |
| age-related-disease | Mississippi State University | ✓ anchor_78e15c3560d |
| age-related-disease | 60 % | ✓ anchor_4ab699d3e12 |
| age-related-disease | TA3 | ✗ — |
| age-related-disease | Kathryn E. Marklein | ✗ — |
| age-related-disease | progeria | ✗ — |
| age-related-disease | International Journal of Paleopathology | ✓ anchor_dcaf435b4d3 |
| age-related-disease | Im Dol 2-6 | ✓ anchor_773ccee8569 |
| age-related-disease | 10.1016/j.ijpp.2026.02.004 | ✗ anchor_6adfba012ee |
| age-related-disease | Katherine Fuchs | ✓ — |
| age-related-disease | TA4 | ✓ — |
| age-related-disease | University of Oxford | ✓ — |
| age-related-disease | Aarhus University | ✓ — |
| brondbylund | TAK 1506 | ✓ anchor_4be8009e760 |
| brondbylund | Maria Lisette Jacobsen | ✓ anchor_772d564bd37 |
| brondbylund | ca. 1 år | ✗ anchor_735960dfc73 |
| brondbylund | 900 e. Kr. | ✗ anchor_dbbc4c7a5fd |
| brondbylund | 18 | ✓ anchor_735960dfc73 |
| brondbylund | Lars Nissen | ✗ — |
| brondbylund | Lind & Risør | ✗ anchor_01fbe899f39 |
| brondbylund | FHM 4296/2382 | ✗ anchor_c16f6dfbfed |
| brondbylund | Brøndbyøster sogn | ✓ anchor_1449a8a3f1c |
| brondbylund | 5000 m2 | ✓ — |
| brondbylund | TAK 1507 | ✓ — |
| brondbylund | ca. 2 år | ✓ — |
| brondbylund | 19 | ✓ — |
| brondbylund | 542 g | ✓ anchor_b0152f15cb9 |
| brondbylund | 1200 f.Kr. | ✗ anchor_dbbc4c7a5fd |
| brondbylund | 543 g | ✗ anchor_b0152f15cb9 |
| brondbylund | 150 | ✗ anchor_735960dfc73 |
| catfish-collagen | Properties of Skin Collagen from Sout… | ✗ anchor_8aa33654155 |
| catfish-collagen | zhangxi@mail.hzau.edu.cn | ✓ anchor_cd670a8ada5 |
| catfish-collagen | +86-18672306015 | ✓ anchor_cd670a8ada5 |
| catfish-collagen | Carlos José Dias Pereira | ✓ anchor_281439a9f96 |
| catfish-collagen | 1 August 2024 | ✓ anchor_f781e0cbbe1 |
| catfish-collagen | 13 September 2024 | ✓ anchor_2c556afc880 |
| catfish-collagen | Hokkaido University | ✓ anchor_156d421e102 |
| catfish-collagen | takagi@fish.hokudai.ac.jp | ✓ anchor_156d421e102 |
| catfish-collagen | 6 weeks | ✓ anchor_7d5aa15172d |
| catfish-collagen | 27.09 ± 0.89 g | ✗ anchor_b73a9b0ba0d |
| catfish-collagen | 8.66 ± 0.11% | ✓ anchor_8aa33654155 |
| catfish-collagen | 61.78 ± 3.91% | ✓ anchor_8aa33654155 |
| catfish-collagen | SPSS Base 25 | ✓ anchor_58009cbd2db |
| catfish-collagen | GACGCTGTATGTGAAACGGC | ✗ anchor_1234141b5d8 |
| catfish-collagen | TATCTCCCCTTGGTCCCGAT | ✗ anchor_1234141b5d8 |
| catfish-collagen | Nicolet IS50 | ✓ anchor_32cca9ee8ba |
| catfish-collagen | 12,000 × g | ✗ anchor_d570a1853ab |
| catfish-collagen | zhangxi@mail.hzau.edu.com | ✗ anchor_fe0f360609e |
| catfish-collagen | 8.66 ± 0.12% | ✗ anchor_8aa33654155 |
| catfish-collagen | col1a3-F | ✗ anchor_f8bd933dd5b |
| catfish-collagen | Kyoto University | ✗ anchor_156d421e102 |
| catfish-collagen | 15 September 2024 | ✗ anchor_2c556afc880 |
| ellekilde | Grav 8 | ✗ anchor_cb99d1f74df |
| ellekilde | over 45 år | ✗ — |
| ellekilde | jernspænde | ✓ anchor_3b23e3358bf |
| ellekilde | 1450 BP | ✗ anchor_527871ac406 |
| ellekilde | 8-5 | ✗ anchor_64a5a183460 |
| ellekilde | 25-35 år | ✗ anchor_cb99d1f74df |
| ellekilde | Yngre romersk jernalder per. C3 | ✗ anchor_527871ac406 |
| ellekilde | Perle af mat rødligt glas | ✗ anchor_75304c9b7fe |
| ellekilde | Lå mellem de to underarmsknogler (24-18) | ✗ anchor_aac5ea76ced |
| ellekilde | Yngre romersk jernalder per. C2 | ✗ anchor_527871ac406 |
| ellekilde | 16-18 år | ✗ anchor_cb99d1f74df |
| ellekilde | 15 | ✗ anchor_3b23e3358bf |
| ellekilde | 2.8 x 1.3 meter | ✗ anchor_d7a8441795a |
| ellekilde | 17-18 år | ✗ anchor_bf11c12bf29 |
| ellekilde | Nationalmuseet i København | ✗ anchor_cb99d1f74df |
| free-ports-hamburg | Free ports, political economy, and ea… | ✗ anchor_f526f6d7993 |
| free-ports-hamburg | Esther Sahle | ✗ — |
| free-ports-hamburg | University of Copenhagen, Saxo Institute | ✗ — |
| free-ports-hamburg | Cambridge University Press | ✗ — |
| free-ports-hamburg | University of Oxford | ✓ — |
| free-ports-hamburg | Esther Sahler | ✓ — |
| free-ports-hamburg | 1591 | ✗ — (protocol failure) |
| free-ports-hamburg | Livorno | ✗ — (protocol failure) |
| free-ports-hamburg | 1592 | ✗ — (protocol failure) |
| free-ports-hamburg | 159 | ✗ — (protocol failure) |
| free-ports-hamburg | 1664 | ✗ anchor_f526f6d7993 |
| free-ports-hamburg | 1706 | ✗ anchor_f526f6d7993 |
| free-ports-hamburg | 1766 | ✗ anchor_f526f6d7993 |
| herredsvejen | SBM1694 | ✓ anchor_fb53d73b0be |
| herredsvejen | Merethe Schifter Bagge | ✓ anchor_30e2ff5d0f8 |
| herredsvejen | 23-09-2019 | ✓ anchor_122c7838e35 |
| herredsvejen | 20. november 2019 | ✓ anchor_c20ee246bb9 |
| herredsvejen | 19/06370 | ✓ anchor_122c7838e35 |
| herredsvejen | 576 | ✓ anchor_7227d563157 |
| herredsvejen | 362 | ✓ anchor_7227d563157 |
| herredsvejen | Poul Kragh | ✗ anchor_d33917c2342 |
| herredsvejen | Skanderborg Kommune, Teknik og Miljø | ✓ anchor_97f36f8b78f |
| herredsvejen | Lars Lykke Jensen | ✓ anchor_97f36f8b78f |
| herredsvejen | ca. 23 m | ✗ anchor_423e606834d |
| herredsvejen | 41 fragmenter | ✗ anchor_7227d563157 |
| herredsvejen | 5.853 m2 | ✓ anchor_5a1c177ea58 |
| herredsvejen | 1300 m2 | ✗ anchor_b31a3b0b6d1 |
| herredsvejen | SBM1695 | ✗ anchor_fb53d73b0be |
| herredsvejen | Merete Schifter Bagge | ✗ anchor_30e2ff5d0f8 |
| herredsvejen | Nationalmuseet | ✗ anchor_376c9b26d8c |
| herredsvejen | 13,5 m | ✗ anchor_a7930b971b0 |
| herredsvejen | K14 | ✗ anchor_a7930b971b0 |
| herredsvejen | X233 | ✗ anchor_a7930b971b0 |
| herredsvejen | 6 x 4 mm | ✗ anchor_a7930b971b0 |
| herredsvejen | AAR 33273 | ✗ anchor_30e2ff5d0f8 |
| herredsvejen | AAR 33274 | ✗ anchor_30e2ff5d0f8 |
| hojbakkegaard | TAK 1177 | ✓ anchor_d850df38f5a |
| hojbakkegaard | 020214-65, -66 | ✗ — |
| hojbakkegaard | Tom Giersing | ✗ anchor_9c09cb423d8 |
| hojbakkegaard | Mette Brosolat Ohlsen | ✓ anchor_133c36120cd |
| hojbakkegaard | Lone Brorson | ✗ anchor_fb91e84f9cd |
| hojbakkegaard | Jan Poulsen | ✗ anchor_fb91e84f9cd |
| hojbakkegaard | 2004-08-13 | ✓ anchor_143c9746911 |
| hojbakkegaard | 55.6702 N | ✗ anchor_698792a8e7d |
| hojbakkegaard | TAK 1178 | ✗ anchor_d850df38f5a |
| hojbakkegaard | 020214-67 | ✗ anchor_0803128f845 |
| hojbakkegaard | 17. august 2004 | ✗ anchor_9c09cb423d8 |
| hojbakkegaard | ca. 210-250 e.Kr | ✗ anchor_b57c6e94243 |
| hojbakkegaard | 3950 BP | ✗ anchor_0640472c562 |
| hojbakkegaard | ca. 400 e.Kr. | ✗ anchor_b57c6e94243 |
| hojbakkegaard | 32 | ✗ anchor_b807bab7523 |
| hojbakkegaard | 33 | ✗ anchor_b807bab7523 |
| hojbakkegaard | 2.20 meter | ✗ anchor_fb91e84f9cd |
| hvissinge | TAK 1728 | ✓ anchor_a4fb0e662bb |
| hvissinge | Bo Jensen | ✓ anchor_e6a27f42262 |
| hvissinge | Linda Boye | ✗ anchor_e6a27f42262 |
| hvissinge | 20-06-2016 | ✗ anchor_e60aa0d7924 |
| hvissinge | 27-07-2016 | ✗ anchor_e60aa0d7924 |
| hvissinge | 267 | ✗ anchor_39b0dd18535 |
| hvissinge | 58 cm | ✗ anchor_128ce55fd50 |
| hvissinge | Kurt Herskind | ✓ anchor_b27b10f35d8 |
| hvissinge | Hanus Jensen | ✗ anchor_393b91954a6 |
| hvissinge | Glostrup Kommune | ✗ anchor_574bc105bb8 |
| hvissinge | TV Lorry | ✗ anchor_a648586333e |
| hvissinge | Morten Knudsen | ✗ anchor_b27b10f35d8 |
| hvissinge | år 1-400 | ✗ anchor_128ce55fd50 |
| hvissinge | 29 | ✗ anchor_393b91954a6 |
| hvissinge | TAK 1729 | ✗ anchor_a4fb0e662bb |
| hvissinge | Bo Jansen | ✗ anchor_4606debf71c |
| hvissinge | 05-09-2016 | ✗ anchor_b27b10f35d8 |
| hvissinge | Roskilde Kommune | ✗ anchor_23b8da0efab |
| hvissinge | cirka 173 cm | ✗ anchor_39b0dd18535 |
| hvissinge | 135 cm | ✗ anchor_39b0dd18535 |
| hvissinge | 172 cm | ✗ anchor_39b0dd18535 |
| hvissinge | grav 12 | ✗ anchor_39b0dd18535 |
| katrinesminde | SBM1116 | ✗ anchor_f4cec97caf0 |
| katrinesminde | Merethe Schifter Christensen | ✓ anchor_f4cec97caf0 |
| katrinesminde | René D. Jensen | ✓ anchor_4d990a5f52f |
| katrinesminde | 13. oktober 2009 | ✓ anchor_868bd0498cb |
| katrinesminde | 2529 m2 | ✓ anchor_2c90234c21b |
| katrinesminde | 116 | ✓ anchor_5560879bdef |
| katrinesminde | 88 | ✓ anchor_5560879bdef |
| katrinesminde | 75,5 m | ✗ anchor_102dc778d5b |
| katrinesminde | 47 | ✗ anchor_c8943f9b559 |
| katrinesminde | ca. 83 kg | ✗ — |
| katrinesminde | Peter Jensen | ✗ anchor_868bd0498cb |
| katrinesminde | 26-11-2009 | ✗ anchor_868bd0498cb |
| katrinesminde | Adelgade 5 | ✓ anchor_f6cfd3b8c2c |
| katrinesminde | 7,73 % | ✓ anchor_797362f97eb |
| katrinesminde | SBM1117 | ✗ anchor_2c90234c21b |
| katrinesminde | Merethe Schifter Bagge | ✗ anchor_f4cec97caf0 |
| katrinesminde | 14. oktober 2009 | ✗ anchor_f4cec97caf0 |
| katrinesminde | Nationalmuseet | ✗ anchor_f6cfd3b8c2c |
| katrinesminde | Louise Søndergaard | ✗ anchor_f4cec97caf0 |
| katrinesminde | Anja Vegebjerg Jensen | ✓ anchor_868bd0498cb |
| katrinesminde | X44 | ✗ anchor_f4cec97caf0 |
| katrinesminde | X118 | ✗ anchor_f4cec97caf0 |
| katrinesminde | X119 | ✗ anchor_f4cec97caf0 |


## LLM baseline (codex/gpt-5.6-luna@low, 38 per-record calls)

| model | accuracy@1 | correct abstain | wrong link | protocol failures | avg ms/claim |
|---|---|---|---|---|---|
| codex/gpt-5.6-luna@low | 127/133 | 44/49 | 10 | 0 | 1196 |

### Per-claim audit

| doc | claim | LLM pick |
|---|---|---|
| 1790-06-17-1 | Jean | ✓ anchor_ebb61fca35b |
| 1790-06-17-1 | New Orleans | ✓ — |
| 1790-06-17-1 | Marcel | ✓ anchor_ebb61fca35b |
| 1790-06-17-1 | environ 25 ans | ✓ anchor_49c796ee55f |
| 1790-06-17-1 | Lallemand | ✓ anchor_49c796ee55f |
| _smoke | 1234.56 | ✓ smoke-a4 |
| _smoke | 42 | ✓ smoke-a1 |
| _smoke | Copenhagen | ✓ — |
| _smoke | 1790-06-17 | ✓ smoke-a2 |
| _smoke | P. Madsen | ✓ smoke-a5 |
| age-related-disease | Age-related disease or disease-relate… | ✓ anchor_de57395d0c4 |
| age-related-disease | Katharina Fuchs | ✓ anchor_233d1ab87aa |
| age-related-disease | Jo Appleby | ✓ anchor_233d1ab87aa |
| age-related-disease | 10.1016/j.ijpp.2026.02.003 | ✓ anchor_6adfba012ee |
| age-related-disease | k.fuchs@ufg.uni-kiel.de | ✓ anchor_fdffe173700 |
| age-related-disease | University of Leicester | ✓ anchor_028b35c6855 |
| age-related-disease | Kiel University | ✓ anchor_1eeb7fa3207 |
| age-related-disease | Vanderbilt University Medical Center | ✓ anchor_f51c592e3bd |
| age-related-disease | Mississippi State University | ✓ anchor_78e15c3560d |
| age-related-disease | 60 % | ✓ anchor_4ab699d3e12 |
| age-related-disease | TA3 | ✓ anchor_4ab699d3e12 |
| age-related-disease | Kathryn E. Marklein | ✓ anchor_233d1ab87aa |
| age-related-disease | progeria | ✓ anchor_f0fb6b5010c |
| age-related-disease | International Journal of Paleopathology | ✓ anchor_dcaf435b4d3 |
| age-related-disease | Im Dol 2-6 | ✓ anchor_773ccee8569 |
| age-related-disease | 10.1016/j.ijpp.2026.02.004 | ✓ — |
| age-related-disease | Katherine Fuchs | ✓ — |
| age-related-disease | TA4 | ✓ — |
| age-related-disease | University of Oxford | ✓ — |
| age-related-disease | Aarhus University | ✓ — |
| brondbylund | TAK 1506 | ✓ anchor_4be8009e760 |
| brondbylund | Maria Lisette Jacobsen | ✓ anchor_772d564bd37 |
| brondbylund | ca. 1 år | ✓ anchor_3e88c36c6ac |
| brondbylund | 900 e. Kr. | ✓ anchor_e32d087632c |
| brondbylund | 18 | ✗ anchor_dbbc4c7a5fd |
| brondbylund | Lars Nissen | ✓ anchor_edc60e8a2e9 |
| brondbylund | Lind & Risør | ✓ anchor_5cd63a98820 |
| brondbylund | FHM 4296/2382 | ✓ anchor_76a638133bd |
| brondbylund | Brøndbyøster sogn | ✓ anchor_1449a8a3f1c |
| brondbylund | 5000 m2 | ✓ — |
| brondbylund | TAK 1507 | ✓ — |
| brondbylund | ca. 2 år | ✓ — |
| brondbylund | 19 | ✓ — |
| brondbylund | 542 g | ✓ anchor_b0152f15cb9 |
| brondbylund | 1200 f.Kr. | ✗ anchor_775caf8b018 |
| brondbylund | 543 g | ✓ — |
| brondbylund | 150 | ✗ anchor_4be8009e760 |
| catfish-collagen | Properties of Skin Collagen from Sout… | ✓ anchor_4b6b6143a77 |
| catfish-collagen | zhangxi@mail.hzau.edu.cn | ✗ — |
| catfish-collagen | +86-18672306015 | ✓ anchor_cd670a8ada5 |
| catfish-collagen | Carlos José Dias Pereira | ✓ anchor_281439a9f96 |
| catfish-collagen | 1 August 2024 | ✓ anchor_f781e0cbbe1 |
| catfish-collagen | 13 September 2024 | ✓ anchor_2c556afc880 |
| catfish-collagen | Hokkaido University | ✓ anchor_156d421e102 |
| catfish-collagen | takagi@fish.hokudai.ac.jp | ✓ anchor_156d421e102 |
| catfish-collagen | 6 weeks | ✓ anchor_7d5aa15172d |
| catfish-collagen | 27.09 ± 0.89 g | ✓ anchor_a986c2a37ab |
| catfish-collagen | 8.66 ± 0.11% | ✓ anchor_8aa33654155 |
| catfish-collagen | 61.78 ± 3.91% | ✓ anchor_8aa33654155 |
| catfish-collagen | SPSS Base 25 | ✓ anchor_58009cbd2db |
| catfish-collagen | GACGCTGTATGTGAAACGGC | ✓ anchor_8d86be60f2f |
| catfish-collagen | TATCTCCCCTTGGTCCCGAT | ✓ anchor_4faa09e9a48 |
| catfish-collagen | Nicolet IS50 | ✓ anchor_32cca9ee8ba |
| catfish-collagen | 12,000 × g | ✓ anchor_161b1292bbd |
| catfish-collagen | zhangxi@mail.hzau.edu.com | ✓ — |
| catfish-collagen | 8.66 ± 0.12% | ✓ — |
| catfish-collagen | col1a3-F | ✓ — |
| catfish-collagen | Kyoto University | ✓ — |
| catfish-collagen | 15 September 2024 | ✓ — |
| ellekilde | Grav 8 | ✓ anchor_540e94d0e16 |
| ellekilde | over 45 år | ✓ anchor_3b23e3358bf |
| ellekilde | jernspænde | ✓ anchor_3b23e3358bf |
| ellekilde | 1450 BP | ✓ — |
| ellekilde | 8-5 | ✓ — |
| ellekilde | 25-35 år | ✓ anchor_faa3abc3e1c |
| ellekilde | Yngre romersk jernalder per. C3 | ✓ anchor_64a5a183460 |
| ellekilde | Perle af mat rødligt glas | ✓ anchor_0dacceee60e |
| ellekilde | Lå mellem de to underarmsknogler (24-18) | ✓ anchor_d6a0d525a81 |
| ellekilde | Yngre romersk jernalder per. C2 | ✗ anchor_b3f723502a1 |
| ellekilde | 16-18 år | ✓ anchor_0f6b71abf27 |
| ellekilde | 15 | ✓ anchor_61cb7f12f88 |
| ellekilde | 2.8 x 1.3 meter | ✓ anchor_72d2d735426 |
| ellekilde | 17-18 år | ✓ — |
| ellekilde | Nationalmuseet i København | ✓ — |
| free-ports-hamburg | Free ports, political economy, and ea… | ✓ anchor_715a690ae19 |
| free-ports-hamburg | Esther Sahle | ✓ anchor_88f4fa65a5b |
| free-ports-hamburg | University of Copenhagen, Saxo Institute | ✓ anchor_f526f6d7993 |
| free-ports-hamburg | Cambridge University Press | ✓ anchor_bf89e84c6f5 |
| free-ports-hamburg | University of Oxford | ✗ anchor_5ab1622aae4 |
| free-ports-hamburg | Esther Sahler | ✓ — |
| free-ports-hamburg | 1591 | ✗ anchor_b771fc1a940 |
| free-ports-hamburg | Livorno | ✓ anchor_b771fc1a940 |
| free-ports-hamburg | 1592 | ✓ — |
| free-ports-hamburg | 159 | ✓ — |
| free-ports-hamburg | 1664 | ✗ anchor_ad698f0b6a4 |
| free-ports-hamburg | 1706 | ✗ anchor_e1eee399279 |
| free-ports-hamburg | 1766 | ✗ anchor_97071871c39 |
| herredsvejen | SBM1694 | ✓ anchor_fb53d73b0be |
| herredsvejen | Merethe Schifter Bagge | ✓ anchor_30e2ff5d0f8 |
| herredsvejen | 23-09-2019 | ✓ anchor_122c7838e35 |
| herredsvejen | 20. november 2019 | ✓ anchor_c20ee246bb9 |
| herredsvejen | 19/06370 | ✓ anchor_122c7838e35 |
| herredsvejen | 576 | ✓ anchor_7227d563157 |
| herredsvejen | 362 | ✓ anchor_7227d563157 |
| herredsvejen | Poul Kragh | ✓ anchor_c0395884a7d |
| herredsvejen | Skanderborg Kommune, Teknik og Miljø | ✓ anchor_97f36f8b78f |
| herredsvejen | Lars Lykke Jensen | ✓ anchor_97f36f8b78f |
| herredsvejen | ca. 23 m | ✓ anchor_e1d16a1197c |
| herredsvejen | 41 fragmenter | ✓ anchor_8b631316cef |
| herredsvejen | 5.853 m2 | ✓ anchor_5a1c177ea58 |
| herredsvejen | 1300 m2 | ✓ anchor_9f47ea13623 |
| herredsvejen | SBM1695 | ✓ — |
| herredsvejen | Merete Schifter Bagge | ✓ — |
| herredsvejen | Nationalmuseet | ✓ — |
| herredsvejen | 13,5 m | ✓ anchor_68f25e6d447 |
| herredsvejen | K14 | ✓ — |
| herredsvejen | X233 | ✓ anchor_18313ce3b66 |
| herredsvejen | 6 x 4 mm | ✓ anchor_5d3db8876b9 |
| herredsvejen | AAR 33273 | ✓ anchor_63fdd9a6f47 |
| herredsvejen | AAR 33274 | ✓ — |
| hojbakkegaard | TAK 1177 | ✓ anchor_d850df38f5a |
| hojbakkegaard | 020214-65, -66 | ✓ anchor_83f13172419 |
| hojbakkegaard | Tom Giersing | ✓ anchor_51b6ddcfa56 |
| hojbakkegaard | Mette Brosolat Ohlsen | ✓ anchor_a76cdef2866 |
| hojbakkegaard | Lone Brorson | ✓ anchor_1b0366f3c39 |
| hojbakkegaard | Jan Poulsen | ✓ anchor_04f72452ee4 |
| hojbakkegaard | 2004-08-13 | ✓ anchor_143c9746911 |
| hojbakkegaard | 55.6702 N | ✓ — |
| hojbakkegaard | TAK 1178 | ✓ — |
| hojbakkegaard | 020214-67 | ✓ — |
| hojbakkegaard | 17. august 2004 | ✓ — |
| hojbakkegaard | ca. 210-250 e.Kr | ✓ anchor_1df768b7d8f |
| hojbakkegaard | 3950 BP | ✓ — |
| hojbakkegaard | ca. 400 e.Kr. | ✓ anchor_4cb663f7eac |
| hojbakkegaard | 32 | ✓ anchor_546040a3e1e |
| hojbakkegaard | 33 | ✓ — |
| hojbakkegaard | 2.20 meter | ✓ anchor_e183d0f5fc4 |
| hvissinge | TAK 1728 | ✓ anchor_a4fb0e662bb |
| hvissinge | Bo Jensen | ✓ anchor_e6a27f42262 |
| hvissinge | Linda Boye | ✓ anchor_b658d978bc5 |
| hvissinge | 20-06-2016 | ✓ anchor_b9626568d28 |
| hvissinge | 27-07-2016 | ✓ anchor_b27b10f35d8 |
| hvissinge | 267 | ✓ anchor_39bb0aa22e1 |
| hvissinge | 58 cm | ✓ anchor_942ba80df00 |
| hvissinge | Kurt Herskind | ✓ anchor_b27b10f35d8 |
| hvissinge | Hanus Jensen | ✓ anchor_5d9e995eec8 |
| hvissinge | Glostrup Kommune | ✓ anchor_b9626568d28 |
| hvissinge | TV Lorry | ✓ anchor_23b8da0efab |
| hvissinge | Morten Knudsen | ✓ anchor_773b5fe2c12 |
| hvissinge | år 1-400 | ✓ anchor_367c8a273ff |
| hvissinge | 29 | ✓ anchor_d30fc0e8717 |
| hvissinge | TAK 1729 | ✓ — |
| hvissinge | Bo Jansen | ✓ — |
| hvissinge | 05-09-2016 | ✓ — |
| hvissinge | Roskilde Kommune | ✓ — |
| hvissinge | cirka 173 cm | ✓ anchor_cc1c4dac3dd |
| hvissinge | 135 cm | ✓ anchor_0a1cae114ce |
| hvissinge | 172 cm | ✓ anchor_c1c385a8c88 |
| hvissinge | grav 12 | ✗ anchor_cc1c4dac3dd |
| katrinesminde | SBM1116 | ✓ anchor_936759daa7a |
| katrinesminde | Merethe Schifter Christensen | ✓ anchor_f4cec97caf0 |
| katrinesminde | René D. Jensen | ✓ anchor_4d990a5f52f |
| katrinesminde | 13. oktober 2009 | ✓ anchor_868bd0498cb |
| katrinesminde | 2529 m2 | ✓ anchor_2c90234c21b |
| katrinesminde | 116 | ✓ anchor_5560879bdef |
| katrinesminde | 88 | ✓ anchor_5560879bdef |
| katrinesminde | 75,5 m | ✓ anchor_7bb2600dce8 |
| katrinesminde | 47 | ✓ anchor_61604d00261 |
| katrinesminde | ca. 83 kg | ✓ anchor_6b6d1414f14 |
| katrinesminde | Peter Jensen | ✓ anchor_e4405369f2b |
| katrinesminde | 26-11-2009 | ✓ anchor_e9d01929435 |
| katrinesminde | Adelgade 5 | ✓ anchor_f6cfd3b8c2c |
| katrinesminde | 7,73 % | ✓ anchor_797362f97eb |
| katrinesminde | SBM1117 | ✓ — |
| katrinesminde | Merethe Schifter Bagge | ✓ — |
| katrinesminde | 14. oktober 2009 | ✓ — |
| katrinesminde | Nationalmuseet | ✓ — |
| katrinesminde | Louise Søndergaard | ✓ anchor_868bd0498cb |
| katrinesminde | Anja Vegebjerg Jensen | ✓ anchor_868bd0498cb |
| katrinesminde | X44 | ✓ anchor_8e310c1ff1c |
| katrinesminde | X118 | ✓ anchor_ad6c01b6a27 |
| katrinesminde | X119 | ✓ — |


## LLM baseline (codex/gpt-5.6-luna@medium, 38 per-record calls)

| model | accuracy@1 | correct abstain | wrong link | protocol failures | avg ms/claim |
|---|---|---|---|---|---|
| codex/gpt-5.6-luna@medium | 128/133 | 48/49 | 6 | 0 | 1265 |

### Per-claim audit

| doc | claim | LLM pick |
|---|---|---|
| 1790-06-17-1 | Jean | ✓ anchor_ebb61fca35b |
| 1790-06-17-1 | New Orleans | ✓ — |
| 1790-06-17-1 | Marcel | ✓ anchor_ebb61fca35b |
| 1790-06-17-1 | environ 25 ans | ✓ anchor_49c796ee55f |
| 1790-06-17-1 | Lallemand | ✓ anchor_49c796ee55f |
| _smoke | 1234.56 | ✓ smoke-a4 |
| _smoke | 42 | ✓ smoke-a1 |
| _smoke | Copenhagen | ✓ — |
| _smoke | 1790-06-17 | ✓ smoke-a2 |
| _smoke | P. Madsen | ✓ smoke-a5 |
| age-related-disease | Age-related disease or disease-relate… | ✓ anchor_de57395d0c4 |
| age-related-disease | Katharina Fuchs | ✓ anchor_233d1ab87aa |
| age-related-disease | Jo Appleby | ✓ anchor_233d1ab87aa |
| age-related-disease | 10.1016/j.ijpp.2026.02.003 | ✓ anchor_6adfba012ee |
| age-related-disease | k.fuchs@ufg.uni-kiel.de | ✓ anchor_fdffe173700 |
| age-related-disease | University of Leicester | ✓ anchor_028b35c6855 |
| age-related-disease | Kiel University | ✓ anchor_1eeb7fa3207 |
| age-related-disease | Vanderbilt University Medical Center | ✓ anchor_f51c592e3bd |
| age-related-disease | Mississippi State University | ✓ anchor_78e15c3560d |
| age-related-disease | 60 % | ✓ anchor_4ab699d3e12 |
| age-related-disease | TA3 | ✓ anchor_4ab699d3e12 |
| age-related-disease | Kathryn E. Marklein | ✓ anchor_233d1ab87aa |
| age-related-disease | progeria | ✓ anchor_f0fb6b5010c |
| age-related-disease | International Journal of Paleopathology | ✓ anchor_dcaf435b4d3 |
| age-related-disease | Im Dol 2-6 | ✓ anchor_773ccee8569 |
| age-related-disease | 10.1016/j.ijpp.2026.02.004 | ✓ — |
| age-related-disease | Katherine Fuchs | ✓ — |
| age-related-disease | TA4 | ✓ — |
| age-related-disease | University of Oxford | ✓ — |
| age-related-disease | Aarhus University | ✗ anchor_c900f0797a4 |
| brondbylund | TAK 1506 | ✓ anchor_4be8009e760 |
| brondbylund | Maria Lisette Jacobsen | ✓ anchor_772d564bd37 |
| brondbylund | ca. 1 år | ✓ anchor_3e88c36c6ac |
| brondbylund | 900 e. Kr. | ✓ anchor_e32d087632c |
| brondbylund | 18 | ✗ anchor_dbbc4c7a5fd |
| brondbylund | Lars Nissen | ✓ anchor_edc60e8a2e9 |
| brondbylund | Lind & Risør | ✓ anchor_5cd63a98820 |
| brondbylund | FHM 4296/2382 | ✓ anchor_76a638133bd |
| brondbylund | Brøndbyøster sogn | ✓ anchor_1449a8a3f1c |
| brondbylund | 5000 m2 | ✓ — |
| brondbylund | TAK 1507 | ✓ — |
| brondbylund | ca. 2 år | ✓ — |
| brondbylund | 19 | ✓ — |
| brondbylund | 542 g | ✓ anchor_b0152f15cb9 |
| brondbylund | 1200 f.Kr. | ✓ — |
| brondbylund | 543 g | ✓ — |
| brondbylund | 150 | ✓ — |
| catfish-collagen | Properties of Skin Collagen from Sout… | ✓ anchor_4b6b6143a77 |
| catfish-collagen | zhangxi@mail.hzau.edu.cn | ✓ anchor_cd670a8ada5 |
| catfish-collagen | +86-18672306015 | ✓ anchor_cd670a8ada5 |
| catfish-collagen | Carlos José Dias Pereira | ✓ anchor_281439a9f96 |
| catfish-collagen | 1 August 2024 | ✓ anchor_f781e0cbbe1 |
| catfish-collagen | 13 September 2024 | ✓ anchor_2c556afc880 |
| catfish-collagen | Hokkaido University | ✓ anchor_156d421e102 |
| catfish-collagen | takagi@fish.hokudai.ac.jp | ✓ anchor_156d421e102 |
| catfish-collagen | 6 weeks | ✓ anchor_7d5aa15172d |
| catfish-collagen | 27.09 ± 0.89 g | ✓ anchor_a986c2a37ab |
| catfish-collagen | 8.66 ± 0.11% | ✓ anchor_8aa33654155 |
| catfish-collagen | 61.78 ± 3.91% | ✓ anchor_8aa33654155 |
| catfish-collagen | SPSS Base 25 | ✓ anchor_58009cbd2db |
| catfish-collagen | GACGCTGTATGTGAAACGGC | ✓ anchor_8d86be60f2f |
| catfish-collagen | TATCTCCCCTTGGTCCCGAT | ✓ anchor_4faa09e9a48 |
| catfish-collagen | Nicolet IS50 | ✓ anchor_32cca9ee8ba |
| catfish-collagen | 12,000 × g | ✓ anchor_161b1292bbd |
| catfish-collagen | zhangxi@mail.hzau.edu.com | ✓ — |
| catfish-collagen | 8.66 ± 0.12% | ✓ — |
| catfish-collagen | col1a3-F | ✓ — |
| catfish-collagen | Kyoto University | ✓ — |
| catfish-collagen | 15 September 2024 | ✓ — |
| ellekilde | Grav 8 | ✓ anchor_540e94d0e16 |
| ellekilde | over 45 år | ✓ anchor_3b23e3358bf |
| ellekilde | jernspænde | ✓ anchor_3b23e3358bf |
| ellekilde | 1450 BP | ✓ — |
| ellekilde | 8-5 | ✓ — |
| ellekilde | 25-35 år | ✓ anchor_faa3abc3e1c |
| ellekilde | Yngre romersk jernalder per. C3 | ✓ anchor_64a5a183460 |
| ellekilde | Perle af mat rødligt glas | ✓ anchor_0dacceee60e |
| ellekilde | Lå mellem de to underarmsknogler (24-18) | ✓ anchor_d6a0d525a81 |
| ellekilde | Yngre romersk jernalder per. C2 | ✓ — |
| ellekilde | 16-18 år | ✓ anchor_0f6b71abf27 |
| ellekilde | 15 | ✓ anchor_61cb7f12f88 |
| ellekilde | 2.8 x 1.3 meter | ✓ anchor_72d2d735426 |
| ellekilde | 17-18 år | ✓ — |
| ellekilde | Nationalmuseet i København | ✓ — |
| free-ports-hamburg | Free ports, political economy, and ea… | ✓ anchor_715a690ae19 |
| free-ports-hamburg | Esther Sahle | ✓ anchor_88f4fa65a5b |
| free-ports-hamburg | University of Copenhagen, Saxo Institute | ✓ anchor_f526f6d7993 |
| free-ports-hamburg | Cambridge University Press | ✓ anchor_bf89e84c6f5 |
| free-ports-hamburg | University of Oxford | ✓ — |
| free-ports-hamburg | Esther Sahler | ✓ — |
| free-ports-hamburg | 1591 | ✗ anchor_b771fc1a940 |
| free-ports-hamburg | Livorno | ✓ anchor_b771fc1a940 |
| free-ports-hamburg | 1592 | ✓ — |
| free-ports-hamburg | 159 | ✓ — |
| free-ports-hamburg | 1664 | ✗ anchor_ad698f0b6a4 |
| free-ports-hamburg | 1706 | ✗ anchor_e1eee399279 |
| free-ports-hamburg | 1766 | ✗ anchor_f5591df0ed3 |
| herredsvejen | SBM1694 | ✓ anchor_fb53d73b0be |
| herredsvejen | Merethe Schifter Bagge | ✓ anchor_30e2ff5d0f8 |
| herredsvejen | 23-09-2019 | ✓ anchor_122c7838e35 |
| herredsvejen | 20. november 2019 | ✓ anchor_c20ee246bb9 |
| herredsvejen | 19/06370 | ✓ anchor_122c7838e35 |
| herredsvejen | 576 | ✓ anchor_7227d563157 |
| herredsvejen | 362 | ✓ anchor_7227d563157 |
| herredsvejen | Poul Kragh | ✓ anchor_c0395884a7d |
| herredsvejen | Skanderborg Kommune, Teknik og Miljø | ✓ anchor_97f36f8b78f |
| herredsvejen | Lars Lykke Jensen | ✓ anchor_97f36f8b78f |
| herredsvejen | ca. 23 m | ✓ anchor_e1d16a1197c |
| herredsvejen | 41 fragmenter | ✓ anchor_8b631316cef |
| herredsvejen | 5.853 m2 | ✓ anchor_5a1c177ea58 |
| herredsvejen | 1300 m2 | ✓ anchor_9f47ea13623 |
| herredsvejen | SBM1695 | ✓ — |
| herredsvejen | Merete Schifter Bagge | ✓ — |
| herredsvejen | Nationalmuseet | ✓ — |
| herredsvejen | 13,5 m | ✓ anchor_68f25e6d447 |
| herredsvejen | K14 | ✓ — |
| herredsvejen | X233 | ✓ anchor_18313ce3b66 |
| herredsvejen | 6 x 4 mm | ✓ anchor_5d3db8876b9 |
| herredsvejen | AAR 33273 | ✓ anchor_63fdd9a6f47 |
| herredsvejen | AAR 33274 | ✓ — |
| hojbakkegaard | TAK 1177 | ✓ anchor_d850df38f5a |
| hojbakkegaard | 020214-65, -66 | ✓ anchor_83f13172419 |
| hojbakkegaard | Tom Giersing | ✓ anchor_51b6ddcfa56 |
| hojbakkegaard | Mette Brosolat Ohlsen | ✓ anchor_a76cdef2866 |
| hojbakkegaard | Lone Brorson | ✓ anchor_1b0366f3c39 |
| hojbakkegaard | Jan Poulsen | ✓ anchor_04f72452ee4 |
| hojbakkegaard | 2004-08-13 | ✓ anchor_143c9746911 |
| hojbakkegaard | 55.6702 N | ✓ — |
| hojbakkegaard | TAK 1178 | ✓ — |
| hojbakkegaard | 020214-67 | ✓ — |
| hojbakkegaard | 17. august 2004 | ✓ — |
| hojbakkegaard | ca. 210-250 e.Kr | ✓ anchor_1df768b7d8f |
| hojbakkegaard | 3950 BP | ✓ — |
| hojbakkegaard | ca. 400 e.Kr. | ✓ anchor_4cb663f7eac |
| hojbakkegaard | 32 | ✓ anchor_546040a3e1e |
| hojbakkegaard | 33 | ✓ — |
| hojbakkegaard | 2.20 meter | ✓ anchor_e183d0f5fc4 |
| hvissinge | TAK 1728 | ✓ anchor_a4fb0e662bb |
| hvissinge | Bo Jensen | ✓ anchor_e6a27f42262 |
| hvissinge | Linda Boye | ✓ anchor_b658d978bc5 |
| hvissinge | 20-06-2016 | ✓ anchor_b9626568d28 |
| hvissinge | 27-07-2016 | ✓ anchor_b27b10f35d8 |
| hvissinge | 267 | ✓ anchor_39bb0aa22e1 |
| hvissinge | 58 cm | ✓ anchor_942ba80df00 |
| hvissinge | Kurt Herskind | ✓ anchor_b27b10f35d8 |
| hvissinge | Hanus Jensen | ✓ anchor_5d9e995eec8 |
| hvissinge | Glostrup Kommune | ✓ anchor_b9626568d28 |
| hvissinge | TV Lorry | ✓ anchor_23b8da0efab |
| hvissinge | Morten Knudsen | ✓ anchor_773b5fe2c12 |
| hvissinge | år 1-400 | ✓ anchor_367c8a273ff |
| hvissinge | 29 | ✓ anchor_d30fc0e8717 |
| hvissinge | TAK 1729 | ✓ — |
| hvissinge | Bo Jansen | ✓ — |
| hvissinge | 05-09-2016 | ✓ — |
| hvissinge | Roskilde Kommune | ✓ — |
| hvissinge | cirka 173 cm | ✓ anchor_cc1c4dac3dd |
| hvissinge | 135 cm | ✓ anchor_0a1cae114ce |
| hvissinge | 172 cm | ✓ anchor_c1c385a8c88 |
| hvissinge | grav 12 | ✓ — |
| katrinesminde | SBM1116 | ✓ anchor_936759daa7a |
| katrinesminde | Merethe Schifter Christensen | ✓ anchor_f4cec97caf0 |
| katrinesminde | René D. Jensen | ✓ anchor_4d990a5f52f |
| katrinesminde | 13. oktober 2009 | ✓ anchor_868bd0498cb |
| katrinesminde | 2529 m2 | ✓ anchor_2c90234c21b |
| katrinesminde | 116 | ✓ anchor_5560879bdef |
| katrinesminde | 88 | ✓ anchor_5560879bdef |
| katrinesminde | 75,5 m | ✓ anchor_7bb2600dce8 |
| katrinesminde | 47 | ✓ anchor_61604d00261 |
| katrinesminde | ca. 83 kg | ✓ anchor_6b6d1414f14 |
| katrinesminde | Peter Jensen | ✓ anchor_e4405369f2b |
| katrinesminde | 26-11-2009 | ✓ anchor_e9d01929435 |
| katrinesminde | Adelgade 5 | ✓ anchor_f6cfd3b8c2c |
| katrinesminde | 7,73 % | ✓ anchor_797362f97eb |
| katrinesminde | SBM1117 | ✓ — |
| katrinesminde | Merethe Schifter Bagge | ✓ — |
| katrinesminde | 14. oktober 2009 | ✓ — |
| katrinesminde | Nationalmuseet | ✓ — |
| katrinesminde | Louise Søndergaard | ✓ anchor_868bd0498cb |
| katrinesminde | Anja Vegebjerg Jensen | ✓ anchor_868bd0498cb |
| katrinesminde | X44 | ✓ anchor_8e310c1ff1c |
| katrinesminde | X118 | ✓ anchor_ad6c01b6a27 |
| katrinesminde | X119 | ✓ — |


## LLM baseline (codex/gpt-5.6-luna@high, 38 per-record calls)

| model | accuracy@1 | correct abstain | wrong link | protocol failures | avg ms/claim |
|---|---|---|---|---|---|
| codex/gpt-5.6-luna@high | 128/133 | 49/49 | 5 | 0 | 1651 |

### Per-claim audit

| doc | claim | LLM pick |
|---|---|---|
| 1790-06-17-1 | Jean | ✓ anchor_ebb61fca35b |
| 1790-06-17-1 | New Orleans | ✓ — |
| 1790-06-17-1 | Marcel | ✓ anchor_ebb61fca35b |
| 1790-06-17-1 | environ 25 ans | ✓ anchor_49c796ee55f |
| 1790-06-17-1 | Lallemand | ✓ anchor_49c796ee55f |
| _smoke | 1234.56 | ✓ smoke-a4 |
| _smoke | 42 | ✓ smoke-a1 |
| _smoke | Copenhagen | ✓ — |
| _smoke | 1790-06-17 | ✓ smoke-a2 |
| _smoke | P. Madsen | ✓ smoke-a5 |
| age-related-disease | Age-related disease or disease-relate… | ✓ anchor_de57395d0c4 |
| age-related-disease | Katharina Fuchs | ✓ anchor_233d1ab87aa |
| age-related-disease | Jo Appleby | ✓ anchor_233d1ab87aa |
| age-related-disease | 10.1016/j.ijpp.2026.02.003 | ✓ anchor_6adfba012ee |
| age-related-disease | k.fuchs@ufg.uni-kiel.de | ✓ anchor_fdffe173700 |
| age-related-disease | University of Leicester | ✓ anchor_028b35c6855 |
| age-related-disease | Kiel University | ✓ anchor_1eeb7fa3207 |
| age-related-disease | Vanderbilt University Medical Center | ✓ anchor_f51c592e3bd |
| age-related-disease | Mississippi State University | ✓ anchor_78e15c3560d |
| age-related-disease | 60 % | ✓ anchor_4ab699d3e12 |
| age-related-disease | TA3 | ✓ anchor_4ab699d3e12 |
| age-related-disease | Kathryn E. Marklein | ✓ anchor_233d1ab87aa |
| age-related-disease | progeria | ✓ anchor_f0fb6b5010c |
| age-related-disease | International Journal of Paleopathology | ✓ anchor_dcaf435b4d3 |
| age-related-disease | Im Dol 2-6 | ✓ anchor_773ccee8569 |
| age-related-disease | 10.1016/j.ijpp.2026.02.004 | ✓ — |
| age-related-disease | Katherine Fuchs | ✓ — |
| age-related-disease | TA4 | ✓ — |
| age-related-disease | University of Oxford | ✓ — |
| age-related-disease | Aarhus University | ✓ — |
| brondbylund | TAK 1506 | ✓ anchor_4be8009e760 |
| brondbylund | Maria Lisette Jacobsen | ✓ anchor_772d564bd37 |
| brondbylund | ca. 1 år | ✓ anchor_3e88c36c6ac |
| brondbylund | 900 e. Kr. | ✓ anchor_e32d087632c |
| brondbylund | 18 | ✓ anchor_735960dfc73 |
| brondbylund | Lars Nissen | ✓ anchor_edc60e8a2e9 |
| brondbylund | Lind & Risør | ✓ anchor_5cd63a98820 |
| brondbylund | FHM 4296/2382 | ✓ anchor_76a638133bd |
| brondbylund | Brøndbyøster sogn | ✓ anchor_1449a8a3f1c |
| brondbylund | 5000 m2 | ✓ — |
| brondbylund | TAK 1507 | ✓ — |
| brondbylund | ca. 2 år | ✓ — |
| brondbylund | 19 | ✓ — |
| brondbylund | 542 g | ✓ anchor_b0152f15cb9 |
| brondbylund | 1200 f.Kr. | ✓ — |
| brondbylund | 543 g | ✓ — |
| brondbylund | 150 | ✓ — |
| catfish-collagen | Properties of Skin Collagen from Sout… | ✓ anchor_4b6b6143a77 |
| catfish-collagen | zhangxi@mail.hzau.edu.cn | ✓ anchor_cd670a8ada5 |
| catfish-collagen | +86-18672306015 | ✓ anchor_cd670a8ada5 |
| catfish-collagen | Carlos José Dias Pereira | ✓ anchor_281439a9f96 |
| catfish-collagen | 1 August 2024 | ✓ anchor_f781e0cbbe1 |
| catfish-collagen | 13 September 2024 | ✓ anchor_2c556afc880 |
| catfish-collagen | Hokkaido University | ✓ anchor_156d421e102 |
| catfish-collagen | takagi@fish.hokudai.ac.jp | ✓ anchor_156d421e102 |
| catfish-collagen | 6 weeks | ✓ anchor_7d5aa15172d |
| catfish-collagen | 27.09 ± 0.89 g | ✓ anchor_a986c2a37ab |
| catfish-collagen | 8.66 ± 0.11% | ✓ anchor_8aa33654155 |
| catfish-collagen | 61.78 ± 3.91% | ✓ anchor_8aa33654155 |
| catfish-collagen | SPSS Base 25 | ✓ anchor_58009cbd2db |
| catfish-collagen | GACGCTGTATGTGAAACGGC | ✓ anchor_8d86be60f2f |
| catfish-collagen | TATCTCCCCTTGGTCCCGAT | ✓ anchor_4faa09e9a48 |
| catfish-collagen | Nicolet IS50 | ✓ anchor_32cca9ee8ba |
| catfish-collagen | 12,000 × g | ✓ anchor_161b1292bbd |
| catfish-collagen | zhangxi@mail.hzau.edu.com | ✓ — |
| catfish-collagen | 8.66 ± 0.12% | ✓ — |
| catfish-collagen | col1a3-F | ✓ — |
| catfish-collagen | Kyoto University | ✓ — |
| catfish-collagen | 15 September 2024 | ✓ — |
| ellekilde | Grav 8 | ✓ anchor_540e94d0e16 |
| ellekilde | over 45 år | ✓ anchor_3b23e3358bf |
| ellekilde | jernspænde | ✓ anchor_3b23e3358bf |
| ellekilde | 1450 BP | ✓ — |
| ellekilde | 8-5 | ✓ — |
| ellekilde | 25-35 år | ✓ anchor_faa3abc3e1c |
| ellekilde | Yngre romersk jernalder per. C3 | ✓ anchor_64a5a183460 |
| ellekilde | Perle af mat rødligt glas | ✗ anchor_3f25b580fb3 |
| ellekilde | Lå mellem de to underarmsknogler (24-18) | ✗ anchor_a50f61fd724 |
| ellekilde | Yngre romersk jernalder per. C2 | ✓ — |
| ellekilde | 16-18 år | ✓ anchor_0f6b71abf27 |
| ellekilde | 15 | ✓ anchor_61cb7f12f88 |
| ellekilde | 2.8 x 1.3 meter | ✓ anchor_72d2d735426 |
| ellekilde | 17-18 år | ✓ — |
| ellekilde | Nationalmuseet i København | ✓ — |
| free-ports-hamburg | Free ports, political economy, and ea… | ✓ anchor_715a690ae19 |
| free-ports-hamburg | Esther Sahle | ✓ anchor_88f4fa65a5b |
| free-ports-hamburg | University of Copenhagen, Saxo Institute | ✓ anchor_f526f6d7993 |
| free-ports-hamburg | Cambridge University Press | ✓ anchor_bf89e84c6f5 |
| free-ports-hamburg | University of Oxford | ✓ — |
| free-ports-hamburg | Esther Sahler | ✓ — |
| free-ports-hamburg | 1591 | ✗ anchor_b771fc1a940 |
| free-ports-hamburg | Livorno | ✓ anchor_b771fc1a940 |
| free-ports-hamburg | 1592 | ✓ — |
| free-ports-hamburg | 159 | ✓ — |
| free-ports-hamburg | 1664 | ✓ anchor_e6b6e28c620 |
| free-ports-hamburg | 1706 | ✗ anchor_e1eee399279 |
| free-ports-hamburg | 1766 | ✗ anchor_f5591df0ed3 |
| herredsvejen | SBM1694 | ✓ anchor_fb53d73b0be |
| herredsvejen | Merethe Schifter Bagge | ✓ anchor_30e2ff5d0f8 |
| herredsvejen | 23-09-2019 | ✓ anchor_122c7838e35 |
| herredsvejen | 20. november 2019 | ✓ anchor_c20ee246bb9 |
| herredsvejen | 19/06370 | ✓ anchor_122c7838e35 |
| herredsvejen | 576 | ✓ anchor_7227d563157 |
| herredsvejen | 362 | ✓ anchor_7227d563157 |
| herredsvejen | Poul Kragh | ✓ anchor_c0395884a7d |
| herredsvejen | Skanderborg Kommune, Teknik og Miljø | ✓ anchor_97f36f8b78f |
| herredsvejen | Lars Lykke Jensen | ✓ anchor_97f36f8b78f |
| herredsvejen | ca. 23 m | ✓ anchor_e1d16a1197c |
| herredsvejen | 41 fragmenter | ✓ anchor_8b631316cef |
| herredsvejen | 5.853 m2 | ✓ anchor_5a1c177ea58 |
| herredsvejen | 1300 m2 | ✓ anchor_9f47ea13623 |
| herredsvejen | SBM1695 | ✓ — |
| herredsvejen | Merete Schifter Bagge | ✓ — |
| herredsvejen | Nationalmuseet | ✓ — |
| herredsvejen | 13,5 m | ✓ anchor_68f25e6d447 |
| herredsvejen | K14 | ✓ — |
| herredsvejen | X233 | ✓ anchor_5d3db8876b9 |
| herredsvejen | 6 x 4 mm | ✓ anchor_5d3db8876b9 |
| herredsvejen | AAR 33273 | ✓ anchor_63fdd9a6f47 |
| herredsvejen | AAR 33274 | ✓ — |
| hojbakkegaard | TAK 1177 | ✓ anchor_d850df38f5a |
| hojbakkegaard | 020214-65, -66 | ✓ anchor_83f13172419 |
| hojbakkegaard | Tom Giersing | ✓ anchor_51b6ddcfa56 |
| hojbakkegaard | Mette Brosolat Ohlsen | ✓ anchor_a76cdef2866 |
| hojbakkegaard | Lone Brorson | ✓ anchor_1b0366f3c39 |
| hojbakkegaard | Jan Poulsen | ✓ anchor_04f72452ee4 |
| hojbakkegaard | 2004-08-13 | ✓ anchor_143c9746911 |
| hojbakkegaard | 55.6702 N | ✓ — |
| hojbakkegaard | TAK 1178 | ✓ — |
| hojbakkegaard | 020214-67 | ✓ — |
| hojbakkegaard | 17. august 2004 | ✓ — |
| hojbakkegaard | ca. 210-250 e.Kr | ✓ anchor_1df768b7d8f |
| hojbakkegaard | 3950 BP | ✓ — |
| hojbakkegaard | ca. 400 e.Kr. | ✓ anchor_4cb663f7eac |
| hojbakkegaard | 32 | ✓ anchor_546040a3e1e |
| hojbakkegaard | 33 | ✓ — |
| hojbakkegaard | 2.20 meter | ✓ anchor_e183d0f5fc4 |
| hvissinge | TAK 1728 | ✓ anchor_a4fb0e662bb |
| hvissinge | Bo Jensen | ✓ anchor_e6a27f42262 |
| hvissinge | Linda Boye | ✓ anchor_b658d978bc5 |
| hvissinge | 20-06-2016 | ✓ anchor_b9626568d28 |
| hvissinge | 27-07-2016 | ✓ anchor_b27b10f35d8 |
| hvissinge | 267 | ✓ anchor_39bb0aa22e1 |
| hvissinge | 58 cm | ✓ anchor_942ba80df00 |
| hvissinge | Kurt Herskind | ✓ anchor_b27b10f35d8 |
| hvissinge | Hanus Jensen | ✓ anchor_5d9e995eec8 |
| hvissinge | Glostrup Kommune | ✓ anchor_b9626568d28 |
| hvissinge | TV Lorry | ✓ anchor_23b8da0efab |
| hvissinge | Morten Knudsen | ✓ anchor_773b5fe2c12 |
| hvissinge | år 1-400 | ✓ anchor_367c8a273ff |
| hvissinge | 29 | ✓ anchor_d30fc0e8717 |
| hvissinge | TAK 1729 | ✓ — |
| hvissinge | Bo Jansen | ✓ — |
| hvissinge | 05-09-2016 | ✓ — |
| hvissinge | Roskilde Kommune | ✓ — |
| hvissinge | cirka 173 cm | ✓ anchor_cc1c4dac3dd |
| hvissinge | 135 cm | ✓ anchor_0a1cae114ce |
| hvissinge | 172 cm | ✓ anchor_c1c385a8c88 |
| hvissinge | grav 12 | ✓ — |
| katrinesminde | SBM1116 | ✓ anchor_936759daa7a |
| katrinesminde | Merethe Schifter Christensen | ✓ anchor_f4cec97caf0 |
| katrinesminde | René D. Jensen | ✓ anchor_4d990a5f52f |
| katrinesminde | 13. oktober 2009 | ✓ anchor_868bd0498cb |
| katrinesminde | 2529 m2 | ✓ anchor_2c90234c21b |
| katrinesminde | 116 | ✓ anchor_5560879bdef |
| katrinesminde | 88 | ✓ anchor_5560879bdef |
| katrinesminde | 75,5 m | ✓ anchor_7bb2600dce8 |
| katrinesminde | 47 | ✓ anchor_61604d00261 |
| katrinesminde | ca. 83 kg | ✓ anchor_6b6d1414f14 |
| katrinesminde | Peter Jensen | ✓ anchor_e4405369f2b |
| katrinesminde | 26-11-2009 | ✓ anchor_e9d01929435 |
| katrinesminde | Adelgade 5 | ✓ anchor_f6cfd3b8c2c |
| katrinesminde | 7,73 % | ✓ anchor_797362f97eb |
| katrinesminde | SBM1117 | ✓ — |
| katrinesminde | Merethe Schifter Bagge | ✓ — |
| katrinesminde | 14. oktober 2009 | ✓ — |
| katrinesminde | Nationalmuseet | ✓ — |
| katrinesminde | Louise Søndergaard | ✓ anchor_868bd0498cb |
| katrinesminde | Anja Vegebjerg Jensen | ✓ anchor_868bd0498cb |
| katrinesminde | X44 | ✓ anchor_8e310c1ff1c |
| katrinesminde | X118 | ✓ anchor_ad6c01b6a27 |
| katrinesminde | X119 | ✓ — |
