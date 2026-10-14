"""Parse one synthetic PDF with production parsing (native text, no column cutting), as the benchmark's run.py does.
    python parse_pdf.py SOURCE.pdf OUT_DIR
"""
import json
import sys
import time
from pathlib import Path

from kei_exp.kie.passages import load
from kei_exp.kie.runner import convert
from kei_exp.kie.stages.ocr import resolve
from kei_exp.transcription.types import RunParams

pdf, run = Path(sys.argv[1]), Path(sys.argv[2])
run.mkdir(parents=True)
params = RunParams(pdf=pdf, result_dir=run / "result", debug_dir=run / "debug", cut="none", model="granite_vision",
                   url="http://127.0.0.1:8000")
execution = resolve(params)
clock = time.monotonic()
with (run / "events.jsonl").open("x") as events:
    convert(execution, lambda event: (events.write(json.dumps(event) + "\n"), events.flush()))
evidence = load(run)
(run / "parsing.json").write_text(json.dumps({"transcriber": execution.transcriber, "pages": evidence.page_count,
                                              "passages": len(evidence.passages), "generation": evidence.generation,
                                              "digest": evidence.digest, "seconds": time.monotonic() - clock}))
print(pdf.name, execution.transcriber, evidence.page_count, "pages", len(evidence.passages), "passages")
