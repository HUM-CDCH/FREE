# Grounded numbered-catalogue segmentation and extraction: contract

Date: 2026-09-23. Status: accepted for implementation (milestone M0 of
the execution plan). Product decisions that
still need the researcher-facing owner are tracked in the OpenSpec change
`grounded-numbered-catalogue`; this
document fixes what the code relies on. Revised the same day after a four-round review with Codex (gpt-6-astra);
the agreed amendments are folded into §3–§8. It amends the
[model/ingest design](2026-09-14-kie-model-and-ingest-design.md) where §9 says so and leaves the
[canonical evidence design](2026-09-21-canonical-evidence-design.md) unchanged.

## 1. Scope and selection

The first structural segmenter supports **numbered catalogues**: records open at a line that starts with a
printed number (`31.`, `31a.`), grouped under headings, inside recognisable sections. Everything specific to
one catalogue family lives in a versioned **recipe** (`src/kei_exp/kie/recipes/<id>.json`); the algorithms
contain no PDF names, page counts, coordinates or German words.

Selection is explicit per Extraction: `options.catalog = {"recipe": "<id>@<version>"}` on
`POST /api/runs/{id}/extract`. Without it, Catalog keeps the existing generic model discovery; with it, record
boundaries come only from the recipe. A recipe failure never falls back to model discovery, and there is no
global toggle. FREE's default Catalog behaviour is unchanged until the product owner settles how a
researcher chooses a recipe (OpenSpec change, decision D1).

A recipe has two parts with two fingerprints:

- `structure`: entry marker, scoped-series marker, heading levels, section rules, label hints, glossary
  line syntax, context window, numbering tolerance. Segmentation depends only on this part.
- `bindings`: which schema fields are filled from structure (`entry_label` or a heading kind), listed by
  exact top-level field name. A binding whose field is absent from the approved schema is inactive and
  reported (`binding_unmatched`). Bindings enter the extraction fingerprint, never the segmentation one.

## 2. Evidence identity, offsets and geometry

- Segmentation and extraction name canonical segments `p{page}_s{index}`: the physical, one-based PDF page
  and the zero-based position in that page file's `segments`. This is the id FREE's anchors
  (`a_p{page}_s{index}`) are built from, so **no id is converted on the extraction path**.
- The book-page ids of `kie/evidence.py` (`p{unit}_s{n}`, one-based per unit) exist only inside the KIE
  CLI. `canonical_id(segment.source)` is the one resolver from them to the canonical id, through
  `EvidenceRef(generation, page, index)`. Internal `p2_s1` may be `p1_s3`; nothing assumes the strings agree.
- Every artifact binds the parse `generation` and `digest`. A reader refuses any artifact whose generation
  or digest differs from the parse it is used with; canonical text is never rewritten or renumbered.
- A **span** is `{segment, start, end}`: a half-open range of Unicode code points over the canonical
  `PageSegment.text`. Not Markdown bytes, not UTF-16. Normalised matching (NFKC, case fold, whitespace,
  hyphenation at line ends) keeps a map back to raw offsets and emits raw spans only.
- Geometry stays at the precision the parser measured. A span's visual evidence is its segment's
  `bbox_pt` with `precision: "segment"` (an engine block box) or `"input"` (a whole input, deliberately
  coarse). No box is ever derived by dividing a block box by characters. Finer geometry is M7.

## 3. The ordered view

`kie/extract/evidence.py` stays the one extraction view. Each `Passage` gains `unit` (0 for the PDF page,
else its book page), `crop`, `crop_order` and `crop_bbox_pt`. Reading order is the page-file order the
parser published (units ascending, crops by their cut `order`, blocks in engine order); the view checks that
order and reports disagreement rather than inventing a whitespace rule the parser does not need. The view refuses a
page whose segments name a unit or crop the page does not have, or that repeats a unit or crop ordinal: hashes prove
the bytes, not the placement. Every segment the engine did not read `ok` is kept as `withheld`, blank or not; only a
`skipped` segment with a recipe figure label is intentional, and any other makes processing incomplete.

A **line** is a maximal newline-free run of a passage's text, trimmed of surrounding whitespace, with its
raw offsets. Lines are source lines (`html_to_text` newlines), not printed lines: Surya's paragraph blocks
are often one line. Blank lines are not source intervals.

## 4. Roles, dispositions and coverage

Section rules switch the **region** (`catalogue`, `glossary`, `references`, `prose`, `index`, `lists`,
`excluded`). Every non-blank line receives exactly one **disposition**:

| role | meaning | owner |
| --- | --- | --- |
| `entry` | primary content of one block | the block |
| `heading` | a heading event or a section heading | the heading event, or none for a section heading |
| `glossary`, `reference`, `figure` | non-record material | none |
| `excluded` | accounted for, with `reason` (`furniture`, `region:prose`, `duplicate_observation`, …) | none |
| `unresolved` | not decidable by the recipe, with `reason` | none |

Only `entry` has an owner, and primary spans of different blocks never overlap. Context overlap confers no
ownership. This replaces the literal “every OCR line belongs to an entry” rule. `coverage.complete` is true
only when no line is `unresolved`, no start is ambiguous or an exception, no potential duplicate is left open, and
the page files' reading order nowhere contradicts the cut's own column order (`reading_order_issues`; reported,
never reordered, since ownership across a reversal is uncertain). A born-digital list item that prints no marker
at all lost its number (Docling keeps every list item's printed marker); it ends the open entry and stays
`unresolved` (`unnumbered_item`) until the next resolved start, while a bulleted item remains content.
Lines before the first resolved entry that no positive rule classifies stay `unresolved`; a catalogue heading later
in the source does not make them non-record material. Complete accounting is not
evidence that OCR read every printed entry.

## 5. Entries, numbering and headings

- A **start candidate** is a catalogue-region line whose beginning matches `structure.entry_marker`
  (named groups `number`, `suffix`). A number inside a line is never a candidate. Parser labels are hints:
  a `SectionHeader` that matches the marker is a candidate like any other line.
- Candidates are resolved over the whole document before any block is cut. Each takes one role: `entry`
  (identity strictly above the previous entry in its numbering scope), `list_item` (consecutive candidates
  numbered 1..k after an entry start, with no entry or exception between them) or `exception` (any candidate
  may be one). Feasible interpretations are those with the fewest exceptions; numbering gaps and jumps are
  diagnostics (`numbering_gap`, `numbering_jump`) that only rank the alternatives shown for review. A
  candidate's role is resolved only if it is the same in every feasible interpretation; otherwise it is an
  `ambiguous_start`. Exceptions and ambiguous starts make their lines `unresolved` until the next resolved
  start. An entry 1 followed by a candidate 1 keeps the list reading available. Printed labels and suffixes are
  preserved; identity is the frozen `(entry_no, entry_suffix)`; list items and exceptions go to
  `rejected_starts`; no text is discarded to satisfy `1..N`. Indentation does not separate nested finds from
  entries in the reference scan (both start at the column edge), so it is not used.
- A section whose rule says `numbering: restart`, and a line matching `structure.series_marker`
  (`a 1.`, `u 1.`), would need a scoped identity the frozen contract does not have: their lines are
  `unresolved` (`scoped_identity_unsupported`) until decision D4 specifies one.
- A block's primary content runs from its start line to the line before the next start, heading, section
  heading, unclassified heading or unresolved start, across crops, book pages and PDF pages. Furniture and
  figures in between are excluded without ending it. `continuation` is true exactly when its primary spans
  cross a crop (column) or a unit/page boundary; for native pages without crops only page crossings count.
- Context: up to `context.lines` lines on either side, each clipped to `context.max_chars` code points next
  to the boundary. Surya supplies no printed-line boundaries, so this bounded text window is the documented
  limitation.
- A **heading event** is a line matching a recipe heading level; its `value` group is the inherited value
  and its span the evidence. A heading clears every deeper level; a section heading clears all levels. A
  `SectionHeader`/`Title` line that matches no rule is `unresolved` (`unclassified_heading`) and makes all
  heading state uncertain until re-established, so no stale value is inherited through it. So does a whole
  short segment of any label that matches a recipe `heading_hint` (a region word) without matching a heading
  rule; every hint is reported so false positives can be inspected. A heading rule never matches beyond its
  length bound, so a long sentence that begins like a heading changes no state.

## 6. Glossary and duplicate observations

Glossary-region lines matching `structure.glossary_line` become `{key, expansion, key_span,
expansion_span}`; malformed lines and keys with conflicting expansions are diagnostics and are never used.
Extraction receives only entries whose key occurs as a bounded token in the entry, within a token
allowance.

A **duplicate observation** is a segment whose box lies in the overlap of two crops of one unit and whose
normalised text equals a segment of the other crop in that overlap. The later one in reading order is
`excluded` (`duplicate_observation`, naming the first) only when the pair is mutually unique: each segment's only
candidate is the other (equal normalised text, same unit, overlapping crops, page-point IoU ≥ 0.5). Segments with
several candidates are kept and reported as `potential_duplicate`, which leaves coverage incomplete. Equal text
anywhere else is repeated content. Canonical evidence is never deleted.

## 7. The segmentation artifact

Pure function `segment(view, recipe) -> Segmentation`; it calls no model and writes no file. Publication is
`<run>/segmentations/<fingerprint>/segmentation.json`, renamed into place by `kei_exp.files.publish`.

- `fingerprint = sha256(canonical_json({segmentation_version, generation, digest, structure}))`.
- `digest = sha256(canonical_json(namespace))`, the namespace being everything but `fingerprint`, `digest`
  and `report`.
- Load refuses: a missing or unparsable file, a fingerprint or digest that does not recompute, another
  generation/digest, a span outside its segment's current text or naming an unknown segment, overlapping
  primary ownership, and a disposition set that is not exactly one per non-blank line. A refused artifact
  is recomputed; OCR is never rerun for it.

```json
{
  "segmentation_version": 2,
  "fingerprint": "5d0f…", "digest": "a91c…",
  "generation": "20260921T151928.488808Z-547953a5", "parse_digest": "62bb…",
  "recipe": {"id": "numbered-catalogue-de", "version": 1, "structure_sha256": "0e7b…"},
  "blocks": [{"id": "b1", "entry_label": "31", "entry_no": 31, "entry_suffix": "",
              "primary_spans": [{"segment_id": "p3_s4", "start": 0, "end": 41}],
              "context_spans": [{"segment_id": "p3_s3", "start": 0, "end": 12}],
              "continuation": false, "heading_events": ["h1", "h2"]},
             {"id": "b2", "entry_label": "32", "entry_no": 32, "entry_suffix": "",
              "primary_spans": [{"segment_id": "p3_s4", "start": 42, "end": 77},
                                {"segment_id": "p3_s9", "start": 0, "end": 58}],
              "context_spans": [], "continuation": true, "heading_events": ["h1", "h2"]}],
  "heading_events": [{"id": "h1", "kind": "bezirk", "level": 1, "text": "Bezirk Halle",
                      "spans": [{"segment_id": "p3_s2", "start": 7, "end": 12}]}],
  "dispositions": [{"segment_id": "p3_s4", "start": 0, "end": 41, "role": "entry", "block": "b1"},
                   {"segment_id": "p3_s8", "start": 0, "end": 3, "role": "excluded", "reason": "furniture"}],
  "rejected_starts": [{"span": {"segment_id": "p3_s6", "start": 0, "end": 3}, "label": "1",
                       "reason": "nested_list"}],
  "glossary": [{"key": "Mbl.", "expansion": "Meßtischblatt",
                "key_span": {"segment_id": "p1_s20", "start": 30, "end": 34},
                "expansion_span": {"segment_id": "p1_s20", "start": 37, "end": 50}}],
  "diagnostics": [{"code": "numbering_gap", "detail": "33 missing between 32 and 34", "block": "b3"}],
  "coverage": {"complete": true, "lines": 212, "entries": 2, "unresolved": 0, "reading_order_issues": 0,
               "excluded": {"furniture": 1}, "roles": {"entry": 180, "heading": 3}}
}
```

## 8. Extraction result version 2

The recipe path writes `extraction_version: 2`. Article and generic Catalog keep writing version 1, which
stays readable unchanged. Version 2 keeps every version 1 field and adds the rest; FREE decodes both.

- One call per block (or per bounded window of an oversized block), seeing: the block's primary text,
  marked context, the approved schema minus structurally bound fields, the headings in force and the
  relevant glossary entries. No previous entry's text is carried; prompt state is bounded.
- The model returns **candidates**: `{value, quote, key, provenance}` per field, provenance `token` (value
  follows a key such as `Mbl.`), `positional` or `inherited`. Code locates `quote` in eligible text (primary
  spans; heading spans for `inherited`), maps normalised matches back to raw spans, checks the value is
  derivable from the quote and conforms to its field type. A candidate is **accepted** only when code can tie it
  to its field through an explicit machine-readable rule: a structural binding, or a recipe key rule (the value
  is located right after one of the field's declared keys, which selects the span independently of the model's
  quote) or position rule. A quote-supported assignment without such a rule is **proposed**: kept and reviewable,
  its accepted field `null`. A failed check is **rejected**. A key or glossary word appearing in a field's
  description never authorises a binding. Repeated matches are separate `alternatives`, never one multi-span value.
- Structurally bound fields never come from the model: `entry_label` is the block label with its marker
  span; a heading-bound field is the in-force heading's `value` with its span. Body text cannot overwrite it.
- Accepted values carry spans and provenance. A rejected candidate is kept under `rejected` with its reason
  and proposed spans, and its singular field is `null` in `records`. Verified candidates that disagree for
  one field (windows of one block) are `competitors`; the record holds `null` until an arbitration call over
  those candidates only chooses one or answers unresolved.
- `ungrounded` stays in the shape and is empty for record fields; document-level fields remain `unverified`.
- Budget: every call's rendered request is counted before it is sent with the served model's own tokenizer,
  pinned to the served model digest with its chat template and flags: for Ollama, rebuilt from `/api/show`'s
  vocabulary and merges (verified to match served prompt counts exactly, schema not injected, fixed template
  overhead measured on `/v1/chat/completions` with the real flags); for vLLM, its `/tokenize` endpoint. An
  unknown server or an unobtainable tokenizer refuses the recipe path before any call. `budget.input_tokens`
  (default 4096) covers instructions, schema, context, headings and glossary; `budget.output_tokens` is the reply
  allowance, and both must fit the server context. Oversized primary text is cut into mapped windows under one
  entry identity (at line boundaries, then whitespace, then code points, or refused), overlap visible to the
  later window, located values attributed to their owning source range and deduplicated by located span,
  separators never evidence. A schema that alone exceeds the budget is refused before any call
  (`schema_exceeds_budget`). A server-reported prompt count different from the count is `budget_count_mismatch`.
- The chat client retries without `response_format` only on a positively identified unsupported-capability error
  and records every attempt as its own call.
- `completeness` separates `processing` (no failed or truncated call, no refusal, no withheld engine failure,
  no reply that is not the requested object or omits a requested field, no count mismatch),
  `coverage` (segmentation complete), `grounding` (every accepted value verified) and `recall` (always
  `"unmeasured"` without labels).
  `complete` is their conjunction with no issue; no confidence number is derived from it.

```json
{
  "extraction_version": 2, "strategy": "catalog", "run_id": "…", "generation": "…", "digest": "…",
  "segmentation": {"fingerprint": "5d0f…", "digest": "a91c…",
                   "recipe": {"id": "numbered-catalogue-de", "version": 1, "structure_sha256": "0e7b…",
                              "bindings_sha256": "77aa…"},
                   "bindings": {"Katalognummer": "entry_label", "Kreis": "kreis"}, "bindings_unmatched": [],
                   "diagnostics": [{"code": "numbering_gap", "detail": "33 missing between 32 and 34",
                                    "block": "b3", "spans": [{"segment": "p4_s1", "start": 0, "end": 3}]}]},
  "budget": {"version": 1, "input_tokens": 4096, "output_tokens": 1024,
             "tokenizer": {"source": "ollama:/api/show", "model_digest": "500a1f06…", "template_tokens": 21}},
  "normalization": {"version": 1, "rules": ["glossary"]},
  "records": [{"Katalognummer": "31", "Fundort": null, "Kreis": "Köthen", "Fundart": "G", "Mbl": null}],
  "record_blocks": [{"block": "b1", "entry_label": "31"}],
  "evidence": [{"path": ["records", 0, "Kreis"], "segment": "p3_s2", "page": 3,
                "bbox_pt": [40.1, 90.0, 120.0, 101.0], "verbatim": true, "hits": 1, "linked_by": "structure",
                "spans": [{"segment": "p3_s2", "start": 6, "end": 12}], "alternatives": [], "provenance": "inherited",
                "key_spans": [], "heading": "h2", "precision": "segment", "raw": "Köthen", "normalized": null},
               {"path": ["records", 0, "Fundart"], "segment": "p3_s4", "page": 3,
                "bbox_pt": [40.1, 120.0, 300.2, 131.5], "verbatim": true, "hits": 1, "linked_by": "key",
                "spans": [{"segment": "p3_s4", "start": 60, "end": 61}], "alternatives": [], "provenance": "token",
                "key_spans": [{"segment": "p3_s4", "start": 56, "end": 59}], "heading": null,
                "precision": "segment", "raw": "G",
                "normalized": {"value": "Grab", "rule": "glossary",
                               "key_span": {"segment": "p1_s20", "start": 51, "end": 53},
                               "expansion_span": {"segment": "p1_s20", "start": 56, "end": 60}}}],
  "proposed": [{"path": ["records", 0, "Fundort"], "value": "Belleben", "quote": "Belleben", "key": null,
                "provenance": "positional", "spans": [{"segment": "p3_s4", "start": 4, "end": 12}],
                "alternatives": [], "window": 0, "raw": "Belleben"}],
  "rejected": [{"path": ["records", 0, "Mbl"], "value": 2457, "quote": "Mbl. 2457", "key": "Mbl.",
                "provenance": "token", "reason": "quote_not_in_entry", "spans": [], "alternatives": [],
                "window": 0}],
  "competitors": [],
  "ungrounded": [], "unverified": [],
  "coverage": {"complete": true, "unresolved": 0, "lines": 212, "reading_order_issues": 0},
  "completeness": {"processing": true, "coverage": true, "grounding": true, "recall": "unmeasured"},
  "complete": true, "issues": [], "calls": [], "tokens": {"input": 812, "output": 90}
}
```

## 9. Boundary labels and block-F1

The Phase 1 gate measures segmentation against reviewer labels (`kie/boundaries.py`). The unit is the
segmentation's own line: canonical segment id plus raw code-point range, bound to one parse generation and
digest. A label file (`labels_version` 1) lists every non-blank line of the labelled book pages `(page, unit)`
with the printed label of the entry that owns it or `null`; `31#2` tells two entries printed `31` apart. A file
is refused when its generation, a line's text, or its set of lines differs from the parse.

Matching `exact-line-set@1` (frozen): on the labelled pages a predicted block matches a gold block when both own
exactly the same set of lines. Printed labels are not part of the match; disagreements are listed. Precision
counts predicted blocks with a line on the labelled pages, recall the gold blocks, F1 their harmonic mean. A gold
block is a *boundary* block when it appears in more than one region (book page and column) or owns the first or
last entry line of a region it appears in; every other gold block is *interior*. The score also lists unmatched
blocks on both sides, line-role disagreements, unresolved lines by reason and every exception or diagnostic
there.

The sample is one book page from each of 20 consecutive strata, in reading order, of the pages on which the
segmentation put an entry or unresolved line. The draw is seeded and recorded. A pre-filled file carries the
segmenter's answer and the segmentation digest it came from, for a reviewer to correct; it scores its own
segmentation perfectly and is never a gold standard. `python -m kei_exp.kie.boundaries report|prefill|score`
reads the run and never writes into it.

## 10. Amendments and boundaries

- Model/ingest design §3.6: `HeadingEvent.kind` is the recipe's heading-level name and `level` its depth
  (was the fixed `bezirk | kreis`). The German recipe keeps those two names, so invariant 6 (“a new Bezirk
  clears the Kreis”) holds as the general rule that a heading clears every deeper level.
- Coverage (§4) replaces “every entry-eligible character is owned” with exactly one disposition per line.
- Source layout (plan M1): Studio chooses `page_source` `pdf` (single PDF pages, the default) or `ingest`
  (scanned two-page spreads) at upload, with optional gutter overrides. The parse recipe already records
  `page_source` and the ingest digest, which fingerprints the ingest configuration. Born-digital PDFs are
  always read natively page by page; the choice never sends them through the splitter.
- Not claimed by this contract: OCR completeness, extraction accuracy, calibrated confidence, sub-line
  geometry, or transfer to a second catalogue. Those are measured separately (plan M6–M10).
