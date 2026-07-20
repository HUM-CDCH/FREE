"""Entry point shim so `fastapi dev main.py` / `uvicorn main:app` keep working.

All application code lives in the `app` package.
"""

from app.main import app

__all__ = ["app"]
