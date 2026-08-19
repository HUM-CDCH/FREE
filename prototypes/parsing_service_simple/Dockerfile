# Docling pulls its layout/table models at first conversion, so the image stays
# slim and the models live in the mounted HOME cache instead of an image layer.
FROM ghcr.io/astral-sh/uv:python3.13-bookworm-slim

# System libs Docling's torch/opencv stack loads at runtime.
RUN apt-get update && apt-get install -y --no-install-recommends \
        libgl1 libglib2.0-0 libgomp1 \
    && rm -rf /var/lib/apt/lists/*

ENV UV_COMPILE_BYTECODE=1 \
    UV_LINK_MODE=copy \
    UV_PROJECT_ENVIRONMENT=/app/.venv \
    HOME=/models

WORKDIR /app

# Dependencies first so the layer survives every source edit.
COPY pyproject.toml uv.lock ./
RUN --mount=type=cache,target=/root/.cache/uv \
    uv sync --frozen --no-dev --no-install-project

COPY . .
# Install the project itself so importlib.metadata reports the service version.
RUN --mount=type=cache,target=/root/.cache/uv \
    uv sync --frozen --no-dev

EXPOSE 8000
# One process only: the FIFO queue and the reusable DocumentConverter are
# in-process state, so a second worker would split the queue.
CMD ["uv", "run", "--no-sync", "python", "-X", "utf8", "-m", "fastapi", "run", "main.py", "--host", "0.0.0.0", "--port", "8000"]
