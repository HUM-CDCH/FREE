"""GPU availability detection shared by startup, /status, and task creation."""

from __future__ import annotations

import importlib
import io
import logging
import shutil
from contextlib import redirect_stderr, redirect_stdout
from multiprocessing import get_context
from multiprocessing.connection import Connection

logger = logging.getLogger(__name__)

_gpu_available = False
_GPU_PROBE_TIMEOUT_SECONDS = 120


def _probe_paddle_cuda(result_pipe: Connection) -> None:
    output = io.StringIO()
    try:
        with redirect_stdout(output), redirect_stderr(io.StringIO()):
            paddle = importlib.import_module("paddle")
            output.write(
                str(
                    paddle.device.is_compiled_with_cuda()
                    and paddle.device.cuda.device_count() > 0
                )
            )
        available = output.getvalue().strip() == "True"
    except Exception:
        available = False
    with result_pipe:
        result_pipe.send(available)


def _paddle_cuda_available() -> bool:
    context = get_context("spawn")
    result_pipe, child_pipe = context.Pipe(duplex=False)
    with result_pipe, child_pipe:
        process = context.Process(target=_probe_paddle_cuda, args=(child_pipe,))
        process.start()
        child_pipe.close()
        process.join(_GPU_PROBE_TIMEOUT_SECONDS)
        if process.is_alive():
            process.kill()
            process.join()
            process.close()
            raise TimeoutError("Paddle CUDA probe timed out")

        succeeded = process.exitcode == 0
        process.close()
        if not succeeded or not result_pipe.poll():
            return False
        return bool(result_pipe.recv())


def check_gpu_available() -> bool:
    try:
        if not shutil.which("nvidia-smi"):
            return False
        return _paddle_cuda_available()
    except Exception:
        logger.exception("Error checking GPU availability")
        return False


def set_gpu_available(value: bool) -> None:
    global _gpu_available
    _gpu_available = value


def gpu_available() -> bool:
    return _gpu_available
