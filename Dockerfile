# Production image for the lab API (Render). Build context: the repo root.
FROM python:3.12-slim-bookworm
COPY --from=ghcr.io/astral-sh/uv:0.13.0 /uv /usr/local/bin/uv
ENV UV_PROJECT_ENVIRONMENT=/opt/venv UV_LINK_MODE=copy UV_COMPILE_BYTECODE=1 \
    PYTHONUNBUFFERED=1 PATH="/opt/venv/bin:$PATH" PYTHONPATH=/app
WORKDIR /app
COPY apps/api/pyproject.toml apps/api/uv.lock ./
RUN uv sync --frozen --no-dev --no-install-project
COPY apps/api/ ./
COPY catalog /catalog
COPY lab ./lab
ENV CATALOG_DIR=/catalog
EXPOSE 10000
CMD ["sh", "lab/start.sh"]
