#!/bin/sh
# One M3 Catalog chunk scenario in a throwaway container of the production parsing image, on the Spark, from
# ~/m3-spark. The M3 source (e5003f9, `git archive ... prototypes/parsing_service`, its src/ and tests/ copied to
# ~/m3-spark/parsing_service) is
# mounted read-only over the image's editable install at /app/src; the extraction path imports no dbos, so the
# image's own environment serves. It shares only the Compose network (to reach the extraction servers) with
# production.
#   ./run_chunks.sh LABEL alone|inject|pair RUN... [--chunks K] [--strategy S | --small-strategy S --delay SECONDS]
set -eu
label=$1
shift
exec docker run --rm --name "free-m3-spark-$label" --network free_app --user "$(id -u):$(id -g)" \
  -v free_parsing-models:/models:ro -e HF_HOME=/models/huggingface -e HF_HUB_OFFLINE=1 -e HOME=/tmp \
  -e KEI_EXTRACT_URL=http://extraction_model:8000/v1/chat/completions -e KEI_EXTRACT_MODEL=Qwen/Qwen3.8-27B-FP8 \
  -e KEI_NUEXTRACT_URL=http://nuextract_model:8000/v1/chat/completions \
  -e KEI_NUEXTRACT_MODEL=numind/NuExtract3-FP8 \
  -v "$HOME/m3-spark/parsing_service/src:/app/src:ro" \
  -v "$HOME/m3-spark:/work" -w /work \
  --entrypoint python free-parsing_worker /work/extract_chunks.py "$@" --label "$label"
