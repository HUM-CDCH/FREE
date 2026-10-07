"""Bounded, offline-prepared Surya table experiment. Never changes the production parser.

Run against an existing local Surya server:
  .venv/bin/python evaluate_table_cells.py /tmp/native-result --url http://127.0.0.1:8000/v1 --output /tmp/table-eval
At most three table crops, two requests per crop, no retries, 3072 output tokens per request.
The native PDF supplies a reference grid, not an independent scanned-document benchmark.
"""
import argparse
import json
import time
from pathlib import Path
from urllib.parse import urlparse

import pypdfium2 as pdfium
from openai import OpenAI

from kei_exp.pagefile import load_result
from kei_exp.transcription.surya import _CompletionClient
from kei_exp.transcription.tables import table_of_html


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('result', type=Path)
    parser.add_argument('--pdf', type=Path, required=True)
    parser.add_argument('--url', required=True)
    parser.add_argument('--output', required=True, type=Path)
    args = parser.parse_args()
    if urlparse(args.url).hostname not in ('127.0.0.1', 'localhost', '::1'):
        parser.error('Use an existing local server for this bounded evaluation.')
    from surya.inference.backends.openai_client import _generate_one
    from surya.inference.schema import BatchOutputItem
    from surya.table_rec import TableRecPredictor
    loaded = load_result(args.result)
    manifest, pages = loaded.manifest, loaded.pages.values()
    from hashlib import sha256
    if sha256(args.pdf.read_bytes()).hexdigest() != manifest.recipe['source_sha256']:
        parser.error('The PDF must match the canonical result.')
    args.output.mkdir(parents=True, exist_ok=True)
    client = OpenAI(base_url=args.url, api_key='local', timeout=60, max_retries=0)
    models = client.models.list().data
    if len(models) != 1:
        parser.error('Use a server serving exactly one Surya model.')
    measured = []

    class Manager:
        def generate(self, batch):
            outputs = []
            for item in batch:
                item.max_tokens = 3072
                usage = _CompletionClient(client)
                started = time.monotonic()
                result = _generate_one(item, usage, models[0].id, 3072, 0, 0.1, 60, False)
                measured.append({'seconds': time.monotonic() - started, 'input_tokens': usage.input_tokens,
                                 'output_tokens': result.token_count, 'error': result.error})
                outputs.append(BatchOutputItem(raw=result.raw, token_count=result.token_count, error=result.error))
            return outputs

    predictor = TableRecPredictor(Manager())
    references = [(page, segment) for page in pages for segment in page.segments if segment.table]
    # The screenshot's repeated bones first, then the first two other tables.
    references.sort(key=lambda pair: (not (pair[0].page == 3 and '24-8' in pair[1].text), pair[0].page))
    report = []
    with pdfium.PdfDocument(str(args.pdf)) as pdf:
        for index, (page, segment) in enumerate(references[:3]):
            with pdf[page.page - 1] as physical:
                image = physical.render(scale=2).to_pil()
                crop = image.crop(tuple(round(v * 2) for v in segment.bbox_pt)).convert('L').convert('RGB')
            crop.save(args.output / f'{index}.png')
            modes = {}
            for mode in ('simple', 'full'):
                result = predictor([crop], mode=mode)[0]
                (args.output / f'{index}-{mode}.json').write_text(result.model_dump_json(indent=2))
                table = table_of_html(result.html) if result.html else None
                modes[mode] = {**measured[-1], 'rows': len(result.rows), 'columns': len(result.cols),
                               'cells': len(result.cells), 'html_cells': len(table['cells']) if table else 0}
            report.append({'page': page.page, 'reference_rows': segment.table.rows,
                           'reference_columns': segment.table.columns, 'reference_cells': len(segment.table.cells),
                           'modes': modes})
    (args.output / 'report.json').write_text(json.dumps(report, indent=2))


if __name__ == '__main__':
    main()
