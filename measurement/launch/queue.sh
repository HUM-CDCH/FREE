#!/bin/bash
# usage: queue.sh COND KIND   (KIND corpus or synthetic)
cd /tmp/free-p2s
mkdir -p out/$2
if [ "$2" = corpus ]; then
  for s in /tmp/free-ablation-20261007/ho-sealed/input/source/H* /tmp/free-ablation-20261007/dev360-sealed/input/source/ocr360-*; do
    ./run.sh $1 schema-collagen.json /abl/${s#/tmp/free-ablation-20261007/} $(basename $s) out/$2
  done
else
  for n in p2s-a p2s-b p2s-c p2s-d; do ./run.sh $1 schema-synthetic.json /syn/$n $n out/$2; done
fi
echo done > out/$2/$1.queue-done
