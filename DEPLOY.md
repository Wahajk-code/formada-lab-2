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
2. Add `API_INTERNAL_URL` = your Render URL.
3. Deploy, then put the Vercel URL into Render as `APP_BASE_URL` and `CORS_ORIGINS`.

## 5. Load the data and the reviewers (run on your own machine)
Never put these in git. With the Neon **owner** URL:

```
# the saved workspace (from the main project's database)
SRC_URL=<main project owner url> DST_URL=<neon owner url> TENANT_ID=<uuid> \
LAB_NAME="Customer (lab snapshot)" python lab/load_snapshot.py

# the reviewers' logins
DATABASE_OWNER_URL=<neon owner url> \
LAB_STAFF="ada@example.com:Ada:admin:long-password,bo@example.com:Bo:developer:another-password" \
python lab/create_staff.py
```

## 6. Use it
Open the Vercel URL, sign in on the internal side, open the workspace, and go through Discovery,
Mapping, Org and Metrics. In the lab any step can be opened in any order.

## Limits to know
- Free API sleeps when idle; keep the console open while an AI step runs (it polls).
- Neon free storage is small (about 0.5 GB); the lab uses a few megabytes.
- Changed SQL cannot be tested live here; the lab says "not run" and runs only the static checks.
- No Canadian region on the free tiers: the snapshot holds names and counts, never rows.
