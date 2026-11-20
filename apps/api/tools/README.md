# Developer tools

One-off helpers for developers. They are not part of the API and are never imported by it.

| Tool | What it does |
|---|---|
| `try_top_items.py` | Tries the "top items behind a signal" query against a workspace: `python -m tools.try_top_items <workspace_id>` |

Tools that touch a real customer warehouse stay out of the repo (private folder).
