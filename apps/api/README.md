# Formada API

FastAPI service. It owns the database, migrations, RLS and all business rules. See the root `CLAUDE.md` for layering rules.

```
uv sync
uv run uvicorn app.main:app --reload
uv run pytest
```
