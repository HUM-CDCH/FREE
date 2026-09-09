#!/usr/bin/env python3
"""Build one blind labelling sheet per document from several runs' terminal.json.

Each distinct (record start, field, value) claim appears once, with the
record's candidate anchors in reading order and no trace of which arm emitted
it or which anchor any arm linked. The labeller fills `goldAnchorIds` with
every anchor a reviewer would accept, or `[]` plus `kind` (a: never stated,
b: stated under another meaning, c: computed or paraphrased)."""
import argparse
import json
import unicodedata
from pathlib import Path


def record_candidates(document, boundary):
    blocks = document['content_stream'][boundary['startContentIndex']:boundary['endContentIndex']]
    block_ids = {b['block_id'] for b in blocks}
    table_ids = {b['table_id'] for b in blocks if b.get('kind') == 'table'}
    text_by_block = {b['block_id']: b.get('text') or ' '.join(b.get('items') or []) for b in document['content_stream']}
    cells = {}
    for table in document.get('tables', []):
        for cell in table.get('cells', []):
            cells[(table['table_id'], cell.get('row'), cell.get('column'))] = cell.get('text', '')
    out = []
    for anchor in document['evidence_index']['anchors']:
        if anchor['kind'] == 'text' and anchor['block_id'] in block_ids:
            out.append({'anchorId': anchor['anchor_id'], 'text': text_by_block.get(anchor['block_id'], '')})
        elif anchor['kind'] != 'text' and anchor.get('logical_table_id') in table_ids:
            out.append({'anchorId': anchor['anchor_id'], 'text': cells.get((anchor['logical_table_id'], anchor.get('row'), anchor.get('column')), anchor.get('text', ''))})
    return out


def normalize(value):
    return unicodedata.normalize('NFKC', str(value)).casefold().strip()


def populated(record):
    for field, value in record.items():
        if value is None or value == '' or isinstance(value, (dict, list)):
            continue
        yield field, value


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--document', type=Path, required=True)
    parser.add_argument('--out', type=Path, required=True)
    parser.add_argument('runs', type=Path, nargs='+', help='run directories holding terminal.json')
    args = parser.parse_args()
    document = json.loads(args.document.read_text(encoding='utf8'))
    claims = {}
    for run in args.runs:
        terminal = json.loads((run / 'terminal.json').read_text(encoding='utf8'))
        records = [r for r in (terminal.get('diagnostics', {}).get('catalog') or {}).get('records', []) if r['outcome'] == 'succeeded']
        rows = (terminal.get('result') or {}).get('records') or []
        if len(records) != len(rows):
            raise SystemExit(f'{run}: {len(records)} succeeded records but {len(rows)} result rows')
        for record, row in zip(records, rows):
            boundary = record['boundary']
            for field, value in populated(row):
                key = (boundary['startBlockId'], field, normalize(value))
                claim = claims.setdefault(key, {
                    'claimId': f"{len(claims) + 1:04d}",
                    'recordStartBlockId': boundary['startBlockId'],
                    'recordHeading': next((b.get('text') for b in document['content_stream'] if b['block_id'] == boundary['startBlockId']), None),
                    'field': field,
                    'value': value,
                    'candidates': record_candidates(document, boundary),
                    'goldAnchorIds': None,
                    'kind': None,
                    'note': None,
                })
                claim.setdefault('_values', set()).add(json.dumps(value, ensure_ascii=False))
    sheet = []
    for claim in sorted(claims.values(), key=lambda c: c['claimId']):
        claim.pop('_values', None)
        sheet.append(claim)
    args.out.write_text(json.dumps({'document': args.document.name, 'instructions': __doc__, 'claims': sheet}, ensure_ascii=False, indent=2), encoding='utf8')
    print(f'{len(sheet)} distinct claims from {len(args.runs)} runs -> {args.out}')


if __name__ == '__main__':
    main()
