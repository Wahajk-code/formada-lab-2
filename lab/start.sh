#!/bin/sh
# Render start command: migrate, load the catalog, then serve. Safe to run on every deploy.
set -e
alembic upgrade head
python -m lab.prepare
exec uvicorn app.main:app --host 0.0.0.0 --port "${PORT:-10000}" --workers 1
