"""Prepare immutable PDF inputs and experiment-only canonical OCR representations."""
import argparse
import ast
import copy
import hashlib
import json
import shutil
import sys
from contextlib import closing
from pathlib import Path
from typing import Any

from common import DEFAULT_ROOT, DOCS, HERE, OCR, OLD, REPO, REVISIONS, check_freeze, original, read, save, sha, verify

sys.path.insert(0, str(HERE.parent / 'models-v1'))
from normalize_ocr import unwrap
from normalize_ocr_v2 import plain_text


def source_pdf(doc):
    return (original(doc) / 'source.pdf' if doc == 'beier' else REPO / 'examples/graves' / f'{doc}.pdf')


def prepare_inputs(root):
    import pypdfium2 as pdfium
    source = (REPO / 'prototypes/parsing_service/app/docling_parser.py').read_text(encoding='utf8')
    node = next(n for n in ast.parse(source).body if isinstance(n, ast.FunctionDef) and n.name == '_scanned_column_cuts')
    namespace = {'Any': Any}
    exec(compile(ast.Module(body=[node], type_ignores=[]), '<existing-column-detector>', 'exec'), namespace)
    detector = namespace['_scanned_column_cuts']
    for doc in DOCS:
        out = root / 'inputs' / doc
        out.mkdir(parents=True, exist_ok=True)
        if (out / 'manifest.json').exists():
            for path, digest in read(out / 'manifest.json')['hashes'].items():
                if sha(path) != digest:
                    raise ValueError(f'Prepared input changed: {path}')
            continue
        pdf_path = source_pdf(doc)
        baseline_path = original(doc) / 'parsed_document.json'
        baseline = read(baseline_path)
        if sha(pdf_path) != baseline['document']['content_sha256']:
            raise ValueError(f'PDF and canonical document disagree: {doc}')
        (out / 'baseline').mkdir(exist_ok=True)
        shutil.copyfile(baseline_path, out / 'baseline/parsed_document.json')
        images = []
        if doc == 'beier':
            for item in read(OLD / 'images.json'):
                if not item['column']:
                    continue
                if sha(item['path']) != item['sha256']:
                    raise ValueError(f'Historical image changed: {item["id"]}')
                images.append(item)
        else:
            (out / 'images').mkdir(exist_ok=True)
            with closing(pdfium.PdfDocument(str(pdf_path))) as pdf:
                for page_index in range(len(pdf)):
                    page = pdf[page_index]
                    width, height = page.get_size()
                    preview = page.render(scale=min(1, 1600 / width)).to_pil()
                    # The existing detector itself rejects non-landscape/non-four-column pages.
                    cuts = detector(preview, width)
                    bounds = [0, *cuts, width] if len(cuts) == 3 else [0, width]
                    rendered = page.render(scale=200 / 72).to_pil().convert('RGB')
                    for index, (left, right) in enumerate(zip(bounds, bounds[1:]), 1):
                        column = index if cuts and len(cuts) == 3 else 0
                        ident = f'p{page_index + 1}-' + (f'c{column}' if column else 'full')
                        path = out / 'images' / f'{ident}.png'
                        pixel_box = (round(left / width * rendered.width), 0, round(right / width * rendered.width), rendered.height)
                        rendered.crop(pixel_box).save(path)
                        images.append({'id': ident, 'path': str(path.resolve()), 'page': page_index + 1,
                                       'column': column, 'bboxPt': [left, 0, right, height], 'sha256': sha(path)})
        save(out / 'images.json', images)
        paths = [pdf_path, baseline_path, out / 'baseline/parsed_document.json', out / 'images.json',
                 *[Path(item['path']) for item in images]]
        save(out / 'manifest.json', {'document': doc, 'pdf': str(pdf_path),
                                    'hashes': {str(p.resolve()): sha(p) for p in paths}})
        print('PREPARED', doc, len(images), 'images', flush=True)


def verified_reuse(root, model):
    """Reuse only the complete saved column protocol and its selected image hashes."""
    source = OLD / f'{model}-desktop2000-r1'
    manifest = read(source / 'manifest.json')
    protocol = read(source / 'desktop-protocol.json')
    if manifest['status'] != 'completed' or protocol['longestEdgePixels'] != 2000 or manifest['revision'] != REVISIONS[model]:
        raise ValueError(f'Unusable historical OCR protocol: {model}')
    selected = read(root / 'inputs/beier/images.json')
    historical = {image['id']: image for image in manifest['images']}
    output = root / 'ocr' / model / 'beier'
    if (output / 'manifest.json').exists():
        for path, digest in read(output / 'manifest.json')['reusedHashes'].items():
            if sha(path) != digest:
                raise ValueError(f'Reused OCR changed: {path}')
        return
    output.mkdir(parents=True, exist_ok=True)
    hashes = {str(source / 'manifest.json'): sha(source / 'manifest.json'),
              str(source / 'desktop-protocol.json'): sha(source / 'desktop-protocol.json')}
    for image in selected:
        if historical[image['id']]['sha256'] != image['sha256']:
            raise ValueError('Historical OCR does not use the selected image')
        raw = source / f'{image["id"]}.json'
        value = read(raw)
        if value['hitTokenLimit'] or value['seconds'] >= 600:
            raise ValueError(f'Cannot reuse truncated OCR: {raw}')
        hashes[str(raw)] = sha(raw)
        shutil.copyfile(raw, output / raw.name)
    save(output / 'manifest.json', {**manifest, 'images': selected, 'reused': True,
                                    'reusedHashes': hashes, 'currentInferenceSeconds': 0})


def canonical_ocr(baseline, images, outputs, model):
    """Line anchors have honest crop geometry; native layout remains in raw artifacts."""
    signature = hashlib.sha256(json.dumps([model, images, outputs], ensure_ascii=False, sort_keys=True).encode()).hexdigest()
    result = copy.deepcopy(baseline)
    preprocess = f'models-policy-v2-{model}-{signature[:16]}'
    result['preprocessing'] = {'preprocess_id': preprocess, 'profile': 'experimental-native-ocr-crop-geometry',
                               'service_version': None, 'started_at': None, 'finished_at': None,
                               'status': 'completed', 'warnings': ['Evidence boxes localize a source crop, not an OCR line.']}
    result['tables'] = []
    result['content_stream'] = []
    result['evidence_index'] = {'anchors': []}
    result['diagnostics'] = []
    result['parser_runs'] = [{'parser': model, 'version': None, 'status': 'success', 'warnings': [], 'error': None}]
    result['arbitration'] = {'experiment': 'models-policy-v2', 'localizationGranularity': 'crop'}
    for page in result['pages']:
        page.update(ordered_content=[], unplaced_content=[], markdown_span=None)
    markdown, offset = [], 0
    for image, output in zip(images, outputs, strict=True):
        if image['id'] != output['id']:
            raise ValueError('OCR output order does not match the image inventory')
        if output.get('hitTokenLimit') or output.get('timeLimited') or output.get('failed'):
            result['preprocessing']['status'] = 'completed_with_warnings'
            result['preprocessing']['warnings'].append(f'Incomplete OCR image {image["id"]}')
        text, _layout = unwrap(output.get('text', ''))
        text = plain_text(text)
        page = result['pages'][image['page'] - 1]
        x0, y0, x1, y1 = image['bboxPt']
        # PDFium and the parser differ by a few float32 ULPs at page edges.
        if not (-0.001 <= x0 < x1 <= page['width_pt'] + 0.001 and -0.001 <= y0 < y1 <= page['height_pt'] + 0.001):
            raise ValueError('Image crop lies outside original PDF page')
        x0, y0, x1, y1 = max(0, x0), max(0, y0), min(page['width_pt'], x1), min(page['height_pt'], y1)
        box = dict(zip(('x0', 'y0', 'x1', 'y1'), (x0, y0, x1, y1)))
        for line_index, line in enumerate(text.splitlines()):
            line = line.strip()
            if not line:
                continue
            block_id = f'{preprocess}-{image["id"]}-l{line_index}'
            span = {'start': offset, 'end': offset + len(line.encode('utf8'))}
            offset = span['end'] + 1
            markdown.append(line)
            result['content_stream'].append({'kind': 'paragraph', 'block_id': block_id,
                'page_number': image['page'], 'parser': model, 'bbox': box, 'markdown_span': span, 'text': line})
            page['ordered_content'].append(block_id)
            result['evidence_index']['anchors'].append({'kind': 'text', 'anchor_id': f'a-{block_id}',
                'content_sha256': result['document']['content_sha256'], 'preprocess_id': preprocess,
                'block_id': block_id, 'markdown_span': span,
                'producer_observations': [{'occurrence_id': f'o-{block_id}', 'page_number': image['page'],
                    'producer_ref': f'{image["id"]}:line:{line_index}', 'bbox': box}]})
    return result, '\n'.join(markdown)


def convert(root, model, doc):
    if (root / 'freeze.json').exists():
        check_freeze(root)
    raw_dir = root / 'ocr' / model / doc
    out = root / 'inputs' / doc / model
    manifest = read(raw_dir / 'manifest.json')
    images = read(root / 'inputs' / doc / 'images.json')
    paths = [raw_dir / f'{image["id"]}.json' for image in images]
    outputs = [read(path) for path in paths]
    verify({i['path']:i['sha256'] for i in images})
    verify(manifest.get('outputHashes', manifest.get('reusedHashes', {})))
    if manifest['revision'] != REVISIONS[model]:
        raise ValueError('OCR checkpoint revision changed')
    for image, output in zip(images, outputs, strict=True):
        if not manifest.get('reused') and output.get('imageSha256') != image['sha256']:
            raise ValueError('Raw OCR image hash does not match the selected crop')
        if manifest.get('reused') and next(i for i in manifest['images'] if i['id'] == image['id']) != image:
            raise ValueError('Reused OCR image metadata changed')
    result, markdown = canonical_ocr(read(root / 'inputs' / doc / 'baseline/parsed_document.json'), images, outputs, model)
    out.mkdir(parents=True, exist_ok=True)
    save(out / 'parsed_document.json', result)
    with (out / 'document.md').open('x', encoding='utf8') as target:
        target.write(markdown)
    save(out / 'manifest.json', {'rawHashes': {str(path): sha(path) for path in paths},
                                'reused': manifest.get('reused', False), 'localizationGranularity': 'crop',
                                'ocrSeconds': sum(output.get('seconds', 0) for output in outputs),
                                'loadSeconds': manifest.get('loadSeconds'),
                                'warnings': result['preprocessing']['warnings'],
                                'sha256': sha(out / 'parsed_document.json')})


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('command', choices=['inputs', 'reuse', 'convert'])
    parser.add_argument('--root', type=Path, default=DEFAULT_ROOT)
    parser.add_argument('--model', choices=OCR)
    parser.add_argument('--document', choices=DOCS)
    args = parser.parse_args()
    root = args.root.resolve()
    if args.command == 'inputs':
        prepare_inputs(root)
    elif args.command == 'reuse':
        for model in OCR:
            verified_reuse(root, model)
            convert(root, model, 'beier')
    else:
        if not args.model or not args.document:
            parser.error('convert requires --model and --document')
        convert(root, args.model, args.document)
