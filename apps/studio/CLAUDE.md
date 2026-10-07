# Studio

## NuExtract on vLLM

Schema Suggestion's NuExtract protocol (`generateWithNuExtract` in
`api/_model_execution.ts`) drives NuExtract3 through its chat template, which vLLM
passes `chat_template_kwargs` to: `mode` selects the task and the document is
the only user message. Ollama's endpoints ignore `chat_template_kwargs`, so only
vLLM connections get the protocol.

Only `structured` mode has an `【instructions】` slot. Guidance for
`template-generation` must lead the document content in the message body.
Keep non-thinking requests at the characterized `0.2` temperature, and
`enable_thinking: false`, unless new provider evidence changes that contract.

## DBOS

- `server/dbos.ts` launches DBOS once per process; never call `DBOS.launch()` elsewhere, and never register a workflow at module import (the API dispatcher and several tests import every handler). `registerStudioWorkflows()` registers each workflow with an explicit `name` (bundlers rename functions).
- `@dbos-inc/dbos-sdk` stays external to the server bundle (`vite.server.config.ts`).
- A change to a workflow's step sequence goes behind `DBOS.patch()`; `studio@1` changes only after draining. Workflow inputs carry IDs, never keys or document text.
- The development host keeps the first DBOS launch across recompositions; after editing a workflow module restart Studio (Compose Watch does).
