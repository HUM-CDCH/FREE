# CUDA 13 runtime comes from pip (nvidia-* wheels in uv.lock); the host driver
# provides libcuda.so.1 via nvidia-container-toolkit. So a slim uv base is enough —
# no heavy nvidia/cuda base image needed.
FROM ghcr.io/astral-sh/uv:python3.13-bookworm-slim

# System libs paddleocr/opencv/docling load at runtime
RUN apt-get update && apt-get install -y --no-install-recommends \
        libgl1 libglib2.0-0 libgomp1 \
    && rm -rf /var/lib/apt/lists/*

ENV UV_COMPILE_BYTECODE=1 \
    UV_LINK_MODE=copy \
    UV_PROJECT_ENVIRONMENT=/app/.venv \
    HOME=/models \
    NVIDIA_VISIBLE_DEVICES=all \
    NVIDIA_DRIVER_CAPABILITIES=all

WORKDIR /app

# OCR profile: ocr-gpu (default, matches compose GPU reservation) or ocr-cpu.
ARG OCR_EXTRA=ocr-gpu

# Deps first so they cache unless the lock changes
COPY pyproject.toml uv.lock ./
RUN --mount=type=cache,target=/root/.cache/uv \
    uv sync --frozen --no-dev --no-install-project --extra "${OCR_EXTRA}"

COPY . .
# Install the project itself so importlib.metadata reports service version provenance
RUN --mount=type=cache,target=/root/.cache/uv \
    uv sync --frozen --no-dev --extra "${OCR_EXTRA}"

EXPOSE 8055
# Model caches (docling/HF + paddlex) land under HOME=/models — mount it as a volume to persist.
CMD ["uv", "run", "--no-sync", "fastapi", "run", "main.py", "--host", "0.0.0.0", "--port", "8055"]
