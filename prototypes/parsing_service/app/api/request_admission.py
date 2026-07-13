"""Pre-parser admission policy for the task-creation request envelope."""

from __future__ import annotations

from starlette.responses import JSONResponse
from starlette.types import ASGIApp, Message, Receive, Scope, Send

TASK_REQUEST_LIMIT_BYTES = 51 * 1024 * 1024
_REQUEST_TOO_LARGE_DETAIL = "Request body exceeds the 51 MiB limit."


class _RequestTooLarge(RuntimeError):
    pass


def _request_too_large_response() -> JSONResponse:
    return JSONResponse(
        {"detail": _REQUEST_TOO_LARGE_DETAIL},
        status_code=413,
    )


def _declared_content_length(scope: Scope) -> int | None:
    values = [value for name, value in scope["headers"] if name == b"content-length"]
    if len(values) != 1:
        return None
    try:
        content_length = int(values[0].decode("ascii"))
    except (UnicodeDecodeError, ValueError):
        return None
    return content_length if content_length >= 0 else None


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
        if not limited_route:
            await self.app(scope, receive, send)
            return

        content_length = _declared_content_length(scope)
        if content_length is not None and content_length > self.max_bytes:
            await _request_too_large_response()(scope, receive, send)
            return

        received_bytes = 0
        overflowed = False
        response_started = False

        async def limited_receive() -> Message:
            nonlocal overflowed, received_bytes
            if overflowed:
                raise _RequestTooLarge(_REQUEST_TOO_LARGE_DETAIL)
            message = await receive()
            if message["type"] == "http.request":
                received_bytes += len(message.get("body", b""))
                if received_bytes > self.max_bytes:
                    overflowed = True
                    raise _RequestTooLarge(_REQUEST_TOO_LARGE_DETAIL)
            return message

        # FastAPI resolves the task form body before the route can start a response.
        async def guarded_send(message: Message) -> None:
            nonlocal response_started
            if overflowed:
                return
            if message["type"] == "http.response.start":
                response_started = True
            await send(message)

        try:
            await self.app(scope, limited_receive, guarded_send)
        except _RequestTooLarge:
            if response_started:
                raise

        if overflowed:
            if response_started:
                raise _RequestTooLarge(_REQUEST_TOO_LARGE_DETAIL)
            await _request_too_large_response()(scope, receive, send)
