"""Real kei worker for service tests, holding the first native result before export.

DBOS, Docling parsing, checkpoints and publication stay real. The event emitted
after Docling finishes its native PDF conversion marks that the runner is inside
the native step, before its artifact is exported and published. A replacement
worker sees `entered` and runs normally.
"""

import os
import time
from pathlib import Path

from kei_exp.kie import runner

barrier = Path(os.environ["FREE_REAL_SERVICE_CONVERSION_HOLD"])
convert = runner.convert


def held_convert(execution, emit):
    entered = barrier / "entered"

    def at_native_export(event):
        emit(event)
        if event.get("type") == "phase" and event.get("name") == "export" and not entered.exists():
            entered.write_text(str(os.getpid()))
            while not (barrier / "release").exists():
                time.sleep(0.05)

    return convert(execution, at_native_export)


runner.convert = held_convert

from kei_exp.workflows.cli import main  # noqa: E402 - patch the runner before workflow registration

main()
