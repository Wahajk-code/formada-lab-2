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
