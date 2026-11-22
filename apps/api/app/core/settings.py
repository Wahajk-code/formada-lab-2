"""Process settings from the environment. Business tunables live in domain/config.py, not here."""

from functools import lru_cache
from typing import Literal

from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file=".env", extra="ignore")

    env: Literal["local", "staging", "production"] = "local"
    # The hosted review lab: replay saved snapshots, no live warehouse, any step can be worked on.
    lab_mode: bool = False
    log_level: str = "INFO"
    log_json: bool = False

    # /api/* connects as app_user (RLS: tenant + visible roles).
    database_url: str = "postgresql+asyncpg://app_user:app_user@localhost:55432/formada"
    # The scheduler and its steps connect as app_service (RLS: tenant only).
    database_service_url: str = (
        "postgresql+asyncpg://app_service:app_service@localhost:55432/formada"
    )
    # Schema owner: Alembic and seeding only.
    database_owner_url: str = "postgresql+asyncpg://app_owner:app_owner@localhost:55432/formada"

    # Local only: point the Snowflake connector at the fakesnow emulator.
    warehouse_host: str | None = None
    warehouse_port: int = 443

    # Provider for tenants that have not picked one in Settings (ADR 0018).
    llm_backend: Literal["fake", "openai", "anthropic", "gemini"] = "fake"
    # Local only: make FakeLLM take as long as a real model call (tests retries/timeouts).
    fake_llm_latency_ms: int = 0
    openai_api_key: str | None = None
    openai_model: str = "gpt-6.1-sol"
    anthropic_api_key: str | None = None
    anthropic_model: str = "claude-haiku-5-5"
    gemini_api_key: str | None = None
    gemini_model: str = "gemini-4-argon"
    # Debugging: write every card in this language instead of the role's (unset = role language).
    card_language: Literal["en", "fr"] | None = None

    secrets_backend: Literal["env", "file"] = "env"
    secrets_file_path: str = "/run/secrets/formada.json"

    auth_jwt_secret: str = ""
    auth_token_ttl_minutes: int = 12 * 60
    # Password for the seeded demo people and staff (local only; set in .env, never committed).
    seed_user_password: str | None = None

    # The in-app scheduler (ADR 0034). Off in the review lab (no live runs). Run one API instance
    # with it on; a second would only repeat work the idempotency store already refuses.
    scheduler_enabled: bool = True
    scheduler_tick_seconds: int = 30
    # Digest email (WF4). Locally Mailpit; unset host = log instead of sending.
    smtp_host: str | None = None
    smtp_port: int = 1025
    mail_from: str = "Formada <no-reply@formada.local>"
    app_base_url: str = "http://localhost:3100"

    # Local only: a one-click "mock warehouse" connection in the console's Connect step. The
    # database name lives in .env (it can name a client), never in the code.
    mock_warehouse_database: str | None = None
    mock_warehouse_schemas: str = ""

    # Org chart import (ADR 0027). mock = a sample directory, no Microsoft calls. graph = Microsoft
    # Graph with our multi-tenant app registration; its client secret lives in the vault.
    directory_backend: Literal["mock", "graph"] = "mock"
    ms_graph_client_id: str | None = None
    ms_graph_secret_ref: str = "platform/ms_graph_client_secret"
    # Reading a photo of a hand-drawn chart. Only the mock exists for now (no image leaves us).
    org_vision_backend: Literal["mock"] = "mock"

    catalog_dir: str = "../../catalog"
    cors_origins: list[str] = ["http://localhost:3100"]


@lru_cache
def get_settings() -> Settings:
    return Settings()
