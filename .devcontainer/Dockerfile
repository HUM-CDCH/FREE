FROM mcr.microsoft.com/devcontainers/base:bookworm

COPY --from=ghcr.io/astral-sh/uv:0.12.5 /uv /uvx /usr/local/bin/

RUN apt-get update \
    && apt-get install -y --no-install-recommends \
        build-essential \
        dbus-daemon \
        ghostscript \
        gnome-keyring \
        libgl1 \
        libglib2.0-0 \
    && rm -rf /var/lib/apt/lists/*

COPY start-keyring /usr/local/bin/start-keyring

RUN chmod +x /usr/local/bin/start-keyring
