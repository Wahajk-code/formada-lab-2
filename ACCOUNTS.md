# Account checklist (do in this order)

Never paste keys or passwords into chat, email or git. Keep them in a password manager.

1. **GitHub**: create a private, empty repo `formada-lab`. Copy its URL.
2. **Anthropic**: console -> create API key `formada-lab` -> set a monthly spend limit (for example $30).
3. **Neon**: new project `formada-lab` (default database `neondb`). SQL editor: run `lab/neon_bootstrap.sql`
   after replacing the three CHANGE_ME passwords. Connect -> turn OFF "Pooled connection" and copy the
   host (no `-pooler`). Write the three role URLs as in `.env.example`.
4. **Render**: New -> Blueprint -> pick the repo. Fill the Anthropic key and the three DATABASE_*_URL.
   Deploy, open `<render-url>/health`. Note the URL.
5. **Vercel**: import the repo, Root Directory `apps/web`, env `API_INTERNAL_URL` = the Render URL. Deploy.
   Then in Render set `APP_BASE_URL` = the Vercel URL and `CORS_ORIGINS` = `["<vercel url>"]`, redeploy.
6. **Load data and logins** from your machine (see DEPLOY.md, step 5).
7. Optional: UptimeRobot pinging `<render-url>/health` every 5 minutes.

Later, live Snowflake: add the service user's private key to Render as an environment variable and point
the workspace's Connect step at it (needs the service user and no IP restriction for the host).
