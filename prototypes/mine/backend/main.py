from contextlib import asynccontextmanager

import httpx
from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from model_providers import create_model_provider

from config import Settings, settings
from shared import bind_provider
from shared.json_repair import parse_json_object_result
from shared.pdf import pages_to_jpeg
from shared.streaming import JsonLineEvent
from use_cases import chat, extract, generate_template, health, markdown
from use_cases.chat import chat_events

# Public re-exports kept stable for the runtime entry point and the test suite.
__all__ = [
    "Settings",
    "settings",
    "app",
    "JsonLineEvent",
    "pages_to_jpeg",
    "parse_json_object_result",
    "chat_events",
]


@asynccontextmanager
async def lifespan(app: FastAPI):
    app.state.client = httpx.AsyncClient(timeout=settings.timeout_seconds)
    app.state.provider = create_model_provider(settings, app.state.client)
    bind_provider(app.state.provider)
    try:
        yield
    finally:
        await app.state.client.aclose()


app = FastAPI(title="NuExtract3 extraction server", lifespan=lifespan)
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)

app.include_router(health.router)
app.include_router(chat.router)
app.include_router(extract.router)
app.include_router(markdown.router)
app.include_router(generate_template.router)
