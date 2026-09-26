"""Real kei worker for service tests, with one native conversion held at a file barrier.

Only runner.convert is wrapped; DBOS, parsing, checkpoints and publication stay real.
The first conversion enters the native runner, writes `entered`, and resumes when
the test writes `release`. A replacement worker sees `entered` and runs normally.
"""

import os
import time
from pathlib import Path

from kei_exp.kie import runner

barrier = Path(os.environ["FREE_REAL_SERVICE_CONVERSION_HOLD"])
convert = runner.convert


def held_convert(*args, **kwargs):
    entered = barrier / "entered"
    if not entered.exists():
        entered.write_text(str(os.getpid()))
        while not (barrier / "release").exists():
            time.sleep(0.05)
    return convert(*args, **kwargs)


runner.convert = held_convert

from kei_exp.workflows.cli import main  # noqa: E402 - patch the runner before workflow registration

main()
