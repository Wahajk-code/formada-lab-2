"""Create (or reset) the lab's staff accounts. Run locally against the lab database:

  DATABASE_OWNER_URL=postgresql+asyncpg://app_owner:...@HOST/neondb \
  LAB_STAFF="ada@example.com:Ada:admin:a-long-password,bo@example.com:Bo:developer:another" \
  python lab/create_staff.py

Format per account: email:Name:role:password (role is admin or developer).
"""
import asyncio
import os
import uuid

from sqlalchemy import select

from app.core.db import global_tx
from app.core.passwords import hash_password
from app.models import StaffUser


async def main() -> None:
    entries = [e for e in os.environ["LAB_STAFF"].split(",") if e.strip()]
    async with global_tx("owner") as s:
        for entry in entries:
            email, name, role, password = [x.strip() for x in entry.split(":", 3)]
            row = await s.scalar(select(StaffUser).where(StaffUser.email == email))
            if row is None:
                s.add(StaffUser(id=uuid.uuid4(), email=email, name=name, staff_role=role,
                                password_hash=hash_password(password)))
                print("created", email, role)
            else:
                row.name, row.staff_role, row.password_hash = name, role, hash_password(password)
                print("updated", email, role)


asyncio.run(main())
