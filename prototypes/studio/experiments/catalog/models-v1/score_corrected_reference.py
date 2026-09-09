"""Separate post-hoc reference correction; never overwrite original scores or outputs."""
import hashlib
import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
from evaluate import bind, score

ROOT = Path('artifacts/catalog-lab/beier/models-v1')

if __name__ == '__main__':
    correction_path = Path(__file__).with_name('reference-correction.json')
    correction = json.loads(correction_path.read_bytes())
    locations_path = ROOT / 'retrieval-reference-reviewed.json'
    locations = {r['id']: r['relevant'] for r in json.loads(locations_path.read_bytes())['rows']}
    out = ROOT / 'reference-corrected'
    out.mkdir(exist_ok=False)
    paths = [ROOT.parent/'verification-v1/local-baseline.json',
             *sorted(ROOT.glob('gliner-extraction-*/result.json')),
             *sorted(ROOT.glob('*-downstream-*/result.json'))]
    for path in paths:
        run = json.loads(path.read_bytes())
        gold = bind(ROOT.parent/'parsed_document.json')
        target = next(r for r in gold['rows'] if r['values']['catalog_number'] == correction['catalog_number'])
        assert target['values'][correction['field']] == correction['before']
        target['values'][correction['field']] = correction['after']
        provenance = {'originalReferenceSha256': gold['referenceSha256'],
                      'correctionSha256': hashlib.sha256(correction_path.read_bytes()).hexdigest(),
                      'sourcePdfSha256': hashlib.sha256((ROOT.parent/'source.pdf').read_bytes()).hexdigest()}
        if run.get('evidenceGranularity') in ('source-page', 'source-column'):
            gold['inputSha256'] = run['inputSha256']
            provenance['locationsSha256'] = hashlib.sha256(locations_path.read_bytes()).hexdigest()
            for row in gold['rows']:
                for field, value in row['values'].items():
                    evidence = locations.get(f'{row["values"]["catalog_number"]}:{field}', [])
                    if run['evidenceGranularity'] == 'source-page':
                        evidence = sorted({loc.split('-')[0]+'-full' for loc in evidence})
                    row['evidence'][field] = evidence if value is not None else []
        gold['referenceSha256'] = hashlib.sha256(json.dumps(provenance, sort_keys=True).encode()).hexdigest()
        gold['status'] = correction['status']
        result = score(run, gold, 'all')
        label = 'local-baseline' if path.name == 'local-baseline.json' else path.parent.name
        original_path = path.parent/('baseline-metrics.json' if label == 'local-baseline' else
                                    'metrics-reviewed.json' if '-downstream-' in label else 'metrics-all.json')
        original = json.loads(original_path.read_bytes())
        # Runnable audit: a reference-only correction must leave every other field unchanged.
        assert all(result['fieldBreakdown'][f] == m for f, m in original['fieldBreakdown'].items() if f != correction['field'])
        assert result['returnedRecords'] == original['returnedRecords']
        result['provenance'] = provenance
        result['sourceRunSha256'] = hashlib.sha256(path.read_bytes()).hexdigest()
        (out/(label+'.json')).write_text(json.dumps(result, ensure_ascii=False, indent=2), encoding='utf-8')
        print(label, f'{original["correctFields"]} -> {result["correctFields"]}',
              f'{original["supportedCorrectFields"]} -> {result["supportedCorrectFields"]}')
