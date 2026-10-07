# 0013: Model configuration belongs to each Researcher Account; keys stay in the researcher's browser

Date: 2026-09-26. Status: accepted; supersedes
[0006](0006-machine-wide-local-model-configuration.md); amends
[0007](0007-two-explicit-model-capability-routes.md) and
[0011](0011-one-model-configuration-page.md). Implemented in M2–M4 of
the DBOS plan.

## Context

0006 kept one machine-wide configuration for one researcher on localhost,
with credentials in the operating system's keyring, and called a hosted
deployment unsupported. FREE now runs hosted for several researchers. Any
signed-in researcher could re-point the routes everyone's documents were sent
to, and the container's keyring needed D-Bus and an empty-password unlock.

## Decision

- Each Researcher Account owns one configuration in PostgreSQL: its Model
  Connections, its Interaction Route (the page's *Assistant model*) and
  Schema Suggestion Route, its Extraction Model Choice and its Ingestion
  Model Choice. A Project Context uses its owner's configuration. Every model
  call, background work included, resolves the owner's configuration when it
  starts; workflows carry only IDs.
- An unset Interaction Route runs on the deployment's instruction model. An
  unset Schema Suggestion Route follows the Interaction Route. The NuExtract
  protocol is used exactly when the connection is vLLM and the model is
  NuExtract; it is never stored or chosen.
- Keys never enter Studio's storage. The page keeps each key in the browser's
  `localStorage`, under the signed-in account and bound to the connection and
  its API base, and sends it with `PUT /api/model-keys`, which checks the
  account. Studio keeps the key only in memory and reads it inside each
  provider attempt. A connection records only whether it uses a key. After a
  Studio restart the next request from an open page resends the keys;
  background work with no page open fails with `model_key_required` and is
  retried by the researcher.
- Deployment connections are operator-defined, read-only and shared by every
  researcher: the vLLM servers (`FREE_DEPLOYMENT_*`) and the Codex CLI and
  Claude Code providers the operator enables with
  `FREE_DEPLOYMENT_CLI_PROVIDERS`, which run on the server's own CLI login.
  Researchers cannot define a CLI connection.
- The Ingestion Model Choice picks the Parsing Service's OCR and layout
  models for new ingestions and reprocessing. Admission freezes it into the
  workflow input; existing revisions never change.
- Validation on write keeps the stored configuration valid, so there is no
  reset.

## Consequences

- Keys are safe from database dumps, backups and passive access; not from an
  operator who changes Studio's code, and not from a script injected into
  Studio's origin, which the app shell's strict Content-Security-Policy
  guards against.
- Keys are entered once per browser. Accounts that share one browser profile
  share its storage.
- Researcher-supplied API bases stay allowed, as before; an allowlist is out
  of scope.
- A shared CLI login runs every researcher's calls on the operator's billing
  and rate limits.
