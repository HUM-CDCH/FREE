"""Separate desktop protocol: 2000-pixel longest edge, bounded generation, live trace."""
import hashlib
import json
import sys
import time
from pathlib import Path
from PIL import Image
from transformers import AutoProcessor, TextStreamer
from transformers.generation import GenerationMixin
import ocr

original_open = Image.open
original_processor = AutoProcessor.from_pretrained
original_generate = GenerationMixin.generate
processor = None
generation_times = []

def resized(*args, **kwargs):
    image = original_open(*args, **kwargs)
    image.thumbnail((2000, 2000), Image.Resampling.LANCZOS)
    return image

def load_processor(*args, **kwargs):
    global processor
    processor = original_processor(*args, **kwargs)
    return processor

def generate(self, *args, **kwargs):
    kwargs['max_time'] = 600
    kwargs['streamer'] = TextStreamer(processor.tokenizer, skip_prompt=True, skip_special_tokens=False)
    started = time.perf_counter()
    result = original_generate(self, *args, **kwargs)
    generation_times.append(time.perf_counter() - started)
    return result

Image.open = resized
AutoProcessor.from_pretrained = load_processor
GenerationMixin.generate = generate
try:
    ocr.main()
finally:
    run = sys.argv[sys.argv.index('--run')+1] if '--run' in sys.argv else 'r1'
    out = ocr.ROOT / f'{sys.argv[1]}-{run}'
    (out / 'desktop-protocol.json').write_text(json.dumps({
        'wrapperSha256': hashlib.sha256(Path(__file__).read_bytes()).hexdigest(),
        'longestEdgePixels': 2000, 'maxGenerationSeconds': 600,
        'generationSeconds': generation_times,
        'timeLimitedImageIndexes': [i for i, seconds in enumerate(generation_times) if seconds >= 600],
        'note': 'Resizing occurs before the native processor. Source image hashes refer to original 200-DPI renders.',
    }, indent=2))
