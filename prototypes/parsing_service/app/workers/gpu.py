"""GPU availability detection shared by startup, /status, and task creation."""

from __future__ import annotations

import shutil
import subprocess
import sys

_gpu_available = False


def check_gpu_available() -> bool:
    try:
        res = shutil.which("nvidia-smi")
        if not res:
            return False

        check_cmd = [
            sys.executable,
            "-c",
            "import paddle; print(paddle.device.is_compiled_with_cuda() and paddle.device.cuda.device_count() > 0)",
        ]
        result = subprocess.run(check_cmd, capture_output=True, text=True, timeout=120)
        return result.stdout.strip() == "True"
    except Exception as e:
        print(f"Error checking GPU availability: {e}")
        return False


def set_gpu_available(value: bool) -> None:
    global _gpu_available
    _gpu_available = value


def gpu_available() -> bool:
    return _gpu_available
