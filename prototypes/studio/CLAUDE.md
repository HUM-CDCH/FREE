# Studio

## NuExtract on vLLM

Schema Suggestion's NuExtract protocol (`generateWithNuExtract` in
`api/_model.ts`) drives NuExtract3 through its chat template, which vLLM
passes `chat_template_kwargs` to: `mode` selects the task and the document is
the only user message. Ollama's OpenAI-compatible endpoint ignored those
kwargs, which is why an earlier raw `/api/generate` path rebuilt the control
tokens; that path is retired with Ollama.

Only `structured` mode has an `【instructions】` slot. Guidance for
`template-generation` must lead the document content in the message body.
Keep non-thinking requests at the characterized `0.2` temperature, and
`enable_thinking: false`, unless new provider evidence changes that contract.
