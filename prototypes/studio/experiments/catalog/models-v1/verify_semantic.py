"""Frozen prospective semantic policy on saved OCR outputs; no source run edits."""
import copy
import importlib.util
import json
import sys
import time
import urllib.request
from pathlib import Path

HERE = Path(__file__).resolve().parent
ROOT = HERE.parents[4] / 'artifacts/catalog-lab/beier/models-v1'
OUT = ROOT / 'semantic-v1'
spec = importlib.util.spec_from_file_location('verifier', HERE.parent/'verification-v1/run.py')
verifier = importlib.util.module_from_spec(spec)
spec.loader.exec_module(verifier)
read, save, sha = verifier.read, verifier.save, verifier.sha


def claims_for(directory):
    run = read(directory/'result.json')
    records = read(directory/'input.json')['records']
    claims, row_index = [], 0
    for batch in range(len(run['calls'])):
        group = records[batch*3:batch*3+3]
        returned = json.loads(read(directory/f'call-{batch+1}-response.json')['response'])['records']
        for values in returned:
            row = run['rows'][row_index]
            assert row['values']['catalog_number'] == values['catalog_number']
            if row['values']['burial_axis'] is not None:
                # Same first matching record within the original extraction batch.
                candidates = next((r['candidates'] for r in group if r['number'] == values['catalog_number']), [])
                text, blocks = '', []
                for candidate in candidates:
                    if text:
                        text += '\n\n'
                    start = len(text)
                    text += candidate['text']
                    blocks.append({**candidate, 'start': start, 'end': len(text)})
                claims.append({'rowIndex': row_index, 'catalog_number': values['catalog_number'],
                               'value': row['values']['burial_axis'], 'text': text, 'blocks': blocks})
            row_index += 1
    assert row_index == len(run['rows'])
    return claims


def project(run, claims, decisions):
    result = copy.deepcopy(run)
    for claim, decision in zip(claims, decisions, strict=True):
        row = result['rows'][claim['rowIndex']]
        supported = decision['modelVerdict'] == 'supported'
        row['verification'] = {**decision, 'originalEvidence': copy.deepcopy(row['evidence']['burial_axis']),
                               'reviewRequired': not supported}
        if not supported:
            row['values']['burial_axis'] = None
            row['evidence']['burial_axis'] = []
            row['issues'].append('semantic-review:burial_axis')
    return result


def load_model(unload=False):
    body = {'model': verifier.MODEL, 'options': {'num_ctx': 32768}, 'keep_alive': 0 if unload else '30m'}
    start = time.perf_counter()
    request = urllib.request.Request('http://127.0.0.1:11434/api/generate', json.dumps(body).encode(),
                                     {'Content-Type': 'application/json'})
    with urllib.request.urlopen(request, timeout=180) as response:
        raw = json.load(response)
    save(OUT/('unload.json' if unload else 'warmup.json'),
         {'request': body, 'response': raw, 'wallMs': (time.perf_counter()-start)*1000})
    assert not raw.get('eval_count')


def freeze():
    OUT.mkdir(exist_ok=True)
    assert not (OUT/'freeze.json').exists()
    runs = []
    for directory in sorted(ROOT.glob('*-downstream-*')):
        if not directory.is_dir():
            continue
        claims = claims_for(directory)
        runs.append({'name': directory.name, 'claims': claims,
                     'hashes': {p.name: sha(p) for p in [directory/'input.json', directory/'result.json',
                                                       *directory.glob('call-*-response.json')]}})
    save(OUT/'freeze.json', {'runs': runs, 'codeHashes': {str(p): sha(p) for p in [Path(__file__), Path(spec.origin)]},
         'protocol': 'Two repetitions, all non-null burial axes; entire original OCR record; unchanged rich verifier prompt. '
         'Only supported retains value; all other verdicts abstain and require review. Original evidence retained only '
         'for retained values; quote gate recorded separately. Row indexes preserve duplicates. No reference in inference. '
         'Known excerpt, no blind holdout; missing/null claims not recovered.'})
    print([(r['name'], len(r['claims'])) for r in runs])


def execute():
    frozen = read(OUT/'freeze.json')
    assert all(sha(Path(p)) == h for p, h in frozen['codeHashes'].items())
    for run in frozen['runs']:
        assert all(sha(ROOT/run['name']/p) == h for p, h in run['hashes'].items())
    load_model()
    try:
        for repetition in (1, 2):
            for source in frozen['runs']:
                directory = OUT/f'{source["name"]}-r{repetition}'
                directory.mkdir()
                decisions = []
                for index, claim in enumerate(source['claims'], 1):
                    start = time.perf_counter()
                    if claim['text']:
                        decision = verifier.nuextract(claim, directory, index)
                    else:
                        decision = {'modelVerdict': 'invalid', 'decision': 'invalid', 'reason': 'No same-record context'}
                    decision.update(rowIndex=claim['rowIndex'], durationMs=(time.perf_counter()-start)*1000)
                    decisions.append(decision)
                save(directory/'decisions.json', decisions)
                save(directory/'result.json', project(read(ROOT/source['name']/'result.json'), source['claims'], decisions))
                print(directory.name, len(decisions), round(sum(d['durationMs'] for d in decisions)), flush=True)
    finally:
        load_model(unload=True)


def report():
    sys.path.insert(0, str(HERE.parent))
    from evaluate import bind, score, normalize
    rows = []
    frozen = read(OUT/'freeze.json')
    locations = {r['id']: r['relevant'] for r in read(ROOT/'retrieval-reference-reviewed.json')['rows']}
    correction = read(HERE/'reference-correction.json')
    for source in frozen['runs']:
        original = read(ROOT/source['name']/'result.json')
        gold = bind(ROOT.parent/'parsed_document.json')
        gold['inputSha256'] = original['inputSha256']
        for row in gold['rows']:
            if row['values']['catalog_number'] == correction['catalog_number']:
                row['values'][correction['field']] = correction['after']
            for field, value in row['values'].items():
                evidence = locations.get(f'{row["values"]["catalog_number"]}:{field}', [])
                if original['evidenceGranularity'] == 'source-page':
                    evidence = sorted({loc.split('-')[0]+'-full' for loc in evidence})
                row['evidence'][field] = evidence if value is not None else []
        gold['referenceSha256'] += '+correction:' + sha(HERE/'reference-correction.json')
        baseline = score(original, gold, 'all')
        truths = {r['values']['catalog_number']: r['values']['burial_axis'] for r in gold['rows']}
        for repetition in (1, 2):
            directory = OUT/f'{source["name"]}-r{repetition}'
            result, decisions = read(directory/'result.json'), read(directory/'decisions.json')
            metrics = score(result, gold, 'all')
            assert all(metrics['fieldBreakdown'][f] == baseline['fieldBreakdown'][f] for f in gold['columns'] if f != 'burial_axis')
            good = caught = rejected = bad = calls = tokens_in = tokens_out = 0
            for index, (claim, decision) in enumerate(zip(source['claims'], decisions, strict=True), 1):
                correct = claim['catalog_number'] in truths and normalize(claim['value'], 'burial_axis') == normalize(truths[claim['catalog_number']], 'burial_axis')
                good += correct
                bad += not correct
                rejected += correct and decision['modelVerdict'] != 'supported'
                caught += not correct and decision['modelVerdict'] != 'supported'
                response = directory/f'{index:02}-response.json'
                if response.exists():
                    raw = read(response)
                    assert raw['done'] and raw.get('done_reason') != 'length'
                    calls += 1
                    tokens_in += raw.get('prompt_eval_count', 0)
                    tokens_out += raw.get('eval_count', 0)
            item = {'run': source['name'], 'repetition': repetition, 'claims': len(decisions), 'correctClaims': good,
                    'incorrectClaims': bad, 'errorsCaught': caught, 'correctRejected': rejected,
                    'before': baseline['correctFields'], 'after': metrics['correctFields'],
                    'localizedBefore': baseline['supportedCorrectFields'], 'localizedAfter': metrics['supportedCorrectFields'],
                    'wallMs': sum(d['durationMs'] for d in decisions), 'llmCalls': calls,
                    'inputTokens': tokens_in, 'outputTokens': tokens_out}
            save(directory/'metrics.json', {'summary': item, 'baseline': baseline, 'semantic': metrics})
            rows.append(item)
    save(OUT/'summary.json', rows)
    lines = ['# Semantic verification of new OCR outputs', '',
             'Completed diagnostic on the known Beier excerpt. Two fresh repetitions per OCR output. Corrected reference 228 used for both sides.', '',
             '| OCR output | Repeat | Errors caught | Correct axes rejected | Values before → after /203 | Localized before → after /164 | Seconds |',
             '|---|---:|---:|---:|---:|---:|---:|']
    for r in rows:
        lines.append(f'| {r["run"]} | {r["repetition"]} | {r["errorsCaught"]}/{r["incorrectClaims"]} | {r["correctRejected"]}/{r["correctClaims"]} | {r["before"]} → {r["after"]} | {r["localizedBefore"]} → {r["localizedAfter"]} | {r["wallMs"]/1000:.2f} |')
    lines += ['', 'Claim counts include returned duplicates; aggregate value scores retain the original duplicate-record penalty. '
              'Missing records and null axes are not recovered. Localized evidence remains coarse and is not semantic proof. '
              'The rich semantic prompt is unchanged; entire record context differs from the historical selected-neighbor protocol. '
              'Non-supported values are withheld in a separate projection; original values/evidence and all raw responses remain saved. '
              'Strict quote-gate decisions are diagnostic only. No production acceptance changes.', '',
              f'New calls: {sum(r["llmCalls"] for r in rows)}; input/output tokens: {sum(r["inputTokens"] for r in rows)}/{sum(r["outputTokens"] for r in rows)}. '
              'Warmup is recorded separately. Times include request overhead and exclude prior OCR/extraction.']
    (OUT/'report.md').write_text('\n'.join(lines)+'\n', encoding='utf-8')
    print('\n'.join(lines))


def check():
    run = {'rows': [{'values': {'burial_axis': 'O-W'}, 'evidence': {'burial_axis': ['a']}, 'issues': []} for _ in range(2)]}
    claims = [{'rowIndex': 1}]
    result = project(run, claims, [{'modelVerdict': 'uncertain'}])
    assert result['rows'][0] == run['rows'][0] and result['rows'][1]['values']['burial_axis'] is None
    assert run['rows'][1]['values']['burial_axis'] == 'O-W'
    assert result['rows'][1]['verification']['originalEvidence'] == ['a']
    assert project(run, claims, [{'modelVerdict': 'supported'}])['rows'][1]['evidence'] == run['rows'][1]['evidence']
    print('Projection check passed: duplicate-safe row indexes, original values/evidence preserved, no invented links.')


if __name__ == '__main__':
    {'freeze': freeze, 'run': execute, 'report': report, 'check': check}[sys.argv[1]]()
