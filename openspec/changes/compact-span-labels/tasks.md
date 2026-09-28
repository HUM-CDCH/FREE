# Tasks

## 1. Compact transport labels

- [x] 1.1 Use short span labels and version 2; verify exact proof identity, table context, filtered candidates, split batches and span-only fingerprints in focused tests.
- [x] 1.2 Verify legacy quoted/semantic requests and extraction tests remain unchanged; document implementation and validation boundaries in the dated report.

## 2. Tokenizer-only admission check

- [x] 2.1 Pin the revised code and original study inputs in a separate artifact directory, run generation-blocked admission checks on Hvissinge, Harvey, Age, Hamburg and Zelechowska, and verify every claim–unit comparison is attempted or explicitly refused.
- [x] 2.2 Save probe hashes and replay the check offline; publish paired admission, calls, prompt tokens and schema-size results with remaining quality gates. Preserve frozen R5 and the full-matrix deferral.

## 3. Review

- [x] 3.1 Review the final diff for unnecessary branches/options, run OpenSpec validation and push a reviewable change with its evidence.

Outcome: [draft PR #146](https://github.com/HUM-CDCH/FREE/pull/146), stacked on #145.
The tokenizer-only change is complete; fresh version 2 quality and the original
full study remain open in the parent plan.
