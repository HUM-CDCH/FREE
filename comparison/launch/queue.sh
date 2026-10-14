#!/bin/bash
C=$1
for s in /tmp/free-ablation-20261007/ho-sealed/input/source/H* /tmp/free-ablation-20261007/dev360-sealed/input/source/ocr360-*; do
  n=$(basename $s); rel=${s#/tmp/free-ablation-20261007/}
  ./run.sh $C $rel $n
done
echo done > out/$C.queue-done
