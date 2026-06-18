# Spark Ollama Feedback Prototype

Question: can an agent quickly try NuExtract3 Ollama settings against the KU
Spark host and inspect the full request/result state after each run?

Status: disposable prototype. Delete it or fold the useful request-shaping
behavior into the real provider layer after the feedback loop is no longer
needed.

Important constraint: this uses `ollama-python`, which calls Ollama's native
API. It does not send OpenAI-compatible `chat_template_kwargs`; the prototype
duplicates NuExtract controls in the user prompt and sweeps native Ollama
`options` plus `think`.
