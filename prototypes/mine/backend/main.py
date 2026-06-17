from contextlib import asynccontextmanager

import httpx
from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from application import build_application_services

from config import settings
from use_cases import chat, extract, generate_template, health, markdown


@asynccontextmanager
async def lifespan(app: FastAPI):
    app.state.client = httpx.AsyncClient(timeout=settings.timeout_seconds)
    app.state.services = build_application_services(settings, app.state.client)
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
