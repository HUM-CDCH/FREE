# Parsing Service

Read this directory's `README.md` and the root `docs/product-contract.md` before changing the
service, persistence, or verification. FREE Studio owns authentication, project
ownership, schemas and review; this internal service owns parsing, extraction,
canonical evidence, and its DBOS worker (`kei_exp.workflows`, schema `kei_dbos`,
its own restricted role). Keep the API and worker separate. Root Compose owns
deployment and model processes; Studio is the only web UI.

Preserve canonical page/manifest hashes, immutable parse generations and source
evidence identities. Extraction reads canonical results only; debug artifacts are
diagnostics. Keep database-backed and model-backed tests out of the fast test
command. Test databases must pass the explicit disposable-target guard before
connecting. A change to a workflow's steps goes behind `DBOS.patch()`
(`enable_patching` is on); `kei@1` changes only after draining.

Durable planning reads in turn, on one thread: a planning round never waits on
a model (each call replays its saved reply or is captured and raises
`NeedsCall`), and the workflow runs the captured calls in parallel. The threads
left in recipe chunks and discovery slices predate this (#233).
