"""Unwrap native Nemotron layout tokens for the shared text-only OCR scorer."""
import argparse
import hashlib
import json
import re
from pathlib import Path

def unwrap(text):
    pattern = r'<x_(\d+(?:\.\d+)?)><y_(\d+(?:\.\d+)?)>(.*?)<x_(\d+(?:\.\d+)?)><y_(\d+(?:\.\d+)?)><class_([^>]+)>'
    # Same element grammar as the checkpoint's official extract_classes_bboxes.
    elements = re.findall(pattern, text, re.DOTALL)
    if not elements:
        return text, []
    return '\n\n'.join(e[2] for e in elements), [
        {'bbox': [float(e[0]), float(e[1]), float(e[3]), float(e[4])], 'class': e[5], 'text': e[2]} for e in elements]

if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('directory', type=Path)
    args = parser.parse_args()
    out = args.directory / 'plain'
    out.mkdir(exist_ok=False)
    for file in args.directory.glob('p*.json'):
        item = json.loads(file.read_bytes())
        item['text'], item['nativeLayout'] = unwrap(item['text'])
        item['rawSha256'] = hashlib.sha256(file.read_bytes()).hexdigest()
        (out / file.name).write_text(json.dumps(item, ensure_ascii=False, indent=2), encoding='utf-8')
