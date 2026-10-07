# Parsing Service

Read this directory's `README.md` and the root `docs/product-contract.md` before changing the
service, persistence, or verification. FREE Studio owns authentication, project
ownership, schemas and review; this internal service owns parsing, extraction,
canonical evidence, and its DBOS worker (`kei_exp.workflows`, schema `kei_dbos`,
its own restricted role). Keep the API and worker separate.

`src/kei_exp` was imported from kei-exp commit
`93b9435c2b9a01a5424758d917c058fc79bbc159`. This directory now owns that code;
runtime and tests must not import from a sibling checkout. Root Compose owns
deployment and model processes. Do not restore the old `app/` parser or a second
web UI.

Preserve canonical page/manifest hashes, immutable parse generations and source
evidence identities. Never use debug artifacts as extraction inputs. Keep
database-backed and model-backed tests out of the fast test command. Test
databases must pass the explicit disposable-target guard before connecting.
A change to a workflow's steps goes behind `DBOS.patch()` (`enable_patching` is
on); `kei@1` changes only after draining.
