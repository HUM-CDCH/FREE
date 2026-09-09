"""Native OCR APIs, serial inference, immutable outputs and per-image timings."""
import argparse
import hashlib
import importlib.metadata
import json
import os
import platform
import time
import traceback
from pathlib import Path

ROOT = Path('artifacts/catalog-lab/beier/models-v1')
PROMPTS = {
    'nanonets': 'Extract the text from the above document as if you were reading it naturally. Return the tables in html format. Return the equations in LaTeX representation. If there is an image in the document and image caption is not present, add a small description of the image inside the <img></img> tag; otherwise, add the image caption inside <img></img>. Watermarks should be wrapped in brackets. Ex: <watermark>OFFICIAL COPY</watermark>. Page numbers should be wrapped in brackets. Ex: <page_number>14</page_number> or <page_number>9/22</page_number>. Prefer using ☐ and ☑ for check boxes.',
    'navidc': 'Please output the text content from the image.',
    'hunyuan': '提取文档图片中正文的所有信息用markdown格式表示，其中页眉、页脚部分忽略，表格用html格式表达，文档中公式用latex格式表示，按照阅读顺序组织进行解析。',
    'nemotron': '</s><s><predict_bbox><predict_classes><output_markdown><predict_no_text_in_pic>',
}

def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('model', choices=PROMPTS)
    parser.add_argument('--run', default='r1')
    parser.add_argument('--images', nargs='*')
    args = parser.parse_args()
    out = ROOT / f'{args.model}-{args.run}'
    out.mkdir(exist_ok=False)
    checkpoint = ROOT / 'checkpoints' / args.model
    metadata = json.loads((ROOT / 'sources' / args.model / 'metadata.json').read_bytes())
    images = json.loads((ROOT / 'images.json').read_bytes())
    if args.images:
        images = [i for i in images if i['id'] in args.images]
    manifest = {'model': metadata['id'], 'revision': metadata['sha'], 'prompt': PROMPTS[args.model],
                'python': platform.python_version(), 'images': images,
                'codeSha256': hashlib.sha256(Path(__file__).read_bytes()).hexdigest(),
                'packages': {p: importlib.metadata.version(p) for p in ['torch', 'transformers', 'torchvision']}}
    (out / 'manifest.json').write_text(json.dumps(manifest, indent=2, ensure_ascii=False), encoding='utf-8')
    os.environ['HF_HUB_OFFLINE'] = '1'
    os.environ['HF_HOME'] = str((ROOT / 'hf-cache').resolve())
    import torch
    from PIL import Image
    from transformers import AutoModel, AutoModelForImageTextToText, AutoProcessor
    torch.manual_seed(0)
    started = time.perf_counter()
    try:
        processor = AutoProcessor.from_pretrained(str(checkpoint), trust_remote_code=args.model in ('navidc', 'nemotron'), local_files_only=True)
        cls = AutoModel if args.model in ('navidc', 'nemotron') else AutoModelForImageTextToText
        model = cls.from_pretrained(str(checkpoint), torch_dtype=torch.bfloat16,
                                   trust_remote_code=args.model in ('navidc', 'nemotron'),
                                   attn_implementation='sdpa', local_files_only=True).to('cuda').eval()
        torch.cuda.synchronize()
        manifest['loadSeconds'] = time.perf_counter() - started
        manifest['gpu'] = torch.cuda.get_device_name()
        manifest['attention'] = 'sdpa'
        for item in images:
            started = time.perf_counter()
            torch.cuda.reset_peak_memory_stats()
            image = Image.open(item['path']).convert('RGB')
            if args.model == 'nemotron':
                inputs = processor(images=[image], text=PROMPTS[args.model], return_tensors='pt', add_special_tokens=False)
            else:
                messages = [{'role': 'user', 'content': [{'type': 'image'}, {'type': 'text', 'text': PROMPTS[args.model]}]}]
                if args.model in ('nanonets', 'navidc'):
                    messages.insert(0, {'role': 'system', 'content': 'You are a helpful assistant.'})
                text = processor.apply_chat_template(messages, tokenize=False, add_generation_prompt=True)
                inputs = processor(text=[text], images=[image], return_tensors='pt', padding=True)
            inputs = inputs.to(model.device)
            options = {'max_new_tokens': 9000 if args.model == 'nemotron' else 15000, 'do_sample': False}
            if args.model == 'hunyuan':
                options['repetition_penalty'] = 1.08
            with torch.inference_mode():
                tokens = model.generate(**inputs, **options)
            generated = tokens if args.model == 'nemotron' else tokens[:, inputs['input_ids'].shape[1]:]
            text = processor.batch_decode(generated, skip_special_tokens=True, clean_up_tokenization_spaces=False)[0]
            torch.cuda.synchronize()
            result = {'id': item['id'], 'text': text, 'seconds': time.perf_counter() - started,
                      'outputTokens': generated.shape[1], 'tokenLimit': options['max_new_tokens'],
                      'hitTokenLimit': generated.shape[1] >= options['max_new_tokens'],
                      'peakAllocatedBytes': torch.cuda.max_memory_allocated()}
            (out / (item['id'] + '.json')).write_text(json.dumps(result, ensure_ascii=False, indent=2), encoding='utf-8')
            print(args.model, item['id'], round(result['seconds'], 2), result['outputTokens'], flush=True)
        manifest['status'] = 'completed'
    except Exception:
        manifest['status'] = 'failed'
        manifest['failure'] = traceback.format_exc()
        raise
    finally:
        (out / 'manifest.json').write_text(json.dumps(manifest, indent=2, ensure_ascii=False), encoding='utf-8')

if __name__ == '__main__':
    main()
