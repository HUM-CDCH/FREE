# Follow-ups

Tracked items deferred out of scope from completed changes. Each is independent
of the change that surfaced it.

## From `compose-model-features`

### 1. Rename `template` → Schema Suggestion across the surface

Per `CONTEXT.md` terminology, the `template` concept is the **Extraction Schema**
produced by **Schema Suggestion**. The code still uses `template` widely
(`/generate-template`, `TemplateParser`, `requestTemplate`, `TemplateState`,
`decodeTemplateDone`, …). A dedicated rename change should align the vocabulary
end-to-end (endpoint path, backend symbols, frontend state/decoders, tests).
