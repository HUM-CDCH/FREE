<!-- markdownlint-disable MD013 -->

# Focused Ollama probe evidence

## Scope

These focused probes inform the `parsed_document.v2` interface; they are not benchmark claims and do not implement Studio orchestration. They test whether model-visible page markers and stable block IDs are useful proposal inputs while preserving deterministic parser authority.

## Environment and request shape

- Probe date: 2026-08-03
- Base URL: `http://spark.cdch-dgxspark.lan.ku.dk:11434/`
- Ollama `/api/version`: `0.30.6`
- Model: `hf.co/numind/NuExtract3-GGUF:Q4_K_M`
- Supplied model digest: `51cdf1189a0fe5fce8b042c7f6f54c69dc132842fb4d5c8e3d09f0fbb6ccf712`
- Quantization reported by `/api/show`: `Q4_K_M`
- Temperature: `0.2`

Each request reproduced `prototypes/studio/api/_model.ts`'s structured raw shape: hand-built `<|im_start|>` control text, `【task】structured`, pretty-printed JSON between `【template_start】` and `【template_end】`, instructions between the structured-only instruction tokens, text between the document tokens, the non-thinking assistant prefix, and Ollama body fields `raw: true`, `stream: false`, and `options.temperature: 0.2`. No `chat_template_kwargs` were used.

## Reproduced synthetic probes

### Plain separator does not provide page identity

Document facts `amber` and `cobalt` were separated by `---`. Prompt SHA-256 was `ed720ece1975a25ebde9df147ffd2cba146cb0628f2e6f1e3f069557ece02c11`.

```json
{
  "facts": [
    {
      "name": "amber",
      "_evidence": { "name": { "snippet": null, "page": null } }
    },
    {
      "name": "cobalt",
      "_evidence": { "name": { "snippet": null, "page": null } }
    }
  ]
}
```

The values were extracted, but both proposed pages were null. This supports treating `---` as ordinary Markdown rather than page metadata.

### Reserved markers provide page identity

The same facts were preceded by `<!-- FREE:PAGE 1 -->` and `<!-- FREE:PAGE 2 -->`. Prompt SHA-256 was `85e374460c8cd17eeb748e91300aa2b2eff8fd0b6a1b36dbdd0a3cbb0e6d7d18`.

```json
{
  "facts": [
    {
      "name": "amber",
      "_evidence": { "name": { "snippet": null, "page": 1 } }
    },
    {
      "name": "cobalt",
      "_evidence": { "name": { "snippet": null, "page": 2 } }
    }
  ]
}
```

The proposed pages were correct while snippets remained null. This supports freezing an explicit canonical marker, but also shows that a page proposal does not make model Evidence complete or canonical.

### Stable block IDs distinguish repeated headings

Two identical `# Grave` headings had distinct visible start block IDs. Prompt SHA-256 was `19adaca11a1a7e43a09b7379841dee3c6ec299edaeceac9431c766b288527df5`.

```json
{
  "records": [
    { "heading": "Grave", "start_block_id": "b001", "end_block_id": "b002" },
    { "heading": "Grave", "start_block_id": "b003", "end_block_id": null }
  ]
}
```

The textual headings were identical but the selected starts were distinct and exact. The first selected end was not the next record's start (`b003`); it was off by one at `b002`. Stable block IDs therefore improve proposal identity, but downstream half-open range validation or derivation must remain deterministic Studio work.

## Preliminary real-document observations

Earlier focused observations, retained as preliminary rather than benchmark results, were:

- FREE-technical Grav 26 Markdown yielded all 17 fund rows, while every snippet and page was null.
- A synthetic split table using `---` yielded all values and null pages.
- The same input using `<!-- FREE:PAGE n -->` yielded all values and correct pages.
- A block-summary probe selected exact start block IDs.
- Repeated textual headings produced identical textual start markers while block IDs remained distinct.
- One model-selected end block was off by one.

Raw artifacts for those earlier runs are not in this change, so only the synthetic results above were reproduced in this session.

## Design consequences

1. Canonical Markdown uses exactly `<!-- FREE:PAGE n -->`; source collision fails stably rather than modifying source text.
2. `---` carries no page identity.
3. Canonical deterministic block IDs are the identity mechanism for repeated text; text alone is not unique.
4. Model pages, snippets, and block selections are proposals. They never create or mutate parser anchors.
5. Studio later validates or derives ranges deterministically from canonical block order; model-selected end points are not authoritative.
6. Table continuation remains entirely deterministic parser work. None of these probes justify LLM-based continuation inference.
