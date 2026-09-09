"""Source-reviewed column scoring for saved retrieval and downstream runs."""
import argparse
import hashlib
import json
import sys
from pathlib import Path
from score_retrieval import rank_metrics

ROOT = Path('artifacts/catalog-lab/beier/models-v1')
sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
from evaluate import bind, score

def evaluate(directory):
    path = ROOT / 'retrieval-reference-reviewed.json'
    reference = {r['id']: r['relevant'] for r in json.loads(path.read_bytes())['rows']}
    if (directory / 'scores.json').exists():
        inputs = ROOT / 'retrieval-input.json'
        data = json.loads(inputs.read_bytes())
        manifest = json.loads((directory / 'manifest.json').read_bytes())
        assert manifest['status'] == 'completed'
        assert manifest['inputSha256'] == hashlib.sha256(inputs.read_bytes()).hexdigest()
        result = {mode: rank_metrics(matrix, [q['id'] for q in data['queries']], [c['id'] for c in data['candidates']], reference)
                  for mode, matrix in json.loads((directory / 'scores.json').read_bytes()).items()}
        target = 'retrieval-metrics-reviewed.json'
    else:
        run = json.loads((directory / 'result.json').read_bytes())
        gold = bind(ROOT.parent / 'parsed_document.json')
        # Same PDF field values, newly bound coarse source locations; never reuse old anchor IDs.
        gold['inputSha256'] = run['inputSha256']
        gold['referenceSha256'] = hashlib.sha256(path.read_bytes()).hexdigest()
        gold['status'] = 'Source-reviewed fields, coarse image locations; not paragraph-level grounding accuracy.'
        for row in gold['rows']:
            for field, value in row['values'].items():
                locations = reference.get(f'{row["values"]["catalog_number"]}:{field}', [])
                if run['evidenceGranularity'] == 'source-page':
                    locations = sorted({loc.split('-')[0] + '-full' for loc in locations})
                row['evidence'][field] = locations if value is not None else []
        result = score(run, gold, 'all')
        result['evidenceGranularity'] = run['evidenceGranularity']
        target = 'metrics-reviewed.json'
    (directory / target).write_text(json.dumps(result, indent=2, ensure_ascii=False), encoding='utf-8')
    return result

if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('directories', nargs='+', type=Path)
    args = parser.parse_args()
    for directory in args.directories:
        result = evaluate(directory)
        print(directory.name, {k: v for k, v in result.items() if k in ['correctFields', 'supportedCorrectFields', 'missingRecords']}
              or {mode: {k:v for k,v in metrics.items() if k != 'rows'} for mode, metrics in result.items()})
