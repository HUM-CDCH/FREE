#!/usr/bin/env python3
"""Source-anchored benchmark scoring. Reference answers never enter run.ts."""
import argparse
import hashlib
import json
import re
import unicodedata
from collections import Counter
from pathlib import Path

HERE = Path(__file__).resolve().parent


def digest(data):
    return hashlib.sha256(data).hexdigest()


def bind(document_path):
    data = document_path.read_bytes()
    document = json.loads(data)
    reference = json.loads((HERE / 'beier.reference.json').read_text())
    if document['document']['content_sha256'] != reference['sourceSha256']:
        raise ValueError('Reference belongs to another source PDF')
    anchor_by_block = {a['block_id']: a['anchor_id'] for a in document['evidence_index']['anchors'] if a['kind'] == 'text'}
    rows = []
    for item in reference['records']:
        values = dict(zip(reference['columns'], item['values']))
        header = document['content_stream'][item['header']]
        if not header.get('text', '').startswith(f"{values['catalog_number']}. "):
            raise ValueError('Parser block positions changed: reference must be reviewed and rebound')
        evidence = {}
        for field, value in values.items():
            block_index = (item.get('map', item['header']) if field == 'map_sheet'
                           else item['fa'] if field == 'find_type'
                           else item.get('axis') if field == 'burial_axis'
                           else item['header'])
            evidence[field] = [] if value is None else [anchor_by_block[document['content_stream'][block_index]['block_id']]]
        rows.append({'values': values, 'evidence': evidence})
    return {**reference, 'inputSha256': digest(data), 'referenceSha256': digest((HERE / 'beier.reference.json').read_bytes()), 'rows': rows}


def normalize(value, field, ocr_tolerant=False):
    if value is None or value == '':
        return None
    if field in ('catalog_number', 'map_sheet'):
        # Do not accept arbitrary prose containing the right number.
        if isinstance(value, bool):
            return ('invalid-bool', value)
        if isinstance(value, (int, float)) and int(value) == value:
            return int(value)
        return ('invalid-numeric', str(value))
    if not isinstance(value, str):
        return ('invalid-type', str(value))
    text = unicodedata.normalize('NFKC', value).lower()
    text = text.replace('’', "'").replace('‘', "'").replace('−', '-').replace('—', '-').replace('–', '-')
    if ocr_tolerant and field == 'locality':
        text = text.replace('β', 'ß')
    if field == 'burial_axis':
        return re.sub(r'\s+', '', text).replace('0-w', 'o-w')
    # Typography and terminal punctuation do not change the field's meaning.
    # Keep letters, accents and word/number boundaries; no fuzzy similarity.
    return re.sub(r'\s+', ' ', re.sub(r'[.,;:]', ' ', text)).strip()


def score(run, reference, partition):
    if run.get('executionStatus') == 'running':
        raise ValueError('Cannot score an unfinished run')
    if run['inputSha256'] != reference['inputSha256']:
        raise ValueError('Run and reference use different parser snapshots')
    ids = set(reference[partition]) if partition != 'all' else {r['values']['catalog_number'] for r in reference['rows']}
    expected = {r['values']['catalog_number']: r for r in reference['rows'] if r['values']['catalog_number'] in ids}
    # In full evaluation all spurious records count. Development scoring is scoped
    # to its source pages; unfamiliar IDs emitted by development-only runs also count.
    actual = [r for r in run['rows'] if partition == 'all' or run.get('development-only') or r['values'].get('catalog_number') in ids]
    counts = Counter(str(r['values'].get('catalog_number')) for r in actual)
    matched = {r['values'].get('catalog_number'): r for r in actual
               if isinstance(r['values'].get('catalog_number'), int) and counts[str(r['values']['catalog_number'])] == 1}
    fields = reference['columns']
    exact = tolerant = gold_populated = supported = provided = correctly_linked = 0
    issues = []
    by_field = {field: {'correct': 0, 'total': len(expected), 'supported': 0, 'populated': 0} for field in fields}
    for number, gold in expected.items():
        row = matched.get(number)
        for field in fields:
            truth = gold['values'][field]
            value = row['values'].get(field) if row else None
            equal = row is not None and normalize(value, field) == normalize(truth, field)
            tolerant_equal = row is not None and normalize(value, field, True) == normalize(truth, field, True)
            exact += equal
            tolerant += tolerant_equal
            by_field[field]['correct'] += equal
            links = row.get('evidence', {}).get(field, []) if row else []
            evidence_ok = truth is not None and bool(links) and set(links).issubset(gold['evidence'][field])
            if truth is not None:
                gold_populated += 1
                by_field[field]['populated'] += 1
                if equal and evidence_ok:
                    supported += 1
                    by_field[field]['supported'] += 1
            if not equal or (truth is not None and not evidence_ok):
                issues.append({'catalog_number': number, 'field': field, 'expected': truth, 'actual': value,
                               'valueCorrect': equal, 'ocrTolerantValueCorrect': tolerant_equal,
                               'evidenceCorrect': evidence_ok, 'evidence': links, 'expectedEvidence': gold['evidence'][field],
                               'missingOrDuplicateRecord': row is None})
    for row in actual:
        gold = expected.get(row['values'].get('catalog_number'))
        for field in fields:
            links = row.get('evidence', {}).get(field, [])
            if links:
                provided += 1
                if gold and counts[str(row['values']['catalog_number'])] == 1:
                    if (gold['values'][field] is not None and normalize(row['values'].get(field), field) == normalize(gold['values'][field], field)
                            and set(links).issubset(gold['evidence'][field])):
                        correctly_linked += 1
    correct_records = sum(1 for n in expected if n in matched)
    spurious = sum(1 for r in actual if r['values'].get('catalog_number') not in expected)
    duplicates = sum(c - 1 for c in counts.values() if c > 1)
    reused = (run.get('reusedDiscovery') or {}).get('calls', [])
    all_calls = run['calls'] + reused
    return {
        'partition': partition, 'referenceStatus': reference['status'], 'referenceSha256': reference['referenceSha256'],
        'strategy': run['strategy'], 'model': run['model'], 'groundModel': run.get('ground-model') or run['model'],
        'batchSize': run.get('batch-size'), 'failure': run.get('failure'),
        'fewShot': run.get('few-shot', False), 'fieldAware': run.get('field-aware', False), 'fallbackModel': run.get('fallback-model'),
        'expectedRecords': len(expected), 'returnedRecords': len(actual), 'correctUniqueRecords': correct_records,
        'missingRecords': sorted(n for n in expected if n not in matched), 'spuriousRecords': spurious, 'duplicates': duplicates,
        'recordPrecision': correct_records / len(actual) if actual else 0,
        'recordRecall': correct_records / len(expected),
        'correctFields': exact, 'totalFields': len(expected) * len(fields),
        'fieldAccuracy': exact / (len(expected) * len(fields)),
        'ocrTolerantFieldAccuracy': tolerant / (len(expected) * len(fields)),
        'populatedGoldFields': gold_populated, 'supportedCorrectFields': supported,
        'supportedAccuracy': supported / gold_populated,
        'providedEvidenceFields': provided, 'correctEvidenceFields': correctly_linked,
        'evidencePrecision': correctly_linked / provided if provided else 0,
        'executedCalls': len(run['calls']), 'reusedDiscoveryCalls': len(reused), 'fullPipelineCalls': len(all_calls),
        'providerInvocations': sum(c.get('providerInvocations', 0) for c in all_calls),
        'measuredWallMs': run['durationMs'],
        'fullPipelineWallMs': run['durationMs'] + sum(c['durationMs'] for c in reused),
        'inputTokens': sum((c.get('metadata') or {}).get('inputTokens') or 0 for c in all_calls),
        'outputTokens': sum((c.get('metadata') or {}).get('outputTokens') or 0 for c in all_calls),
        'truncatedCalls': sum((c.get('metadata') or {}).get('finishReason') == 'length' for c in all_calls),
        'invalidSelections': sum(issue.startswith('invalid-') for row in actual for issue in row.get('issues', [])),
        'fieldBreakdown': by_field, 'issues': issues,
    }


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--document', type=Path, required=True)
    parser.add_argument('--partition', choices=['development', 'evaluation', 'all'], default='all')
    parser.add_argument('runs', type=Path, nargs='+')
    args = parser.parse_args()
    reference = bind(args.document)
    (args.document.parent / 'reference.bound.json').write_text(json.dumps(reference, ensure_ascii=False, indent=2))
    for path in args.runs:
        run = json.loads(path.read_text())
        metrics = score(run, reference, args.partition)
        path.with_name(f'metrics-{args.partition}.json').write_text(json.dumps(metrics, ensure_ascii=False, indent=2))
        print(json.dumps({'run': str(path.parent), **{k: metrics[k] for k in ['returnedRecords', 'missingRecords', 'fieldAccuracy', 'supportedAccuracy', 'evidencePrecision', 'fullPipelineCalls', 'fullPipelineWallMs', 'failure']}}, ensure_ascii=False))


if __name__ == '__main__':
    main()
