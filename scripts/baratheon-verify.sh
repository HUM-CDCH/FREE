#!/usr/bin/env bash
# Verify one commit on Baratheon (DGX Spark): bundle it over, run the tiers, print a summary.
#
#   scripts/baratheon-verify.sh <commit> [tier...]
#
# A tier is one of the root pnpm scripts typecheck lint test test:safety test:postgres
# test:e2e test:service (the default set) or test:system, or `live`: the durable-service
# real provider and live results cases against the deployed Qwen and GLiFormer models.
# Each run's evidence, with its tiers and final status, stays on Baratheon in
# ~/Projects/FREE-verify-<sha8>/artifacts/baratheon-verify/<UTC timestamp>.
# Runs take hours and an ssh drop stops them; start this in the background.
set -euo pipefail
host=${BARATHEON_HOST:-baratheon}
[[ $host =~ ^[a-zA-Z0-9][a-zA-Z0-9._@-]*$ ]] || { echo 'Invalid BARATHEON_HOST' >&2; exit 2; }
ssh_options=()
if [ -n "${BARATHEON_SSH_CONFIG:-}" ]; then
  [ -r "$BARATHEON_SSH_CONFIG" ] || { echo 'BARATHEON_SSH_CONFIG must name a readable file' >&2; exit 2; }
  ssh_options=(-F "$BARATHEON_SSH_CONFIG")
fi
defaults=(typecheck lint test test:safety test:postgres test:e2e test:service)
# Other root scripts (test:postgres:node, test:all, ...) would skip the database provisioning below.
supported=" ${defaults[*]} test:unit:python test:system live "
usage="usage: $0 <commit> [tier...]; tiers:${supported}(default: ${defaults[*]})"
[ $# -ge 1 ] || { echo "$usage" >&2; exit 2; }
for tier in "${@:2}"; do
  [[ $supported == *" $tier "* ]] || { echo "Unsupported tier '$tier'. $usage" >&2; exit 2; }
done
sha=$(git rev-parse --verify "$1^{commit}")
shift
[ $# -gt 0 ] || set -- "${defaults[@]}"
ref=refs/baratheon-verify/${sha:0:8}-$$-$RANDOM
bundle=$(mktemp --suffix=.bundle)
# Per invocation, so concurrent runs for one commit don't overwrite each other's upload.
remote_bundle=/tmp/free-verify-${sha:0:8}-$$-$RANDOM.bundle
trap 'git update-ref -d "$ref"; rm -f "$bundle"' EXIT
git update-ref "$ref" "$sha"
git bundle create -q "$bundle" "$ref"
scp "${ssh_options[@]}" -q "$bundle" "$host:$remote_bundle"

# Quoted heredoc: everything below expands on Baratheon, whose $HOME differs from ours.
ssh "${ssh_options[@]}" -o ServerAliveInterval=60 "$host" bash -s -- "$sha" "$remote_bundle" "$ref" "$@" <<'REMOTE'
set -uo pipefail
sha=$1 bundle=$2 ref=$3
shift 3
short=${sha:0:8}
tiers=("$@")
# Until the lock is held only the bundle is ours; the test databases belong to the run holding it.
trap 'rm -f "$bundle"' EXIT
# A signal must not reach the EXIT trap as status 0 (an interrupted run is never a pass).
trap 'exit 129' HUP; trap 'exit 130' INT; trap 'exit 143' TERM

# Concurrent browser stacks and shared ports produced false failures; serialize runs.
exec 9>/tmp/free-baratheon-verify.lock
flock -n 9 || { echo 'Another baratheon-verify run is active'; exit 1; }

dir=$HOME/Projects/FREE-verify-$short
[ -d "$dir" ] || git init -q "$dir"
cd "$dir"
git fetch -q "$bundle" "$ref" && git checkout -q --detach FETCH_HEAD || exit 1
rm -f "$bundle"
test "$(git rev-parse HEAD)" = "$sha" && git diff --quiet HEAD || { echo "Checkout $dir is not a clean $sha"; exit 1; }
E=$dir/artifacts/baratheon-verify/$(date -u +%Y%m%dT%H%M%SZ)
mkdir -p "$E"
printf '%s\n' "${tiers[@]}" > "$E/tiers.txt"
echo "Evidence: $E"

export PATH=$HOME/.local/bin:$HOME/.nvm/versions/node/v24.21.0/bin:$PATH
export PYTHONPATH=$dir/prototypes/parsing_service/src
# Keep tests off the GPUs serving the live models.
export CUDA_VISIBLE_DEVICES= OMP_NUM_THREADS=2 MKL_NUM_THREADS=2 HF_HUB_DISABLE_TELEMETRY=1
export PLAYWRIGHT_WORKERS=1
unset FREE_SKIP_PYTHON FREE_CATALOG_METHOD KEI_SYSTEM_DATABASE_URL KEI_DATABASE_URL DATABASE_URL \
  FREE_REAL_EXTRACT_URL FREE_REAL_EXTRACT_MODEL FREE_REAL_OCR_URL FREE_REAL_NUEXTRACT_URL \
  FREE_REAL_NUEXTRACT_MODEL FREE_REAL_GLIFORMER_URL
# A long TMPDIR pushes Chromium's Unix socket path past its limit.
TMPDIR=$(mktemp -d /tmp/fv.XXXX)
export TMPDIR

# The shared disposable test server on loopback 5432 (the guards require that port).
pg=free-pr-verification-postgres
databases=("free_test_v${short}_store" "free_test_v${short}_extraction" "free_test_v${short}_parsing")
psql() { docker exec "$pg" psql -U postgres -v ON_ERROR_STOP=1 -qc "$1"; }
provisioned=0
# Fails when a test database it should drop survives.
cleanup() {
  local rc=0
  if [ "$provisioned" = 1 ]; then
    for database in "${databases[@]}"; do
      psql "DROP DATABASE IF EXISTS $database WITH (FORCE)" >/dev/null 2>&1 || { echo "WARNING: could not drop test database $database"; rc=1; }
    done
  fi
  rm -rf "$TMPDIR" "$bundle"
  return "$rc"
}
# Aborted runs: tear down, and a teardown failure also fails the run.
trap 'rc=$?; cleanup || rc=1; echo "$rc" > "$E/status"; exit "$rc"' EXIT
store=postgresql://postgres:postgres@127.0.0.1:5432/${databases[0]}
extraction=postgresql://postgres:postgres@127.0.0.1:5432/${databases[1]}
pgenv=(DATABASE_URL="$extraction" EXTRACTION_TEST_DATABASE_URL="$extraction" PROJECT_STORE_POSTGRES_URL="$store"
  PARSING_TEST_DATABASE_URL="postgresql://postgres:postgres@127.0.0.1:5432/${databases[2]}")

results=()
step() {
  local name=$1 log=$E/${1//:/-}
  shift
  printf '%s START %s\n' "$name" "$(date -u +%FT%TZ)" | tee -a "$E/summary.log"
  "$@" > "$log.log" 2>&1
  local rc=$?
  echo "$rc" > "$log.exit"
  printf '%s EXIT %s %s\n' "$name" "$rc" "$(date -u +%FT%TZ)" | tee -a "$E/summary.log"
  results+=("$name $rc")
}
# A failed setup step aborts the run: no tier result on a broken setup.
setup() { step "$@"; [ "${results[-1]##* }" = 0 ] || { tail -20 "$E/${1//:/-}.log"; exit 1; }; }

echo "$sha" > "$E/verified-head.txt"
if [ "${#tiers[@]}" = 1 ] && [ "${tiers[0]}" = test:unit:python ]; then
  setup install-python uv sync --frozen --project prototypes/parsing_service
else
  setup install pnpm install --frozen-lockfile
fi
setup python-dependencies uv run --no-sync --project prototypes/parsing_service python -c \
  'import pytest, dbos, xgrammar, opentelemetry.sdk, opentelemetry.instrumentation.requests; from importlib.metadata import version; print({name: version(name) for name in ("pytest", "dbos", "xgrammar", "opentelemetry-sdk")})'
for tier in "${tiers[@]}"; do
  case $tier in
    test:postgres)
      provisioned=1
      for database in "${databases[@]}"; do
        psql "DROP DATABASE IF EXISTS $database WITH (FORCE)" && psql "CREATE DATABASE $database" || exit 1
      done
      # As `pnpm test:ci` does.
      setup migrate-store env DATABASE_URL="$store" pnpm --filter db db:init
      setup migrate-extraction env DATABASE_URL="$extraction" pnpm --filter db db:init
      # The durable lifecycle/recovery checks run the worker image of this exact commit.
      setup worker-image docker build -t "free-verify-worker:$short" prototypes/parsing_service
      step "$tier" env "${pgenv[@]}" DURABLE_TEST_WORKER_IMAGE="free-verify-worker:$short" pnpm test:postgres
      ;;
    live)
      gliformer=$(docker inspect free-gliformer_model-1 --format '{{(index .NetworkSettings.Networks "free_app").IPAddress}}')
      step live env FREE_REAL_EXTRACT_URL=http://127.0.0.1:18080/v1/chat/completions \
        FREE_REAL_EXTRACT_MODEL=nvidia/Qwen3.8-27B-NVFP4 FREE_REAL_GLIFORMER_URL="http://$gliformer:8000" \
        FREE_REAL_EXTRACT_TIMEOUT=600 pnpm --filter studio exec playwright test \
        --config playwright.service.config.ts durable-service.spec.ts --grep 'real provider requests|native unified live results' --reporter=line
      ;;
    *) step "$tier" pnpm run "$tier" ;;
  esac
done
git status --short > "$E/worktree-status.txt"
trap - EXIT
teardown=0
cleanup || teardown=1

failed=0
echo
echo "== $sha on $(hostname)"
for result in "${results[@]}"; do
  name=${result% *} rc=${result##* }
  if [ "$rc" = 0 ]; then printf 'PASS  %s\n' "$name"; else printf 'FAIL  %s (exit %s)\n' "$name" "$rc"; failed=1; fi
done
[ "$teardown" = 0 ] || { echo 'FAIL  teardown (test databases not dropped)'; failed=1; }
for result in "${results[@]}"; do
  name=${result% *}
  [ "${result##* }" = 0 ] || { echo "-- $name"; tail -15 "$E/${name//:/-}.log"; }
done
echo "$failed" > "$E/status"
echo "Evidence: $E"
exit "$failed"
REMOTE
