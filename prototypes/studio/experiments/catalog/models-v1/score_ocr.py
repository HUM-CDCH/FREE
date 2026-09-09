"""Source-reviewed excerpt CER and parent-start coverage, not parser agreement."""
import argparse
import json
import re
import unicodedata
from pathlib import Path

def normalize(text):
    text = re.sub(r'(?<=\w)-\s*\n\s*(?=\w)', '', text)
    text = unicodedata.normalize('NFC', text).translate(str.maketrans({'–': '-', '—': '-', '−': '-', '×': 'x'}))
    return re.sub(r'\s+', '', text)

def substring_distance(reference, text):
    """Minimum edit distance to any substring; surrounding page text is unscored."""
    previous = [0] * (len(text) + 1)
    for i, char in enumerate(reference, 1):
        row = [i]
        for j, other in enumerate(text, 1):
            row.append(min(row[-1]+1, previous[j]+1, previous[j-1] + (char != other)))
        previous = row
    return min(previous)

def score(directory, samples):
    outputs = {p.stem: json.loads(p.read_bytes()) for p in directory.glob('p*.json')}
    results = {}
    for mode in ['full', 'columns']:
        selected = {key: value for key, value in outputs.items() if ('-full' in key) == (mode == 'full')}
        found = []
        for item in selected.values():
            found.extend(int(x) for x in re.findall(r'(?m)^\s*(?:#{1,6}\s*|\*\*)?(\d{3})\.\s*[A-ZÄÖÜ]', item['text']))
        sample_scores = []
        for sample in samples:
            key = sample['image'].split('-')[0] + '-full' if mode == 'full' else sample['image']
            if key not in selected:
                continue
            reference = normalize(sample['text'])
            errors = substring_distance(reference, normalize(selected[key]['text']))
            sample_scores.append({'id': sample['id'], 'characters': len(reference), 'edits': errors, 'cer': errors/len(reference)})
        results[mode] = {'images': len(selected), 'seconds': sum(x['seconds'] for x in selected.values()),
                         'parentStartsFound': sorted(set(found) & set(range(205, 234))),
                         'duplicateStarts': sorted({x for x in found if found.count(x) > 1}),
                         'extraStarts': sorted(set(found) - set(range(205, 234))),
                         'tokenLimitImages': [k for k, v in selected.items() if v['hitTokenLimit']],
                         'samples': sample_scores}
    return results

if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('directory', type=Path)
    args = parser.parse_args()
    samples = json.loads(Path(__file__).with_name('ocr-samples.json').read_bytes())
    result = score(args.directory, samples)
    (args.directory / 'ocr-metrics.json').write_text(json.dumps(result, indent=2), encoding='utf-8')
    print(json.dumps(result, indent=2))
