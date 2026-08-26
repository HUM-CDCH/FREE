"""Entry point for ``fastapi run main.py`` and ``uvicorn main:app``."""

from app.main import app

__all__ = ["app"]
