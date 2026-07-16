# Extraction parity fixtures

The production Extraction Schemas are copied verbatim from `FREE-technical`
commit `67ea4dc535a2ab674ed8c4b558068e13e7c2980d` and live at the same relative
paths under `prototypes/studio/schemas/`:

- `schemas/FieldReports/Burial_Finds.json`
- `schemas/JournalArticles/collagen_extraction.json`

Tests consume those production schemas directly. The smaller Markdown and JSON
files in this directory are deterministic inputs for the same pinned extraction
behavior and do not require a live model.
