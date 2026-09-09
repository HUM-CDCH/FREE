"""Freeze coarse visual evidence retrieval targets from source-reviewed anchors."""
import hashlib
import json
from pathlib import Path

ROOT = Path('artifacts/catalog-lab/beier/models-v1')
FIELDS = {'catalog_number': 'parent catalogue number', 'locality': 'main locality name',
          'locality_part': 'locality part after OT', 'findspot': 'findspot after Fdpl.',
          'map_sheet': 'first map sheet number after Mbl.', 'find_type': 'first parent FA find type',
          'burial_axis': 'explicit main KAK grave chamber or pit axis'}

if __name__ == '__main__':
    reference = json.loads(Path('prototypes/studio/experiments/catalog/beier.reference.json').read_bytes())
    document = json.loads((ROOT.parent / 'parsed_document.json').read_bytes())
    images = [x for x in json.loads((ROOT / 'images.json').read_bytes()) if x['column']]
    anchors = {a['block_id']: a for a in document['evidence_index']['anchors'] if a['kind'] == 'text'}
    queries, answers = [], []
    for row in reference['records']:
        values = dict(zip(reference['columns'], row['values']))
        for field, value in values.items():
            if value is None:
                continue
            index = row.get('map', row['header']) if field == 'map_sheet' else row['fa'] if field == 'find_type' else row['axis'] if field == 'burial_axis' else row['header']
            anchor = anchors[document['content_stream'][index]['block_id']]
            targets = set()
            for obs in anchor['producer_observations']:
                box = obs.get('bbox')
                if not box:
                    continue
                center = (box['x0'] + box['x1']) / 2
                for image in images:
                    if image['page'] == obs['page_number'] and image['bboxPt'][0] <= center < image['bboxPt'][2]:
                        targets.add(image['id'])
            assert targets
            ident = f'{values["catalog_number"]}:{field}'
            queries.append({'id': ident, 'text': f'Find the evidence for the {FIELDS[field]} of catalogue entry {values["catalog_number"]}.'})
            answers.append({'id': ident, 'relevant': sorted(targets), 'anchorId': anchor['anchor_id']})
    assert len(queries) == 164 and len(images) == 12
    for name, value in [('retrieval-input.json', {'queries': queries, 'candidates': images}), ('retrieval-reference.json', answers)]:
        with (ROOT / name).open('x', encoding='utf-8') as output:
            json.dump(value, output, ensure_ascii=False, indent=2)
    freeze = {name: hashlib.sha256((ROOT/name).read_bytes()).hexdigest() for name in ['retrieval-input.json', 'retrieval-reference.json', 'images.json']}
    (ROOT / 'retrieval-freeze.json').write_text(json.dumps(freeze, indent=2))
    # Source-reviewed fixture corrections (2026-09-08), fixed before retrieval:
    # the old paragraph anchors include continuation columns without these fields.
    overrides = {208: 'p1-c2', 214: 'p1-c4', 217: 'p2-c2'}
    corrections = []
    for row in answers:
        if len(row['relevant']) > 1:
            location = overrides[int(row['id'].split(':')[0])]
            corrections.append({'id': row['id'], 'before': row['relevant'], 'after': [location]})
            row['relevant'] = [location]
    with (ROOT / 'retrieval-reference-reviewed.json').open('x', encoding='utf-8') as output:
        json.dump({'status': 'Agent source-reviewed; not independently human-adjudicated.',
                   'corrections': corrections, 'rows': answers}, output, indent=2)
    print('Frozen 164 answer-free queries and 12 visual column candidates')
