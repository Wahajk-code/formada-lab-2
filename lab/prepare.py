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
