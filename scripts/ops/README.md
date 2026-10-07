# Shared Baratheon release tooling

`free-deploy` is shared by the existing operators through
`/usr/local/bin/free-deploy` and `/srv/free/ops/bin/free-deploy`. This directory
owns the implementation installed at `/srv/free/ops/bin/free-deploy.py`.
The host wrapper, personal Git SSH access, Compose overlays and secrets remain
host configuration. Run `pnpm test:ops` before changing the implementation.

## Verified source and images

Release retains its lock, clean-checkout, fast-forward, workflow-drain, backup
and protected-container checks. Before advancing source, it fetches the
annotated tag `free-verified/<full SHA>` with the operator's existing Git access.
The tag must target that SHA and contain the exact version-1 record for
`HUM-CDCH/FREE` with both `verify` and `verify-python` successful. Missing or
mismatched evidence refuses release before services change. The fetch preserves
the branch's `FETCH_HEAD`.

The trusted `dev` push workflow publishes this tag after both jobs pass. PR and
merge-group jobs never publish release evidence. Treat this namespace as
CI-owned: operators should not create these tags manually. This is repository
verification evidence, not a cryptographic signature. A feature branch can
release only a commit already carrying this evidence. Wait for the trusted
`dev` run for new commits. `deploy` checks its current clean commit too.

Every Compose rendering, build and startup receives revisions from the shared
`scripts/build-revisions.json` contexts, using the launcher's existing Git
revision contract. The host needs system Python and Git, with no Node runtime.
Built application images must
carry their expected context revision before any container stops. Running
labels are checked again after startup. Unknown, mismatched and dirty built
revisions are refused. `status` includes `image_revisions`. Existing protection
for model servers, PostgreSQL, nginx, Phoenix, Humanizer and volumes remains.

## Installing a reviewed update

After review and passing CI, back up the installed helper and check its SHA-256
still matches the inspected baseline. Replace it atomically with the reviewed
bytes, preserving owner, group and mode. Keep host configuration and the wrapper
in place. Check available operator profiles, then release a verified commit and
inspect health, revisions, data counts and protected container identities.
Record the backup and outcome in dated validation evidence.

## Focused verification

```sh
BARATHEON_SSH_CONFIG=/path/to/ssh/config scripts/baratheon-verify.sh <commit> test:unit:python
```

The helper passes that SSH configuration to both transports. This focused tier
installs the frozen Python environment without installing the Node workspace;
tracing, grammar and test dependencies are probed before tests start. The default
tiers and guarded disposable PostgreSQL setup remain.
