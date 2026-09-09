#!/usr/bin/env python3
"""Score each run's evidence links against a labelled sheet from sheet.py.

Per populated value: correct evidence (link within the accepted anchors),
wrong anchor (supported value, link outside them), missing (supported value,
no link), unsupported linked (an extractor error the link hides) and correct
abstain. Links made in code (never sent to the grounder) are scored
separately from links the model chose, which is gate G5."""
import argparse
import json
import unicodedata
from collections import Counter
from pathlib import Path


def normalize(value):
    return unicodedata.normalize('NFKC', str(value)).casefold().strip()


def populated_paths(value, path=()):
    if isinstance(value, list):
        for index, entry in enumerate(value):
            yield from populated_paths(entry, path + (index,))
    elif isinstance(value, dict):
        for key, entry in value.items():
            yield from populated_paths(entry, path + (key,))
    elif value is not None and value != '' and isinstance(value, (str, int, float, bool)):
        yield path


def score(run, labels):
    terminal = json.loads((run / 'terminal.json').read_text(encoding='utf8'))
    result = terminal.get('result') or {}
    records = [r for r in (terminal.get('diagnostics', {}).get('catalog') or {}).get('records', []) if r['outcome'] == 'succeeded']
    rows = result.get('records') or []
    links = {}
    for link in terminal.get('evidence') or []:
        links.setdefault(tuple(link['resultPath']), []).append(link['evidenceAnchorId'])
    # Claim labels C1.. follow populatedContentPaths order; grounding calls record which labels the model saw.
    paths = list(populated_paths(result))
    calls = json.loads((run / 'calls.json').read_text(encoding='utf8')) if (run / 'calls.json').exists() else []
    model_labels = {label for call in calls if call.get('phase') == 'grounding' for label in call.get('claimLabels') or []}
    model_paths = {paths[int(label[1:]) - 1] for label in model_labels if label.startswith('C') and int(label[1:]) <= len(paths)}
    by_route = {'code': Counter(), 'model': Counter(), 'all': Counter()}
    unlabelled = 0
    for index, (record, row) in enumerate(zip(records, rows)):
        for field, value in row.items():
            if value is None or value == '' or isinstance(value, (dict, list)):
                continue
            path = ('records', index, field)
            label = labels.get((record['boundary']['startBlockId'], field, normalize(value)))
            if label is None or label.get('goldAnchorIds') is None:
                unlabelled += 1
                continue
            gold = set(label['goldAnchorIds'])
            linked = links.get(path, [])
            route = 'model' if path in model_paths or not model_labels else 'code'
            if gold:
                outcome = 'missing' if not linked else 'correct' if set(linked) <= gold else 'wrongAnchor'
            else:
                outcome = 'unsupportedLinked' if linked else 'correctAbstain'
            for bucket in (route, 'all'):
                by_route[bucket][outcome] += 1
                by_route[bucket]['values'] += 1
    return {'run': run.name, 'unlabelled': unlabelled, **{route: dict(counter) for route, counter in by_route.items()}}


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--sheet', type=Path, required=True, help='labelled sheet.json')
    parser.add_argument('runs', type=Path, nargs='+')
    args = parser.parse_args()
    sheet = json.loads(args.sheet.read_text(encoding='utf8'))
    labels = {(c['recordStartBlockId'], c['field'], normalize(c['value'])): c for c in sheet['claims']}
    for run in args.runs:
        print(json.dumps(score(run, labels), ensure_ascii=False))


if __name__ == '__main__':
    main()
