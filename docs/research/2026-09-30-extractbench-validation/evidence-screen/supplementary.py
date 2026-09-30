"""Supplementary, descriptive layers for the evidence screen; not part of the frozen decision rule. Offline.

Per sealed cell, from the run's reply cache: replies that parse as JSON versus replies that also satisfy the request's
reply schema, finish reasons, and whether each reply repeats the closed prior run's reply to the same prompt (same
system, user and schema), which says whether a pair is a new observation or a reproduction. Per run, the HTTP outcome
of every journalled completion attempt. Writes RUN_ROOT/supplementary.json (counts only).
Run from prototypes/parsing_service: python PATH/supplementary.py RUN_ROOT PRIOR_RUN_ROOT
"""
import hashlib
import json
import sys
from collections import Counter
from pathlib import Path

from jsonschema import Draft202012Validator

from experiments.extraction.manifest import read, write_new
from kei_exp.canonical import canonical_json

fingerprint = lambda r: hashlib.sha256(canonical_json([r.get('system'), r.get('user'), r.get('schema')])).hexdigest()


def main():
    root, prior_root = Path(sys.argv[1]).resolve(), Path(sys.argv[2]).resolve()
    prior = {}
    for path in (prior_root / 'out/cache').rglob('*.json'):
        entry = read(path)
        prior[fingerprint(entry['request'])] = entry['reply']['text']
    cells = {}
    for cell in sorted((root / 'out/cells').iterdir()):
        if not (cell / 'result.json').exists():
            continue
        layers = Counter()
        for key in read(cell / 'result.json')['artifact']['requests']:
            path = root / 'out/cache' / key[:2] / f'{key}.json'
            if not path.exists():       # a request that got no reply (failed or refused) is never cached
                layers['no_reply'] += 1
                continue
            entry = read(path)
            request, reply = entry['request'], entry['reply']
            layers['replies'] += 1
            layers[f"finish_{reply['finish']}"] += 1
            try:
                parsed = json.loads(reply['text'])
            except (TypeError, ValueError):
                continue
            layers['valid_json'] += 1
            layers['schema_valid'] += request.get('schema') is None or not any(Draft202012Validator(request['schema']).iter_errors(parsed))
            known = prior.get(fingerprint(request))
            layers['prompt_new_to_prior_run' if known is None else
                   'identical_to_prior_reply' if known == reply['text'] else 'different_from_prior_reply'] += 1
        cells[cell.name] = dict(layers)
    journal = [read(p) for p in sorted((root / 'request-journal').glob('*.finished.json'))]
    http = dict(Counter(j['status'] for j in journal) + Counter(f"finish_{j.get('finish')}" for j in journal))
    started = len(list((root / 'request-journal').glob('*.started.json')))
    result = {'label': 'supplementary, descriptive; not part of the frozen rule', 'journal': {'started': started, **http},
              'cells': cells}
    write_new(root / 'supplementary.json', result)
    print(json.dumps(result, indent=1))


if __name__ == '__main__':
    main()
