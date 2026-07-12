# Burial Finds — Ellekilde pages 7–12

This evaluation exercises the complete FREE path:

1. Parse `examples/Beretning_Ellekilde_8_13.pdf` through the parsing-service
   HTTP contract.
2. Send its canonical Markdown through Studio's `/api/extract` handler.
3. Compare the `Burial_Finds` extraction result with the manually reviewed
   semantic oracle.
4. Verify that every non-empty extracted value has verbatim evidence in the
   canonical Markdown.

## Oracle policy

`fundliste` contains only rows from tables explicitly introduced as
`Fundliste grav …` or `Fundliste til grav …`. Skeletal-part tables and
numbered grave equipment found only in prose are excluded. The source
contains seven graves and 33 authoritative fund-list rows.

Identifiers, Ark values, descriptions, and remarks are exact after Unicode
and whitespace normalization. `Fundplacering` is evaluated for source
grounding when present, but not for exact phrasing because it is a semantic
projection from remarks or surrounding prose.

The historical GPT and Gemini results under
`FREE-technical/extractions/schema=Burial_Finds` informed failure cases but
are not ground truth.

## Run

Select and install one parsing-service OCR profile, and ensure the evaluation
model is available:

```bash
pnpm install:cpu
ollama pull hf.co/numind/NuExtract3-GGUF:Q4_K_M
pnpm evaluate:burial-finds
```

The default evaluation uses an 8192-token context. Override the model, Ollama
endpoint, or context when needed:

```bash
EVALUATION_MODEL='hf.co/numind/NuExtract3-GGUF:Q4_K_M' \
EVALUATION_BASE_URL='http://127.0.0.1:11434' \
EVALUATION_CONTEXT_LENGTH=8192 \
pnpm evaluate:burial-finds
```

The run is intentionally separate from `pnpm test` because it loads Docling
and a live local model. Diagnostic artifacts are written to
`.artifacts/evaluations/burial_finds_ellekilde/` and are not committed.
