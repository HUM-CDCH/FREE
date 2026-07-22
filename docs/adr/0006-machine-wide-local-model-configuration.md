# Machine-wide local model configuration

FREE keeps Model Connections and Capability Routes machine-wide for one
humanities researcher rather than attaching them to Project Contexts. The
configuration API is available only through the loopback Studio process;
non-secret configuration persists in one versioned JSON document in the
operating system's user application-config directory, and credentials persist
only in the operating system credential store, with no plaintext or memory-only
fallback when secure storage is unavailable. Credential-store failure blocks
only FREE-managed credential operations; credentialless connections and
externally authenticated model harnesses remain usable. The saved configuration
is the sole model-configuration source: it replaces rather than imports or
overlays `AI_PROVIDER`, `AI_MODEL`, `AI_CHAT_MODEL`, `AI_BASE_URL`, and
`AI_API_KEY`. This boundary supports local Ollama and authenticated model
harnesses without introducing multi-researcher identity and secret management
into the prototype.

Custom Model Connections may use any researcher-supplied HTTP or HTTPS URL.
FREE displays the configured connection URL but adds no special remote-egress
warning or confirmation.

This decision applies to the local prototype served through the existing
TypeScript handlers and Vite development middleware. Hosted Vercel deployment
cannot provide the researcher's local provider processes, configuration file,
or operating system credential store and is therefore unsupported for runtime
model configuration. This change does not add a distributable production host.
