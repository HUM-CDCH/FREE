#!/bin/sh
# One rev-8 OCR contention scenario in a throwaway container of the parsing image, on the Spark, from ~/rev8-tests.
# It shares only the Compose network (to reach ocr_model) and a read-only model cache with production.
#   ./run.sh PARALLEL LABEL alone|inject PDF... [--after cut|ocr --delay S]    (PARALLEL: default or a number)
set -eu
parallel=$1
label=$2
shift 2
if [ "$parallel" = default ]; then set -- -e UNUSED=1 "$@"; else set -- -e "SURYA_INFERENCE_PARALLEL=$parallel" "$@"; fi
env_flag=$1 env_value=$2
shift 2
exec docker run --rm --name "rev8-$label" --network free_app --user "$(id -u):$(id -g)" \
  -v free_parsing-models:/models:ro -e HF_HOME=/models/huggingface -e HF_HUB_OFFLINE=1 -e HOME=/tmp \
  -e KEI_VLLM_URL=http://ocr_model:8000/v1/chat/completions -e KEI_RUNS=/tmp/runs \
  -v "$HOME/rev8-tests:/work" -w /work "$env_flag" "$env_value" \
  --entrypoint python free-parsing_worker /work/ocr_contention.py "$@" --label "$label"
