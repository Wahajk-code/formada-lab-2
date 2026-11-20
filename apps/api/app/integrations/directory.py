"""Company directories for the org chart import (ADR 0027). Only this module talks to Microsoft.

MockDirectory returns an invented company so the flow works locally without Microsoft.
GraphDirectory uses our multi-tenant Entra app registration: the client's admin consents once
(adminconsent URL), then we read users and their managers with the client-credentials grant.
Application permission needed: User.Read.All. The client secret comes from the vault.
"""

import asyncio
from typing import Any, Protocol
from urllib.parse import urlencode

import httpx

from app.core.secrets import get_vault
from app.core.settings import get_settings

GRAPH = "https://graph.microsoft.com/v1.0"
LOGIN = "https://login.microsoftonline.com"
SCOPE = "https://graph.microsoft.com/.default"
MAX_PAGES = 20


class DirectoryError(RuntimeError):
    """Shown to the client: the directory could not be read."""


class Directory(Protocol):
    def consent_url(self, redirect_uri: str, state: str) -> str: ...

    async def users(self, directory_tenant: str) -> list[dict[str, Any]]:
        """[{id, name, email, title, department, manager_id}]"""
        ...


class MockDirectory:
    PEOPLE: tuple[tuple[str, str, str, str, str | None], ...] = (
        ("u1", "Alex Morgan", "Chief Executive Officer", "", None),
        ("u2", "Sam Rivera", "VP Operations", "Operations", "u1"),
        ("u3", "Jordan Lee", "Inventory Planner", "Operations", "u2"),
        ("u4", "Taylor Brooks", "Distribution Centre Manager", "Operations", "u2"),
        ("u5", "Casey Nguyen", "Store Operations Manager", "Retail", "u2"),
        ("u6", "Robin Patel", "VP Merchandising", "Merchandising", "u1"),
        ("u7", "Jamie Chen", "Senior Buyer", "Merchandising", "u6"),
        ("u8", "Drew Martin", "Chief Financial Officer", "Finance", "u1"),
        ("u9", "Meeting Room 2", "", "", None),  # skipped: no title, no manager
    )

    def consent_url(self, redirect_uri: str, state: str) -> str:
        q = urlencode({"tenant": "mock", "admin_consent": "True", "state": state})
        return f"{redirect_uri}?{q}"

    async def users(self, directory_tenant: str) -> list[dict[str, Any]]:
        del directory_tenant
        await asyncio.sleep(0.8)  # feels like a call
        return [
            {"id": i, "name": n, "email": f"{n.split()[0].lower()}@example.com" if t else "",
             "title": t, "department": d, "manager_id": m}
            for i, n, t, d, m in self.PEOPLE
        ]  # fmt: skip


class GraphDirectory:
    def __init__(self, client_id: str, secret: str) -> None:
        self._client_id, self._secret = client_id, secret

    def consent_url(self, redirect_uri: str, state: str) -> str:
        q = {"client_id": self._client_id, "scope": SCOPE, "redirect_uri": redirect_uri,
             "state": state}  # fmt: skip
        return f"{LOGIN}/organizations/v2.0/adminconsent?{urlencode(q)}"

    async def users(self, directory_tenant: str) -> list[dict[str, Any]]:
        async with httpx.AsyncClient(timeout=30) as http:
            tok = await http.post(
                f"{LOGIN}/{directory_tenant}/oauth2/v2.0/token",
                data={"client_id": self._client_id, "client_secret": self._secret,
                      "scope": SCOPE, "grant_type": "client_credentials"},
            )  # fmt: skip
            if tok.status_code != 200:
                raise DirectoryError("Microsoft refused access; ask your admin to approve again")
            headers = {"Authorization": f"Bearer {tok.json()['access_token']}"}
            fields = "id,displayName,mail,userPrincipalName,jobTitle,department,accountEnabled"
            url: str | None = f"{GRAPH}/users?$select={fields}&$expand=manager($select=id)&$top=999"
            out: list[dict[str, Any]] = []
            for _ in range(MAX_PAGES):
                if not url:
                    break
                r = await http.get(url, headers=headers)
                if r.status_code != 200:
                    raise DirectoryError("the directory could not be read (User.Read.All needed)")
                body = r.json()
                for u in body.get("value", []):
                    if u.get("accountEnabled") is False:
                        continue
                    out.append({
                        "id": u["id"], "name": u.get("displayName") or "",
                        "email": u.get("mail") or u.get("userPrincipalName") or "",
                        "title": u.get("jobTitle") or "", "department": u.get("department") or "",
                        "manager_id": (u.get("manager") or {}).get("id"),
                    })  # fmt: skip
                url = body.get("@odata.nextLink")
        return out


def get_directory() -> Directory:
    s = get_settings()
    if s.directory_backend == "graph":
        if not s.ms_graph_client_id:
            raise DirectoryError("Microsoft import is not configured")
        return GraphDirectory(s.ms_graph_client_id, get_vault().get_secret(s.ms_graph_secret_ref))
    return MockDirectory()
