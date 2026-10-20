# A standalone Rust executable; the Python runtime needs no Node installation.
FROM node:24-bookworm-slim AS codex
RUN npm install --prefix /opt/codex --ignore-scripts @openai/codex@0.163.0
RUN node --input-type=module -e '\
    import { createRequire } from "node:module"; \
    import { dirname, join } from "node:path"; \
    import { copyFileSync, chmodSync } from "node:fs"; \
    const require = createRequire("/opt/codex/package.json"); \
    const launcher = require.resolve("@openai/codex/bin/codex.js"); \
    const native = createRequire(launcher).resolve(`@openai/codex-linux-${process.arch}/package.json`); \
    const arch = process.arch === "arm64" ? "aarch64" : "x86_64"; \
    copyFileSync(join(dirname(native), "vendor", `${arch}-unknown-linux-musl`, "bin/codex"), "/codex"); \
    chmodSync("/codex", 0o755)'

FROM ghcr.io/astral-sh/uv:python3.13-bookworm-slim

WORKDIR /app

RUN apt-get update && apt-get install -y --no-install-recommends \
        libgl1 libglib2.0-0 libgomp1 \
    && rm -rf /var/lib/apt/lists/*

ENV UV_COMPILE_BYTECODE=1 \
    UV_LINK_MODE=copy \
    UV_PROJECT_ENVIRONMENT=/app/.venv

COPY pyproject.toml uv.lock ./
RUN --mount=type=cache,target=/root/.cache/uv \
    uv sync --frozen --no-dev --no-install-project

COPY src/ ./src/
COPY README.md ./
RUN --mount=type=cache,target=/root/.cache/uv \
    uv sync --frozen --no-dev

COPY --from=codex /codex /usr/local/bin/codex

ENV PATH="/app/.venv/bin:$PATH" \
    KEI_RUNS="/app/runs" \
    HOME="/models"

EXPOSE 8001
CMD ["uvicorn", "kei_exp.api:app", "--host", "0.0.0.0", "--port", "8001"]
