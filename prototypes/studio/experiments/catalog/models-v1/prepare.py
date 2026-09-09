"""Render fixed OCR inputs using the existing automatic column detector."""
import ast
import hashlib
import json
from contextlib import closing
from pathlib import Path
from typing import Any
import pypdfium2 as pdfium

ROOT = Path('artifacts/catalog-lab/beier/models-v1')

if __name__ == '__main__':
    source = Path('prototypes/parsing_service/app/docling_parser.py').read_text(encoding='utf-8')
    node = next(n for n in ast.parse(source).body if isinstance(n, ast.FunctionDef) and n.name == '_scanned_column_cuts')
    # Reuse the exact function without importing the Docling service and its runtime.
    namespace = {'Any': Any}
    exec(compile(ast.Module(body=[node], type_ignores=[]), '<existing-column-detector>', 'exec'), namespace)
    detector = namespace['_scanned_column_cuts']
    out = ROOT / 'images'
    out.mkdir(parents=True, exist_ok=True)
    if (ROOT / 'images.json').exists():
        raise FileExistsError('Image inventory already prepared')
    inventory = []
    with closing(pdfium.PdfDocument('artifacts/catalog-lab/beier/source.pdf')) as pdf:
        for index in range(len(pdf)):
            page = pdf[index]
            width, height = page.get_size()
            preview = page.render(scale=min(1, 1600 / width)).to_pil()
            cuts = detector(preview, width)
            assert len(cuts) == 3, (index, cuts)
            image = page.render(scale=200/72).to_pil().convert('RGB')
            bounds = [0, *cuts, width]
            for column, (left, right) in enumerate([(0, width), *zip(bounds, bounds[1:])]):
                name = f'p{index+1}-' + (f'c{column}' if column else 'full')
                box = [round(left / width * image.width), 0, round(right / width * image.width), image.height]
                target = out / (name + '.png')
                image.crop(box).save(target)
                inventory.append({'id': name, 'path': str(target), 'page': index+1,
                                  'column': column, 'bboxPt': [left, 0, right, height],
                                  'sha256': hashlib.sha256(target.read_bytes()).hexdigest()})
    (ROOT / 'images.json').write_text(json.dumps(inventory, indent=2), encoding='utf-8')
    (ROOT / 'column-detector.py').write_text(ast.get_source_segment(source, node), encoding='utf-8')
    print('Rendered', len(inventory), 'inputs')
