"""Evaluate saved rankings only after native encoding has completed."""
import argparse
import hashlib
import json
import math
from pathlib import Path

ROOT = Path('artifacts/catalog-lab/beier/models-v1')

def rank_metrics(matrix, query_ids, candidates, reference):
    assert len(matrix) == len(query_ids)
    rows = []
    for query, scores in zip(query_ids, matrix):
        assert len(scores) == len(candidates) and all(math.isfinite(v) for v in scores)
        ranking = sorted(range(len(scores)), key=lambda i: -scores[i])
        relevant = set(reference[query])
        assert relevant and relevant.issubset(candidates)
        rank = next(i+1 for i, n in enumerate(ranking) if candidates[n] in relevant)
        rows.append({'id': query, 'firstRelevantRank': rank, 'top3': [candidates[n] for n in ranking[:3]], 'relevant': sorted(relevant)})
    return {'queries': len(rows), 'hitAt1': sum(r['firstRelevantRank'] == 1 for r in rows)/len(rows),
            'hitAt3': sum(r['firstRelevantRank'] <= 3 for r in rows)/len(rows),
            'mrr': sum(1/r['firstRelevantRank'] for r in rows)/len(rows), 'rows': rows}

if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('directory', type=Path)
    args = parser.parse_args()
    inputs = ROOT / 'retrieval-input.json'
    data = json.loads(inputs.read_bytes())
    manifest = json.loads((args.directory / 'manifest.json').read_bytes())
    assert manifest['status'] == 'completed'
    assert manifest['inputSha256'] == hashlib.sha256(inputs.read_bytes()).hexdigest()
    reference = {r['id']: r['relevant'] for r in json.loads((ROOT / 'retrieval-reference.json').read_bytes())}
    result = {mode: rank_metrics(scores, [q['id'] for q in data['queries']], [c['id'] for c in data['candidates']], reference)
              for mode, scores in json.loads((args.directory / 'scores.json').read_bytes()).items()}
    (args.directory / 'retrieval-metrics.json').write_text(json.dumps(result, indent=2))
    print(json.dumps({mode: {k:v for k,v in metrics.items() if k != 'rows'} for mode, metrics in result.items()}))
