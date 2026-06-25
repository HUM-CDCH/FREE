# NuExtract Request Construction and Prompt Assembly

**Status**: Accepted

NuExtract outbound requests (prompts) are constructed and formatted before reaching the local model. 

## Decided Design

- **Prompt Construction**: Outbound request/prompt construction is handled in TypeScript via the `renderNuExtractPrompt` helper inside [_model.ts](file:///c:/Users/arkan/.codex/worktrees/9bfd/FREE/prototypes/studio/api/_model.ts).
- **Prompt Structure**: Prompts are formatted directly into the raw NuExtract chat template using explicit tag markers (`【task】`, `【template_start/end】`, `【document_start/end】`).
- **Ollama Request Generation**: The formatted prompt and extracted page images are sent to Ollama's generation endpoint with `raw: true`, bypassing the OpenAI-compatible chat template layers and controlling the raw model output directly.
- **Source Context Separation**: The assembly of document inputs (collecting text/markdown or converting rasterized page images) is isolated within `documentContentParts` inside `_model.ts`, keeping it decoupled from prompt templates, instruction controls, and extraction schemas.

## TODOs

- **Multi-Provider Capability**: The intended future behavior is to support multi-provider capability, allowing other model serving frameworks to be integrated.
- **Integration Test Suite**: Introduce a slower test suite for verifying provider integration and prompt formatting that does not run automatically on every unit test iteration.


