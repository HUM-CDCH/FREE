# Windowed Schema Suggestion on a Beier extract — 30 September 2026

Status: real-model probe of `feat/schema-suggestion-windows` on the Spark's vLLM. The full 45-page catalogue was not
run; the upload was the 3-page extract `Beier1988_GAC_02_Catalogue-001-001.pdf`.

## Setup

- Source: Spark Source Representation Revision `995884e7-c8e9-487d-8dba-b52bdffcc31d` (3 physical pages, 39,729 bytes
  of canonical Markdown; entries 128–133 and 205–228).
- Model: `Qwen/Qwen3.8-27B-FP8` on the Spark's `extraction_model` vLLM (`max_model_len` 32768), reached through an SSH
  tunnel; the branch's own `generateSchemaWithModel`, `reduceSchemas` and `combineSchemas`, called outside DBOS.
- Researcher instruction: "One record per complete catalogue entry; lettered subentries stay within their parent entry.
  Exclude summary lists, the findspot index, the bibliography and figure captions."
- The extract fits one 48,000-character window, so production sends it in one call. To exercise the union, the probe
  also cut it with the same algorithm at 12,000 characters: 4 windows and one union.

## Results

| Run | Calls | Time | Top-level fields |
| --- | --- | --- | --- |
| One call (production path for this size) | 1 | 40 s | entry_number, location, findspot_type, findspot_description, finds, museum_collection, bibliography, notes |
| 4 windows + union, instruction forwarded to the union | 5 | 209 s (25–57 s per call) | entry_number, location, feature_type, description, finds, deposits, skeletal_remains, museum_reference, notes |
| Same windows, union without the instruction | 1 union | ~60 s | … as above plus storage, literature_references |

Forwarding the researcher instruction to the union dropped the per-entry references field in 2/2 runs, and still in 2/2
with a milder wording ("never leave out a supplied field because of it"): the document-scope exclusion "the
bibliography" was read as excluding the field. Without it the union kept `literature_references` and `storage`, and
its `_description` still carried the exclusions inherited from the window suggestions. The branch therefore sends the
instruction to the windows only.

Against Schema Revision 6's six fields: catalogue label (`entry_number`, integer: right for this extract's numeric
labels, wrong for the full catalogue's `u1`/`a29`), locality/findspot (`location`), find description
(`description`/`finds`), museum/inventory (`museum_reference`, a string rather than a repeated list), references
(`literature_references`, a string rather than a repeated list); FA codes do not occur in this extract.

## Not established

The full catalogue (≈535k characters, ≈12 windows), multi-level unions, explicit field exclusions in the instruction,
and lettered-subentry scope on the `u`/`a` entries.

## Follow-up

Without the researcher instruction, the union's `_description` kept the exclusions but dropped "lettered subentries stay
within their parent entry", which the single call and the instruction-fed union kept. The researcher still edits the
Record description before extracting (as Schema Revision 6 did); if suggested descriptions keep losing record-scope
rules, add a separate call that writes only `_description` from the researcher instruction and the window descriptions,
applied to that key alone so it cannot remove fields.
