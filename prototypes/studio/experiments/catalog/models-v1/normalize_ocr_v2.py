"""Plain-text revision: native layout plus Markdown headings/emphasis removal."""
import argparse
import hashlib
import json
import re
from pathlib import Path
from normalize_ocr import unwrap


def plain_text(text):
    text = re.sub(r'(?m)^\s*#{1,6}\s+', '', text)
    return re.sub(r'(\*{1,2})(?=\S)([^\n]+?)(?<=\S)\1', r'\2', text)


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('directory', type=Path)
    args = parser.parse_args()
    out = args.directory / 'plain-v2'
    out.mkdir(exist_ok=False)
    for file in args.directory.glob('p[123]-*.json'):
        item = json.loads(file.read_bytes())
        item['text'], item['nativeLayout'] = unwrap(item['text'])
        item['text'] = plain_text(item['text'])
        item['rawSha256'] = hashlib.sha256(file.read_bytes()).hexdigest()
        (out / file.name).write_text(json.dumps(item, ensure_ascii=False, indent=2), encoding='utf-8')
    (out / 'normalization.json').write_text(json.dumps({
        'codeSha256': hashlib.sha256(Path(__file__).read_bytes()).hexdigest(),
        'reason': 'Markdown emphasis around names hid parent starts from the frozen scorer. Applied uniformly before downstream inference; no OCR letter correction.',
    }, indent=2), encoding='utf-8')
