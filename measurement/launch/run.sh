#!/bin/bash
# usage: run.sh COND SCHEMA SOURCE_DIR(in container) NAME OUTDIR
R=/tmp/free-p2s
docker run --rm --network free_app \
  -v $R/src:/app/src:ro -v $R/harness:/harness:ro -v /tmp/free-ablation-20261007:/abl:ro -v $R/parses:/syn:ro -v $R/$5:/out \
  --user "$(id -u):$(id -g)" -e PYTHONDONTWRITEBYTECODE=1 -e HOME=/tmp \
  -e KEI_EXTRACT_URL=http://extraction_nvfp4:8000/v1/chat/completions -e KEI_EXTRACT_MODEL=nvidia/Qwen3.8-27B-NVFP4 \
  -e KEI_NUEXTRACT_URL=http://nuextract_model:8000/v1/chat/completions -e KEI_NUEXTRACT_MODEL=numind/NuExtract3-FP8 \
  --entrypoint python free-parsing_worker /harness/run_paired.py "$1" "/harness/$2" "$3" "/out/$1-$4.json" > "$R/$5/$1-$4.log" 2>&1
echo "exit $?" >> "$R/$5/$1-$4.log"
