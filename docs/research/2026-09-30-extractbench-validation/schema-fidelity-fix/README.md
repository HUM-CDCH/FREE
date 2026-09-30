# Schema-fidelity correction, 2026-09-30

Implementation: `b47a7b81` on `feat/extraction-research-harness`, following
budget-fix checkpoint `9b22bd3662c8680944fd57907d93d609e198c29a` and preserving
stacked base `16819c72cf1ef54bfdf73d4159c5ee65dce048f8`.
[Verification](verification.json) records the full implementation commit,
source/test hashes, dataset pins and measured verification usage.

**The earlier audit was wrong:** Illinois's `rate_basis` vocabulary is explicitly
declared in an enum, not only in prose. The audit supplied that incorrect premise
to Claude Code Fable 5.1. This supersedes the adapter conclusions in the
[sparring decision](../development-audit/sparring-decision.md) and
[protocol disposition](../development-audit/protocol-amendment.md).
Their withdrawn pilot, extra completeness gate and handwritten guidance remain
withdrawn. Historical consultations, results and manifests remain preserved.

## Evidence and correction

The pinned development schema at `/$defs/RateLine/properties/rate_basis` has ten
non-null string choices plus null. Its canonical enum SHA-256 is
`fa876b6fc5a3521164d10021c350159ae502963cce8caa14bee6973188a06d0f`;
the original-schema hash is
`fbfcad32aa415e0842b2df49c4aec9c91bc78521c7109882d50ddf9f4539e610`.
The snapshot, saved original schema and adapter-manifest pin agree.

The offline inventory decoded only the twelve selected development `data_schema`
fields: eight string enums across five schemas, all representable by FREE's
existing `allowedValues`. The old adapter removed them all. The correction
preserves their declared choices through references and nullable unions, using
the existing prompts and output constraints equally in A0–A3. Unsupported enum
shapes fail explicitly. It adds no extraction technique or handwritten labels.

Annotation format stays `extractbench-v1`; inference conversion is separately
versioned as `structural-string-enums-v2`. The scorer is unchanged. Source schemas
also contain 317 description keys, four formats and 79 default keys. Descriptions,
examples and defaults remain excluded because descriptions can contain answers
and locations. Legitimate field semantics lost with that prose remain unresolved;
this correction does not claim full official-protocol fidelity or leaderboard
comparability.

Re-preparation used the same twelve development PDFs and native parser, with
network disabled: ten documents ingested, the same two native-text failures.
All source/parser/original-schema pins matched. Five inference schemas changed;
gold values, field rules, repeated structure and original schemas did not.
Annotation files differ only in `annotations.source.inference_schema_sha256`.
Ten gold-as-prediction round trips scored 1.0 raw/canonical; these check adapter
and scorer consistency, not model quality.

## Verification and interpretation

The final offline suite passed **198 tests**. Ten new adapter regression cases
failed before the correction. The same pinned local Qwen provider passed all
three live smoke tests, including one synthetic example in each A0–A3 arm:
eight fresh calls, 1,450 input / 1,031 output tokens, no unknown usage, 134.761
seconds total wall time. Smoke verification is separate from the closed
development study. No new benchmark, OCR or tokenizer request was made, and all
eight held-out groups remain unopened. All 107 frozen continuation files matched.

At the user's request, GPT-6-astra independently inspected the diff and sanitized
inventories as a read-only sparring partner. It found no blocking defect in the
eight audited enum shapes and agreed this is task-fidelity work. Its consultation
is not a benchmark result. It challenged any claim that this establishes better
extraction, an error floor, or production suitability; none is adopted.

Production defaults remain unchanged. There are still **13/48 historical scored
development cells**, three complete four-arm groups, no selected challenger and
no new quality comparison. The old scores describe the old schema policy. All
three smoke schemas changed: pairing old-policy A0 with a new-policy challenger
would confound the comparison. The correction does not resolve truncation,
record/section semantics, native-text failures or transfer to FREE catalogues.
Current defaults with human review remain the interim workflow; their superiority
has not been established.

## Next bounded comparison

A new study identity must pin this revision and the new dataset/schema hashes
for every arm. Preserve the original model, parser, decoding, recovery, scoring,
population and A0–A3 deltas. Begin again with the three registered development
smoke groups, compare matching A0–A3 inputs, then proceed only if ingestion,
scoring and the newly agreed resource limits pass. Report partial/unrun cells
explicitly. Do not combine changed-input caches or scores with historical pairs.
The cumulative-budget repair remains in force.

Fresh wall-clock and call caps are required before benchmark execution: the
original two-hour run is closed and the original prompt forbids expanding its
budget. No execution is authorized by this note. Challenger selection and a
single separately authorized paired holdout comparison remain governed by the
[final protocol proposal](../final-protocol-proposal.md). FREE suitability also
requires the existing [human-gold plan](../../2026-09-30-extraction-harness-methods.md);
public benchmark results alone cannot close the catalogue-transfer gap.

## Reproduction

From this worktree's `prototypes/parsing_service`, using the locked experiment
environment and already pinned JSONL cache:

```bash
export PYTHONPATH=src:.
export HARNESS_PYTHON=/home/gebbaro/Progetti/FREE/prototypes/parsing_service/.venv/bin/python
"$HARNESS_PYTHON" ../../docs/research/2026-09-30-extractbench-validation/schema-fidelity-fix/audit_schema_fidelity.py \
  ../../docs/research/2026-09-30-extractbench-selection.json \
  ../../.scratch/extractbench-source ../../.scratch/schema-inventory-repeat.json
"$HARNESS_PYTHON" -m pytest -q tests/test_harness_*.py tests/test_extract_schema.py \
  ../../docs/research/2026-09-30-extractbench-validation/development-continuation/test_run_bounded.py \
  -m 'not live_model' --basetemp=/tmp/extractbench-enum-repeat
```

The inventory refuses checksum mismatches and existing output files; it never
decodes gold or held-out schemas and writes only identifiers, counts and hashes.
Re-prepare into a fresh ignored output directory with the original
[selection](../../2026-09-30-extractbench-selection.json), pre-seeding `pdfs/`
with symlinks to the already verified development PDFs. The existing
`python -m experiments.harness extractbench SELECTION SNAPSHOT OUTPUT` adapter
command then regenerates the dataset without changing historical files. Network
was disabled during recorded re-preparation. The live reproduction recipe is in
the [budget-fix report](../budget-fix/README.md); this revision has three tests
and the recorded wrapper enforced eight calls, 3,592 maximum combined output
tokens and twelve minutes. Reproduction commands do not grant new spending.
