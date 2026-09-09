"""Supplemental protocol v2: same semantic task, source block labels instead of copied quotes."""
import argparse
import json
import time
import urllib.request
from pathlib import Path
from run import DEFINITION, LABELS, MODEL, read, save, sha, normalized


def decision(claim, answer):
    status = answer.get('verdict')
    label = answer.get('evidence_anchor')
    blocks = {f'E{i}': block for i, block in enumerate(claim['blocks'], 1)}
    block = blocks.get(label) if isinstance(label, str) else None
    valid = block is not None and normalized(claim['value']) in normalized(block['text'])
    if status not in LABELS:
        status = 'invalid'
    elif status == 'supported' and not valid:
        status = 'uncertain'
    return {'catalog_number': claim['catalog_number'], 'originalValue': claim['value'],
            'modelVerdict': answer.get('verdict'), 'decision': status,
            'value': claim['value'] if status == 'supported' else None,
            'evidence': [block['anchorId']] if status == 'supported' else [],
            'reviewRequired': status in ('uncertain', 'invalid')}


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--input-dir', type=Path, required=True)
    parser.add_argument('--repetition', type=int, default=1)
    parser.add_argument('--freeze', action='store_true')
    args = parser.parse_args()
    hashes = {p.name: sha(p) for p in [Path(__file__), Path(__file__).with_name('run.py'),
              Path(__file__).with_name('test_labels.py'), args.input_dir/'claims.json', args.input_dir/'local-baseline.json']}
    freeze = args.input_dir/'labels-v2-freeze.json'
    if args.freeze:
        save(freeze, {'hashes': hashes, 'note': 'Supplemental revision after observing v1 quote failures. Two repetitions, no examples or per-entry exceptions.'})
        return
    if read(freeze)['hashes'] != hashes:
        raise ValueError('Code or input changed since freeze')
    out = args.input_dir/f'labels-v2-nuextract-r{args.repetition}'
    out.mkdir()
    save(out/'manifest.json', {'hashes': hashes, 'repetition': args.repetition, 'protocol': 'labels-v2'})
    decisions, failure = [], None
    for index, claim in enumerate(read(args.input_dir/'claims.json')['claims'], 1):
        instruction = (DEFINITION + f'\nProposed burial_axis: {claim["value"]}.\n'
            + '\n'.join(f'{k}: {v}' for k, v in LABELS.items())
            + '\nReturn verdict as exactly supported, unsupported, or uncertain. '
            + 'For supported, evidence_anchor must be ONE exact E label of the block explicitly '
            + 'supporting this main grave axis. Otherwise evidence_anchor must be null. '
            + 'A block merely containing the direction is not sufficient: it must support its assignment to the grave.')
        text = '\n\n'.join(f'[E{i}] {b["text"]}' for i, b in enumerate(claim['blocks'], 1))
        body = {'model': MODEL, 'raw': True, 'stream': False,
                'options': {'temperature': 0.2, 'num_ctx': 32768, 'num_predict': 8192},
                'prompt': '<|im_start|>user\n【task】structured\n【template_start】'
                          + json.dumps({'verdict': 'verbatim-string', 'evidence_anchor': 'verbatim-string'})
                          + '【template_end】\n【instructions_start】' + instruction
                          + '【instructions_end】\n【document_start】\n' + text
                          + '\n【document_end】<|im_end|>\n<|im_start|>assistant\n<think>\n\n</think>\n\n'}
        save(out/f'{index:02}-request.json', body)
        start = time.perf_counter()
        try:
            req = urllib.request.Request('http://127.0.0.1:11434/api/generate', json.dumps(body).encode(),
                                         {'Content-Type': 'application/json'})
            with urllib.request.urlopen(req, timeout=180) as response:
                raw = json.load(response)
            save(out/f'{index:02}-response.json', raw)
            if raw.get('done_reason') == 'length':
                raise ValueError('Truncated response')
            d = decision(claim, json.loads(raw['response']))
            d['durationMs'] = round((time.perf_counter()-start)*1000)
            decisions.append(d)
            print(json.dumps(d), flush=True)
        except Exception as error:
            failure = f'{type(error).__name__}: {error}'
            break
    save(out/'decisions.json', {'decisions': decisions, 'failure': failure, 'llmCalls': index, 'modelForwards': 0})
    if failure:
        raise SystemExit(failure)
    run = read(args.input_dir/'local-baseline.json')
    by_id = {d['catalog_number']: d for d in decisions}
    for row in run['rows']:
        if (d := by_id.get(row['values']['catalog_number'])):
            row['values']['burial_axis'] = d['value']
            row['evidence']['burial_axis'] = d['evidence']
            row['verification'] = d
    elapsed = sum(d['durationMs'] for d in decisions)
    run['strategy'] = 'local-lexical-nuextract-label-verification-v2'
    run['verification'] = {'decisions': decisions, 'wallMs': elapsed, 'modelForwards': 0}
    run['calls'] += [{'model': 'nuextract', 'phase': 'verification', 'durationMs': d['durationMs'],
                     'status': 'succeeded', 'providerInvocations': 1} for d in decisions]
    run['durationMs'] += elapsed
    save(out/'result.json', run)


if __name__ == '__main__':
    main()
