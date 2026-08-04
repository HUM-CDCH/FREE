# Machine-wide local model configuration

FREE keeps Model Connections and Capability Routes machine-wide for one humanities researcher rather than attaching them to Project Contexts. Non-secret configuration persists in one JSON document in the operating system's user application-config directory, and credentials persist only in the operating system credential store, with no plaintext, environment, file, or memory-only fallback when secure storage is unavailable.

The saved document is the sole model-configuration source. A fresh installation is unconfigured. A malformed document fails closed and remains unchanged for manual recovery. Credential-store failure blocks only operations requiring a FREE-managed credential; credentialless connections and externally authenticated model harnesses remain usable.

The Model Connection page owns one editable draft. Apply submits that complete draft and explicit write-only credential changes once. JSON replacement is atomic, but JSON and the operating system credential store are not transactionally coordinated. Failed saves remain retryable; credentials left by a removed UUID are inert.

Custom Model Connections may use any valid researcher-supplied HTTP or HTTPS provider API base without embedded userinfo, query, or fragment. FREE displays the configured base and relies on the researcher's explicit route selection without adding a special remote-egress warning or confirmation.

This decision applies only to the source prototype served with Vite's implicit localhost default. Non-loopback exposure is unsupported rather than prevented; Studio adds no socket, Host, or Origin guard. Hosted deployment cannot provide the researcher's local provider processes, configuration file, or operating system credential store and is unsupported. This change does not add a distributable production host.
