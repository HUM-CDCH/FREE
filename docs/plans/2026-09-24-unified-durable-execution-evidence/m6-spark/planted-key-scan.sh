#!/usr/bin/env bash
# On the Spark, from ~/Projects/FREE: KEY=<synthetic key> PROJECT=<compose project> COMPOSE="docker compose -f … -f …" bash planted-key-scan.sh
# Prints counts only; the dump and the logs stay in the pipe.
set -euo pipefail
: "${KEY:?}" "${PROJECT:?}" "${COMPOSE:?}"
for volume in studio-data studio-config studio-claude source-inbox parsing-runs; do
  docker volume inspect "${PROJECT}_${volume}" >/dev/null
done
dump=$($COMPOSE exec -T db pg_dump -U postgres free | awk 'index($0, ENVIRON["KEY"]) { n++ } END { print n+0 }')
files=$(docker run --rm -e KEY \
  -v "${PROJECT}_studio-data:/v/studio-data:ro" -v "${PROJECT}_studio-config:/v/studio-config:ro" \
  -v "${PROJECT}_studio-claude:/v/studio-claude:ro" -v "${PROJECT}_source-inbox:/v/source-inbox:ro" \
  -v "${PROJECT}_parsing-runs:/v/parsing-runs:ro" --entrypoint bash postgres:17 \
  -c 'set -euo pipefail; { grep -rlF -- "$KEY" /v || [ "$?" -eq 1 ]; } | wc -l')
logs=$($COMPOSE logs --no-color studio parsing_service parsing_worker 2>&1 | awk 'index($0, ENVIRON["KEY"]) { n++ } END { print n+0 }')
echo "pg_dump matches: ${dump}; volume files: ${files}; log lines: ${logs}"
