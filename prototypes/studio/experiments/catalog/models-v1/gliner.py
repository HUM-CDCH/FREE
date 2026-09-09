"""Seven-field native span extraction over all frozen record boundaries."""
import argparse
import hashlib
import json
import os
import re
import time
from pathlib import Path

ROOT = Path('artifacts/catalog-lab/beier/models-v1')
DESCRIPTIONS = {
    'catalog_number': 'Integer before the main locality in the numbered parent catalogue entry heading.',
    'locality': 'Main place name in the parent heading; exclude the district name after OT.',
    'locality_part': 'Locality part name after OT in the parent heading; absent when there is no OT.',
    'findspot': 'All text after Fdpl. before Mbl. in the parent heading, including its number or literal u.',
    'map_sheet': 'First four-digit map sheet number after Mbl. in the parent heading; exclude parenthesized alternatives.',
    'find_type': 'First parent FA code: EF, G, EvG, vG or Siedl.; not a later sub-find type.',
    'burial_axis': 'Explicit MAIN KAK grave chamber or pit axis O-W, N-S, NW-SO or NO-SW. Exclude slope, mound extent, facing, side names, coordinates, cattle orientation and possibly unrelated pavement. Absent if no explicit main grave axis.',
}

def select(text, spans, field):
    valid = [s for s in spans if isinstance(s.get('start'), int) and isinstance(s.get('end'), int)
             and 0 <= s['start'] < s['end'] <= len(text) and text[s['start']:s['end']] == s.get('text')]
    valid.sort(key=lambda s: s['start'])
    if not valid:
        return None, None
    span = valid[0]
    value = span['text'].strip()
    if field in ('catalog_number', 'map_sheet'):
        if not re.fullmatch(r'\d+\.?', value):
            return None, None
        value = int(value.rstrip('.'))
    return value, span

def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--run', default='r1')
    args = parser.parse_args()
    out = ROOT / f'gliner-extraction-{args.run}'
    out.mkdir(exist_ok=False)
    os.environ['HF_HUB_OFFLINE'] = '1'
    os.environ['TRANSFORMERS_OFFLINE'] = '1'
    import torch
    from gliner2 import AutoExtractor
    document_bytes = Path('artifacts/catalog-lab/beier/parsed_document.json').read_bytes()
    document = json.loads(document_bytes)
    original = json.loads(Path('artifacts/catalog-lab/beier/desktop-b3-r3/result.json').read_bytes())
    assert hashlib.sha256(document_bytes).hexdigest() == original['inputSha256']
    anchors = {a['block_id']: a['anchor_id'] for a in document['evidence_index']['anchors'] if a['kind'] == 'text'}
    started = time.perf_counter()
    torch.manual_seed(0)
    model = AutoExtractor.from_pretrained('artifacts/catalog-lab/beier/verification-v1/gliner-checkpoint', map_location='cuda').eval()
    torch.cuda.synchronize()
    load_seconds = time.perf_counter() - started
    forwards = []
    current = [None]
    model.encoder.register_forward_pre_hook(lambda *_: forwards.append(current[0]))
    schema = model.create_schema().entities(DESCRIPTIONS)
    rows = []
    durations = []
    for boundary in original['boundaries']:
        text, blocks = '', []
        for block in document['content_stream'][boundary['startContentIndex']:boundary['endContentIndex']]:
            if 'text' not in block:
                continue
            if text:
                text += '\n\n'
            start = len(text)
            text += block['text']
            blocks.append({'start': start, 'end': len(text), 'anchorId': anchors.get(block['block_id'])})
        current[0] = boundary['headingText']
        input_tokens = len(model.processor.tokenizer.encode(text + json.dumps(DESCRIPTIONS), add_special_tokens=False))
        if input_tokens + 128 > model.config.max_len:
            raise ValueError(f'Record exceeds context: {current[0]}')
        started = time.perf_counter()
        with torch.inference_mode():
            raw = model.extract(text, schema, include_spans=True, include_confidence=True)
        torch.cuda.synchronize()
        durations.append(time.perf_counter() - started)
        row = {'values': {}, 'evidence': {}, 'issues': [], 'nativeSpans': raw}
        for field in DESCRIPTIONS:
            value, span = select(text, raw.get('entities', {}).get(field, []), field)
            row['values'][field] = value
            support = [b['anchorId'] for b in blocks if span and b['anchorId'] and b['start'] <= span['start'] < span['end'] <= b['end']]
            row['evidence'][field] = support
            if value is not None and not support:
                row['issues'].append('ungrounded:' + field)
        rows.append(row)
        (out / f'{len(rows):02}.json').write_text(json.dumps({'text': text, 'descriptions': DESCRIPTIONS, 'blocks': blocks, 'raw': raw, 'seconds': durations[-1]}, indent=2, ensure_ascii=False), encoding='utf-8')
        print(len(rows), row['values'], round(durations[-1], 3), flush=True)
    result = {'rows': rows, 'boundaries': original['boundaries'], 'inputSha256': original['inputSha256'],
              'strategy': 'gliner-native-spans', 'model': 'fastino/gliner2.5-multi-v1',
              'calls': [], 'failure': None, 'durationMs': round(sum(durations)*1000),
              'loadSeconds': load_seconds, 'encoderForwards': forwards,
              'codeSha256': hashlib.sha256(Path(__file__).read_bytes()).hexdigest(),
              'checkpointRevision': 'aaecfe45db1d828c963717054ccb868e8ad1f1d5'}
    (out / 'result.json').write_text(json.dumps(result, ensure_ascii=False, indent=2), encoding='utf-8')

if __name__ == '__main__':
    main()
