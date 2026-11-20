from collections.abc import AsyncIterator
from contextlib import asynccontextmanager

from fastapi import FastAPI, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse

from app.core.errors import Conflict, Forbidden, Invalid, NotFound
from app.core.logging import configure_logging, get_logger
from app.core.settings import get_settings
from app.routers import api as api_router
from app.routers import internal as internal_router

settings = get_settings()
configure_logging(settings.log_level, settings.log_json)
log = get_logger(__name__)


@asynccontextmanager
async def lifespan(_app: FastAPI) -> AsyncIterator[None]:
    log.info(
        "api.startup",
        env=settings.env,
        llm=settings.llm_backend,
    )
    yield
    log.info("api.shutdown")


app = FastAPI(title="Formada API", version="0.1.0", lifespan=lifespan)
app.add_middleware(
    CORSMiddleware,
    allow_origins=settings.cors_origins,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)
app.include_router(api_router.router)
app.include_router(internal_router.router)


@app.exception_handler(NotFound)
async def _not_found(_request: Request, exc: NotFound) -> JSONResponse:
    return JSONResponse({"detail": f"{exc} not found"}, status_code=404)


@app.exception_handler(Forbidden)
async def _forbidden(_request: Request, exc: Forbidden) -> JSONResponse:
    return JSONResponse({"detail": str(exc)}, status_code=403)


@app.exception_handler(Conflict)
async def _conflict(_request: Request, exc: Conflict) -> JSONResponse:
    return JSONResponse({"detail": str(exc)}, status_code=409)


@app.exception_handler(Invalid)
async def _invalid(_request: Request, exc: Invalid) -> JSONResponse:
    return JSONResponse({"detail": str(exc)}, status_code=422)


@app.exception_handler(Exception)
async def _unexpected(request: Request, exc: Exception) -> JSONResponse:
    """/internal/*: 503 + failed envelope so n8n retries. /api/*: opaque 500."""
    log.exception("unhandled", path=request.url.path)
    if request.url.path.startswith("/internal/"):
        body = {"status": "failed", "error": f"{type(exc).__name__}: {str(exc)[:500]}"}
        return JSONResponse(body, status_code=503)
    return JSONResponse({"detail": "internal error"}, status_code=500)


@app.get("/health", tags=["ops"])
async def health() -> dict[str, str]:
    return {"status": "ok"}
