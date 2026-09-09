#!/usr/bin/env python3
"""Build the human review sheet for the Danish-schema comparison.

Routing (decided 2026-09-09 with a second opinion): a decision is final
without human review only when the value is an exact alias or a
punctuation/inflection variant of a reviewed unit AND its record binding is
explicit AND its link, if any, was accepted as directly supporting that
record. Everything else is queued, in tiers: tier 1 holds every negative
decision (wrong-record, wrong-passage, unsupported, unbound record) and
every item the two agents decided differently, which are the decisions that
penalise an arm and can move a gate; tier 2 adds values and links accepted
by judgment; `--all` adds the mechanical ones.

The sheet hides the arm, the model and the prior agent decisions; a private
map keeps them for rescoring. Never calls a model."""
import argparse
import glob
import json
import random
from pathlib import Path

HERE = Path(__file__).resolve().parent
REPO = HERE.parents[4]
V2 = REPO / 'artifacts/catalog-lab/models-policy-v2'
DANISH = REPO / 'artifacts/catalog-lab/policy-v1-danish'
MECHANICAL = ('Punctuation/apostrophe-only variant', 'Source wording or inflection preserves', 'Same source-supported object, period or field value; article/label/inflection variant')
GENERIC_LINK = ('The linked passage states this value for the same grave.', 'The reviewed catalogue paragraph explicitly supports this field for the same numbered entry.')


def read(path):
    return json.loads(Path(path).read_text(encoding='utf-8-sig'))


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--out', type=Path, default=DANISH / 'review')
    parser.add_argument('--all', action='store_true', help='queue the mechanical decisions too')
    parser.add_argument('--tier', type=int, default=1, choices=[1, 2], help='1: negative decisions and disagreements; 2: also judgment-accepted')
    parser.add_argument('--documents', nargs='*', default=['Herredsvejen_SBM1694', 'Hojbakkegaard_TAK_1177', 'Hvissinge_Ost_TAK_1728', 'Katrinesminde_SBM1116'])
    args = parser.parse_args()
    items = {}
    for path in glob.glob(str(V2 / 'report-*/blind-review.json')):
        for item in read(path)['items']:
            items.setdefault(item['key'], {**item, 'source': 'candidate'})
    for item in read(DANISH / 'review-pending.json')['items'] if (DANISH / 'review-pending.json').exists() else []:
        items.setdefault(item['key'], {**item, 'source': 'per-record'})
    decisions = {}
    for path, who in [(V2 / 'adjudications-final.json', 'astra'), (DANISH / 'adjudications-rev2.json', 'claude')]:
        for key, decision in read(path)['decisions'].items():
            decisions.setdefault(key, {}).update({who: decision})
    schema = read(V2 / 'schemas.json')['schemas']['danish']
    descriptions = {node['name']: node['description'] for node in schema['schemaNodes']}
    refs = read(V2 / 'references-v1.json')['documents']
    queue, private = [], {}
    for key, item in items.items():
        if item.get('schema') != 'danish' or item['document'] not in args.documents:
            continue
        prior = decisions.get(key, {})
        reasons = ' '.join(d.get('reason', '') for d in prior.values())
        statuses = {d.get('status') or ('bound' if d.get('record') else 'unbound') for d in prior.values()}
        mechanical = (item['kind'] == 'value' and reasons.startswith(MECHANICAL)) or (item['kind'] == 'link' and statuses == {'supported'} and reasons.startswith(GENERIC_LINK))
        if not prior:
            mechanical = item['kind'] == 'value'  # matched an alias without a decision
        if mechanical and not args.all:
            continue
        negative = bool(statuses & {'unsupported', 'wrong-record', 'wrong-passage', 'unbound'}) or (item['kind'] == 'record')
        disagreement = len({json.dumps(d, sort_keys=True) for d in prior.values()}) > 1
        if args.tier == 1 and not args.all and not (negative or disagreement):
            continue
        record = next((r for r in refs[item['document']]['records'] if r['id'] == item.get('record')), None)
        units = [f"{i}: {' | '.join(a['aliases'])} (p. {', '.join(map(str, a['pages']))})" for i, a in enumerate(record['fields'][item['field']])] if record and item.get('field') else []
        entry = {'id': None, 'document': item['document'], 'kind': item['kind'], 'record': item.get('record'), 'field': item.get('field'),
                 'value': item.get('value'), 'heading': item.get('heading'), 'rule': descriptions.get(item.get('field')),
                 'referenceUnits': units, 'passage': item.get('text'), 'pages': sorted({p['page'] for p in item.get('passages', [])}),
                 'decision': {'value': None, 'unit': None, 'link': None, 'record': None, 'note': None}}
        queue.append((key, entry, prior, item['source']))
    random.Random(20260909).shuffle(queue)
    sheet, md = [], ['# Human review sheet: Danish-schema comparison', '',
                     'Decide each item from the source PDF; the arm that produced it is hidden. `value`: correct or unsupported. `unit`: the reference unit number the value matches (or "new" with the wording in `note`). `link`: supported, wrong-passage (right grave, passage does not state it) or wrong-record (passage belongs to another grave). `record`: for unbound records, the grave this record really is, or none.', '']
    for n, (key, entry, prior, source) in enumerate(queue, 1):
        entry['id'] = f'R{n:03d}'
        sheet.append({'key': key, **entry})
        private[entry['id']] = {'key': key, 'source': source, 'prior': prior}
        md += [f"## {entry['id']} · {entry['document'].split('_')[0]} · {entry['kind']}", f"- record: {entry['record'] or 'UNBOUND'}" + (f" (heading: {entry['heading']!r})" if entry.get('heading') else ''),
               f"- field: {entry['field']}" if entry['field'] else '', f"- value: {entry['value']!r}", f"- rule: {entry['rule']}" if entry['rule'] else '']
        if entry['referenceUnits']:
            md += ['- reference units: ' + '; '.join(entry['referenceUnits'])]
        if entry['passage']:
            md += [f"- linked passage (p. {', '.join(map(str, entry['pages']))}): {entry['passage'][:900]}"]
        md += ['']
    args.out.mkdir(parents=True, exist_ok=True)
    (args.out / 'review-sheet.json').write_text(json.dumps({'items': sheet}, ensure_ascii=False, indent=2), encoding='utf8')
    (args.out / 'review-sheet.md').write_text('\n'.join(line for line in md if line is not None), encoding='utf8')
    (args.out / 'private-map.json').write_text(json.dumps(private, ensure_ascii=False, indent=2), encoding='utf8')
    from collections import Counter
    print('queued', len(queue), dict(Counter(e['kind'] for _, e, _, _ in queue)), 'by source', dict(Counter(s for _, _, _, s in queue)))
    print('by document', dict(Counter(e['document'].split('_')[0] for _, e, _, _ in queue)))


if __name__ == '__main__':
    main()
