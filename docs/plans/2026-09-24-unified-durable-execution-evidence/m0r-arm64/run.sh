#!/usr/bin/env bash
# Run the staged M0R 1 probes entirely in throwaway containers. Nothing is
# published on the host: the probe containers join the disposable PostgreSQL
# container's network namespace, so 127.0.0.1:5432 inside them is that server.
# Usage (from the staged directory): bash run.sh    Logs go to ./logs.
set -uo pipefail
dir="$(cd "$(dirname "$0")" && pwd)"
ts="$(date +%s)"
pg="free-m0r-arm64-pg-$ts"
node_img="${NODE_IMAGE:-node:24}"
uv_img="${UV_IMAGE:-ghcr.io/astral-sh/uv:python3.13-bookworm}"
pg_img="${PG_IMAGE:-postgres:17}"
user="$(id -u):$(id -g)"
mkdir -p "$dir/logs"
cleanup() {
  docker ps -aq --filter "name=^free-m0r-arm64-.*-$ts\$" | xargs -r docker rm -f >/dev/null
}
trap cleanup EXIT

# node_run NAME WORKDIR CMD...; joins $NET when set.
node_run() {
  local name="$1" wd="$2"; shift 2
  docker run --rm --name "free-m0r-arm64-node-$name-$ts" --user "$user" \
    -e HOME=/tmp -e npm_config_cache=/tmp/.npm -e FREE_REVIEW_ROOT=/w/free-root \
    -v "$dir:/w" -w "$wd" ${NET:+--network "$NET"} "$node_img" "$@"
}

set -e
NET=
node_run npm-probes /w/probes npm install --ignore-scripts --no-audit --no-fund --save-exact \
  @dbos-inc/dbos-sdk@5.1.10 @dbos-inc/vercel-ai@0.4.4 ai@7.0.93 pg@8.22.0 > "$dir/logs/npm-probes.log" 2>&1
node_run npm-db /w/free-root/packages/db npm install --ignore-scripts --no-audit --no-fund --save-exact \
  @prisma-next/postgres@0.16.0 > "$dir/logs/npm-db.log" 2>&1

docker run -d --name "$pg" \
  --mount type=tmpfs,destination=/var/lib/postgresql/data \
  -e POSTGRES_USER=postgres -e POSTGRES_PASSWORD=review-disposable-only \
  -e POSTGRES_DB=free_test_dbos_review "$pg_img" >/dev/null
for _ in $(seq 1 30); do
  docker exec "$pg" pg_isready -U postgres -h 127.0.0.1 >/dev/null 2>&1 && break
  sleep 1
done
docker exec "$pg" pg_isready -U postgres -h 127.0.0.1
docker exec "$pg" createdb -U postgres free_test_dbos_races
docker exec "$pg" createdb -U postgres free_test_dbos_version
set +e

{
  echo "arch=$(uname -m)"
  echo "node=$(node_run ver /w node -p 'process.version+" "+process.arch')"
  echo "postgres=$(docker exec "$pg" psql -U postgres -Atc 'select version()')"
} > "$dir/logs/versions.log"

NET="container:$pg"
for p in probe admission-races stream-probe version-probe; do
  node_run "$p" /w/probes node "$p.mjs" > "$dir/logs/$p.log" 2>&1
  echo "EXIT=$?" >> "$dir/logs/$p.log"
done
docker run --rm --name "free-m0r-arm64-uv-$ts" --user "$user" --network "$NET" \
  -e HOME=/tmp -e UV_CACHE_DIR=/tmp/uv -e UV_PYTHON_DOWNLOADS=never -v "$dir:/w" "$uv_img" \
  sh -c 'uv run --no-project --python 3.13 --with "dbos==3.1.0" python -c "import importlib.metadata as m, platform, sys; print(\"python\", sys.version.split()[0], platform.machine(), \"dbos\", m.version(\"dbos\"))" && uv run --no-project --python 3.13 --with "dbos==3.1.0" python /w/probes/queue_probe.py' \
  > "$dir/logs/queue_probe.log" 2>&1
echo "EXIT=$?" >> "$dir/logs/queue_probe.log"
