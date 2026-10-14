#!/bin/bash
# usage: pr267-run.sh COND SOURCE_SUBPATH NAME
R=/tmp/free-pr267-comparison
docker run --rm --network free_app \
  -v $R/src:/app/src:ro -v $R/harness:/harness:ro -v /tmp/free-ablation-20261007:/abl:ro -v $R/out:/out \
  --user "$(id -u):$(id -g)" -e PYTHONDONTWRITEBYTECODE=1 -e HOME=/tmp \
  -e KEI_EXTRACT_URL=http://extraction_nvfp4:8000/v1/chat/completions -e KEI_EXTRACT_MODEL=nvidia/Qwen3.8-27B-NVFP4 \
  -e KEI_NUEXTRACT_URL=http://nuextract_model:8000/v1/chat/completions -e KEI_NUEXTRACT_MODEL=numind/NuExtract3-FP8 \
  --entrypoint python free-parsing_worker /harness/run_paper.py "$1" "/abl/$2" "/out/$1-$3.json" > "$R/out/$1-$3.log" 2>&1
echo "exit $?" >> "$R/out/$1-$3.log"
