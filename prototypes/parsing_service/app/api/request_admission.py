"""Pre-parser admission policy for the task-creation request envelope."""

from __future__ import annotations

from starlette.responses import JSONResponse
from starlette.types import ASGIApp, Receive, Scope, Send

TASK_REQUEST_LIMIT_BYTES = 51 * 1024 * 1024
_REQUEST_TOO_LARGE_DETAIL = "Request body exceeds the 51 MiB limit."


class TaskRequestLimitMiddleware:
    """Apply the task request-envelope limit before multipart parsing."""

    def __init__(
        self,
        app: ASGIApp,
        max_bytes: int = TASK_REQUEST_LIMIT_BYTES,
    ) -> None:
        self.app = app
        self.max_bytes = max_bytes

    async def __call__(
        self,
        scope: Scope,
        receive: Receive,
        send: Send,
    ) -> None:
        limited_route = (
            scope["type"] == "http"
            and scope["method"] == "POST"
            and scope["path"] == "/tasks"
        )
        content_length = None
        if limited_route:
            values = [
                value for name, value in scope["headers"] if name == b"content-length"
            ]
            if len(values) == 1:
                try:
                    content_length = int(values[0].decode("ascii"))
                except ValueError:
                    content_length = None
        if content_length is not None and content_length > self.max_bytes:
            response = JSONResponse(
                {"detail": _REQUEST_TOO_LARGE_DETAIL},
                status_code=413,
            )
            await response(scope, receive, send)
            return
        await self.app(scope, receive, send)
