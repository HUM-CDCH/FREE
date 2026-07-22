# Explicit model provider adapters and discovery

FREE supports seven explicit Model Connection kinds: Ollama, OpenAI, Anthropic,
Google, Codex CLI, Claude Code, and generic OpenAI-compatible. The generic
adapter guarantees the broadly implemented `/v1/models` and
`/v1/chat/completions` contract rather than native OpenAI Responses behavior;
custom URLs for the other providers must preserve that selected provider's
native contract. Provider names, defaults, credential modes, and capabilities
live once in the backend provider registry and are returned to the configuration
page.

Researchers select only models reported by explicit discovery. Discovery is
advisory network observation, certifies availability rather than suitability
for a FREE capability, and never performs paid test generation. The last model
catalog and check result persist for offline display; a selected model that
later disappears remains selected but is marked unavailable and is never
silently replaced. Claude Code is the sole static-catalog exception because it
has no model-list operation: after authentication succeeds, FREE exposes the
CLI's documented `fable`, `opus`, `sonnet`, and `haiku` aliases.

All general model execution uses AI SDK v7. Resolving a general Capability Route
returns the SDK's `LanguageModel` directly rather than a FREE-owned generation
wrapper. Each provider adapter declares whether native schema-less JSON output
is supported so the shared generator can use it when available and use
JSON-only prompting otherwise. NuExtract's raw Ollama protocol remains the
explicit specialized execution profile.
