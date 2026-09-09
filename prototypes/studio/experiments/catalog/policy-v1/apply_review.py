#!/usr/bin/env python3
"""Turn a filled review sheet into an adjudications file for score_danish.py.

Input: the sheet's review-sheet.json with each item's `decision` filled
(`value`: correct|unsupported with `unit`; `link`: supported|wrong-passage|
wrong-record; `record`: grave id or none) and an optional `note`. Output:
{reviewer, decisions} keyed by the sheet's review keys, applied to both arms."""
import argparse
import json
from pathlib import Path


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('sheet', type=Path)
    parser.add_argument('--out', type=Path, required=True)
    parser.add_argument('--reviewer', required=True)
    args = parser.parse_args()
    decisions, skipped = {}, 0
    for item in json.loads(args.sheet.read_text(encoding='utf8'))['items']:
        d = item['decision']; note = d.get('note') or ''
        if item['kind'] == 'record':
            if d.get('record') is None and not note:
                skipped += 1; continue
            decisions[item['key']] = {'record': None if d.get('record') in (None, 'none') else d['record'], 'reason': note}
        elif item['kind'] == 'value':
            if d.get('value') not in ('correct', 'unsupported'):
                skipped += 1; continue
            decisions[item['key']] = {'status': d['value'], 'reason': note, **({'matches': [int(d['unit'])]} if d['value'] == 'correct' else {})}
        else:
            if d.get('link') not in ('supported', 'wrong-passage', 'wrong-record'):
                skipped += 1; continue
            decisions[item['key']] = {'status': d['link'], 'reason': note}
    args.out.write_text(json.dumps({'reviewer': args.reviewer, 'decisions': decisions, 'extensions': []}, ensure_ascii=False, indent=2), encoding='utf8')
    print('decisions', len(decisions), 'undecided', skipped)


if __name__ == '__main__':
    main()
