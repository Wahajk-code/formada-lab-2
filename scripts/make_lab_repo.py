"""Create or refresh formada-lab/, the hosted review lab (a separate git repo inside this project).

  python scripts/make_lab_repo.py

Copies only what the lab needs (API, web app, catalog, lab scripts), writes the deploy files for
Render, Vercel and Neon, and never touches formada-lab/.git. No customer data, no secrets, no
tests that need a database. Run it again after changing the main code to refresh the copy.
"""

import shutil
import subprocess
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
LAB = ROOT / "formada-lab"

IGNORE = shutil.ignore_patterns(
    "__pycache__", ".venv", ".pytest_cache", ".mypy_cache", ".ruff_cache", "node_modules", ".next",
    "*.pyc", "tsconfig.tsbuildinfo", "mocks.local", ".env", ".env.*", "tests", "private", "seed",
)

FILES: dict[str, str] = {}

FILES["Dockerfile"] = """\
# Production image for the lab API (Render). Build context: the repo root.
FROM python:3.12-slim-bookworm
COPY --from=ghcr.io/astral-sh/uv:0.13.0 /uv /usr/local/bin/uv
ENV UV_PROJECT_ENVIRONMENT=/opt/venv UV_LINK_MODE=copy UV_COMPILE_BYTECODE=1 \\
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
"""

FILES["lab/start.sh"] = """\
#!/bin/sh
# Render start command: migrate, load the catalog, then serve. Safe to run on every deploy.
set -e
alembic upgrade head
python -m lab.prepare
exec uvicorn app.main:app --host 0.0.0.0 --port "${PORT:-10000}" --workers 1
"""

FILES["lab/__init__.py"] = ""

FILES["lab/prepare.py"] = '''\
"""Load the catalog (agents, prompts, templates) into the database on every start."""
import asyncio
from pathlib import Path

from app.core.db import global_tx
from app.core.settings import get_settings
from app.services.catalog_loader import load_catalog


async def main() -> None:
    async with global_tx("owner") as s:
        await load_catalog(s, Path(get_settings().catalog_dir))


asyncio.run(main())
'''

FILES["render.yaml"] = """\
# Render blueprint: one free web service for the API. The database is Neon (see DEPLOY.md).
services:
  - type: web
    name: formada-lab-api
    runtime: docker
    plan: free
    dockerfilePath: ./Dockerfile
    dockerContext: .
    healthCheckPath: /health
    autoDeploy: true
    envVars:
      - key: ENV
        value: staging
      - key: LAB_MODE
        value: "true"
      - key: LLM_BACKEND
        value: anthropic
      - key: ANTHROPIC_MODEL
        value: claude-sonnet-5-5
      - key: SECRETS_BACKEND
        value: env
      - key: LOG_JSON
        value: "true"
      - key: DIRECTORY_BACKEND
        value: mock
      - key: ANTHROPIC_API_KEY
        sync: false
      - key: DATABASE_URL
        sync: false
      - key: DATABASE_SERVICE_URL
        sync: false
      - key: DATABASE_OWNER_URL
        sync: false
      - key: AUTH_JWT_SECRET
        generateValue: true
      - key: APP_BASE_URL
        sync: false
      - key: CORS_ORIGINS
        sync: false
"""

FILES["apps/web/vercel.json"] = """\
{
  "framework": "nextjs",
  "installCommand": "npm ci --no-audit --no-fund",
  "buildCommand": "npm run build"
}
"""

FILES[".gitattributes"] = "* text=auto eol=lf\n*.sh text eol=lf\nDockerfile text eol=lf\n"

FILES[".env.example"] = """\
# API (set these in Render; never commit real values).
ENV=staging
LAB_MODE=true
LLM_BACKEND=anthropic
ANTHROPIC_MODEL=claude-sonnet-5-5
ANTHROPIC_API_KEY=sk-ant-...                       # set a monthly spend limit in the Anthropic console
# Neon: use the DIRECT host (no "-pooler"), with ssl=require, one URL per role.
DATABASE_OWNER_URL=postgresql+asyncpg://app_owner:PASSWORD@ep-xxxx.REGION.aws.neon.tech/neondb?ssl=require
DATABASE_URL=postgresql+asyncpg://app_user:PASSWORD@ep-xxxx.REGION.aws.neon.tech/neondb?ssl=require
DATABASE_SERVICE_URL=postgresql+asyncpg://app_service:PASSWORD@ep-xxxx.REGION.aws.neon.tech/neondb?ssl=require
AUTH_JWT_SECRET=generate-a-long-random-value
APP_BASE_URL=https://YOUR-APP.vercel.app
CORS_ORIGINS=["https://YOUR-APP.vercel.app"]

# Web app (set in Vercel):
# API_INTERNAL_URL=https://formada-lab-api.onrender.com
# LAB_MODE=true
"""

FILES[".gitignore"] = """\
.env
.env.*
!.env.example
__pycache__/
.venv/
node_modules/
.next/
*.pyc
secrets/
snapshots/
"""

FILES["README.md"] = """\
# Formada lab

A small hosted copy of Formada's onboarding flow, for data engineers to review and improve
**discovery, mapping and metrics** with the AI: read each proposal, chat with Claude about it, edit
it, lock the parts that are right, and re-run the rest.

- It replays a saved snapshot of a customer's warehouse (names, types, counts; never rows), so no
  live Snowflake is needed. Claude runs live.
- There is no scheduler, no weekly run and no cards here. This is only the onboarding flow.
- Stack: Neon (Postgres), Render (API), Vercel (web app), the Anthropic API.

See [DEPLOY.md](DEPLOY.md) to set it up. The code is generated from the main Formada repo by
`scripts/make_lab_repo.py`; change the main repo and regenerate, do not edit here.
"""

FILES["DEPLOY.md"] = """\
# Deploy the lab (about 45 minutes)

You need accounts on GitHub, Neon, Render, Vercel and Anthropic. Everything below has a free tier
except the Anthropic API (pay per use).

## 0. Push the code
Create an empty **private** GitHub repo, then from this folder:
`git remote add origin <url>` and `git push -u origin main`.

## 1. Neon (database)
1. Create a project (note the region). Use the default database (`neondb`).
2. In the SQL editor run `lab/neon_bootstrap.sql` after replacing the three passwords.
3. Copy the **direct** connection host (the one without `-pooler`). The pooled host breaks our
   database driver.
4. Build three URLs (one per role) like
   `postgresql+asyncpg://app_user:PASSWORD@ep-xxxx.REGION.aws.neon.tech/neondb?ssl=require`.

## 2. Anthropic
Create an API key and **set a monthly spend limit** (for example $30) in the console.

## 3. Render (API)
1. New > Blueprint > pick the repo (it reads `render.yaml`).
2. Fill the variables Render asks for: `ANTHROPIC_API_KEY`, the three `DATABASE_*_URL`,
   `APP_BASE_URL` (your Vercel URL, set after step 4) and `CORS_ORIGINS`.
3. Deploy. The first start runs the migrations and loads the catalog. Check `/health`.
4. Free services sleep after about 15 minutes idle; the first request then takes 30 to 60 seconds.

## 4. Vercel (web app)
1. Import the repo, set the **root directory to `apps/web`**.
2. Add `API_INTERNAL_URL` = your Render URL and `LAB_MODE` = `true` (shows the lab notice).
3. Deploy, then put the Vercel URL into Render as `APP_BASE_URL` and `CORS_ORIGINS`.

## 5. Load the data and the reviewers (run on your own machine)
Never put these in git. With the Neon **owner** URL:

```
# the saved workspace (from the main project's database)
SRC_URL=<main project owner url> DST_URL=<neon owner url> TENANT_ID=<uuid> \\
LAB_NAME="Customer (lab snapshot)" python lab/load_snapshot.py

# the reviewers' logins
DATABASE_OWNER_URL=<neon owner url> \\
LAB_STAFF="ada@example.com:Ada:admin:long-password,bo@example.com:Bo:admin:another-password" \\
python lab/create_staff.py
```

Give every reviewer the **admin** role: the developer role can read but cannot start or approve a step.

## 6. Use it
Open the Vercel URL, sign in on the internal side, open the workspace, and go through Discovery,
Mapping, Org and Metrics. In the lab any step can be opened in any order.

## Limits to know
- Free API sleeps when idle; keep the console open while an AI step runs (it polls).
- Neon free storage is small (about 0.5 GB); the lab uses a few megabytes.
- Changed SQL cannot be tested live here; the lab says "not run" and runs only the static checks.
- No Canadian region on the free tiers: the snapshot holds names and counts, never rows.
"""


def copy_tree(src: Path, dst: Path) -> None:
    """Replace the copy, so a file deleted in the main repo is deleted here too."""
    if dst.exists():
        shutil.rmtree(dst)
    shutil.copytree(src, dst, ignore=IGNORE)


def main() -> None:
    LAB.mkdir(exist_ok=True)
    copy_tree(ROOT / "apps" / "api", LAB / "apps" / "api")
    copy_tree(ROOT / "apps" / "web", LAB / "apps" / "web")
    copy_tree(ROOT / "catalog", LAB / "catalog")
    for f in ("neon_bootstrap.sql", "create_staff.py", "load_snapshot.py"):
        (LAB / "lab").mkdir(exist_ok=True)
        shutil.copy2(ROOT / "lab" / f, LAB / "lab" / f)
    (LAB / "scripts").mkdir(exist_ok=True)
    shutil.copy2(Path(__file__), LAB / "scripts" / "make_lab_repo.py")
    for rel, text in FILES.items():
        path = LAB / rel
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(text, encoding="utf-8", newline="\n")
    # Long AI calls and a sleeping API: let the web app wait up to a minute on the Hobby plan.
    layout = LAB / "apps" / "web" / "src" / "app" / "layout.tsx"
    if layout.exists() and "maxDuration" not in layout.read_text(encoding="utf-8"):
        with layout.open("a", encoding="utf-8", newline="\n") as f:
            f.write("\nexport const maxDuration = 60;\n")
    if not (LAB / ".git").exists():
        subprocess.run(["git", "init", "-b", "main"], cwd=LAB, check=True)
    print("lab repo ready:", LAB)


if __name__ == "__main__":
    main()
