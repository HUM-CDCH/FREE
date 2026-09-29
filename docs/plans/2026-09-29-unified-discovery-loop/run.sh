#!/bin/sh
# Branch parsing_service code in a throwaway container of the production worker image, on free_app, models read-only.
set -eu
label=$1
shift
exec docker run --rm --name "free-unify-$label" --network free_app --user "$(id -u):$(id -g)" \
  -v free_parsing-models:/models:ro -e HF_HOME=/models/huggingface -e HF_HUB_OFFLINE=1 -e HOME=/tmp \
  -e KEI_EXTRACT_URL=http://extraction_model:8000/v1/chat/completions -e KEI_EXTRACT_MODEL=Qwen/Qwen3.8-27B-FP8 \
  -e KEI_NUEXTRACT_URL=http://nuextract_model:8000/v1/chat/completions -e KEI_NUEXTRACT_MODEL=numind/NuExtract3-FP8 \
  -e FREE_REAL_EXTRACT_URL=http://extraction_model:8000/v1/chat/completions -e FREE_REAL_EXTRACT_MODEL=Qwen/Qwen3.8-27B-FP8 \
  -e PYTHONPATH=/repo/prototypes/parsing_service:/deps -v "$HOME/free-unify/prototypes/parsing_service/src:/app/src:ro" \
  -v "$HOME/free-unify:/repo" -v "$HOME/free-unify-deps:/deps:ro" -v "$HOME/free-unify-evidence:/out" -w /repo/prototypes/parsing_service \
  --entrypoint "${ENTRY:-python}" free-parsing_worker "$@"
