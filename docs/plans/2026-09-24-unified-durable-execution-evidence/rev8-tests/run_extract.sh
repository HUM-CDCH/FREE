#!/bin/sh
# One rev-8 extraction contention scenario in a throwaway container of the parsing image, on the Spark, from
# ~/rev8-tests. It shares only the Compose network (to reach the extraction servers) with production.
#   ./run_extract.sh LABEL alone|inject|split RUN... [--strategy S | --small-strategy S --delay SECONDS | --chunks K]
# NUEXTRACT_HOST=rev8-nuextract-bi sends the fields role to another NuExtract server on the same network.
set -eu
label=$1
shift
exec docker run --rm --name "rev8-$label" --network free_app --user "$(id -u):$(id -g)" \
  -v free_parsing-models:/models:ro -e HF_HOME=/models/huggingface -e HF_HUB_OFFLINE=1 -e HOME=/tmp \
  -e KEI_EXTRACT_URL=http://extraction_model:8000/v1/chat/completions -e KEI_EXTRACT_MODEL=Qwen/Qwen3.8-27B-FP8 \
  -e "KEI_NUEXTRACT_URL=http://${NUEXTRACT_HOST:-nuextract_model}:8000/v1/chat/completions" \
  -e KEI_NUEXTRACT_MODEL=numind/NuExtract3-FP8 \
  -v "$HOME/rev8-tests:/work" -w /work \
  --entrypoint python free-parsing_worker /work/extract_contention.py "$@" --label "$label"
