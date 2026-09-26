#!/usr/bin/env bash
# Stage the M0R 1 probes plus the minimal FREE files they import into a
# self-contained directory. Run from the FREE repository root:
#   bash docs/plans/2026-09-24-unified-durable-execution-evidence/m0r-arm64/stage.sh "$DEST"
# Layout: $DEST/probes (probe scripts, unmodified), $DEST/free-root (a
# FREE_REVIEW_ROOT stand-in holding only the disposable-target guard, the Prisma
# Next contract and a minimal db package), $DEST/run.sh.
# fk-probe.mts is not staged: it needs the pre-cutover checkout and migrations.
set -euo pipefail
dest="${1:?usage: stage.sh DEST}"
ev=docs/plans/2026-09-24-unified-durable-execution-evidence
mkdir -p "$dest/probes" "$dest/free-root/packages/db/src/prisma"
cp "$ev"/probe.mjs "$ev"/admission-races.mjs "$ev"/stream-probe.mjs \
   "$ev"/version-probe.mjs "$ev"/queue_probe.py "$dest/probes/"
cp packages/db/src/database-url.ts "$dest/free-root/packages/db/src/"
cp packages/db/src/prisma/contract.json "$dest/free-root/packages/db/src/prisma/"
printf '{"name":"db","private":true,"type":"module"}\n' \
  > "$dest/free-root/packages/db/package.json"
printf '{"name":"free-m0r-probes","private":true}\n' > "$dest/probes/package.json"
cp "$ev/m0r-arm64/run.sh" "$dest/run.sh"
