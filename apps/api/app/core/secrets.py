"""Secrets vault abstraction. Local: env or JSON file. Production: cloud KMS-backed manager (later).

A secret_ref is an opaque name stored in Postgres (e.g. "tenant/<id>/snowflake_key");
the key material itself never touches Postgres, logs or the browser.
"""

import json
import os
from functools import lru_cache
from pathlib import Path
from typing import ClassVar, Protocol

from cryptography.hazmat.primitives import serialization

from app.core.settings import get_settings


class SecretsVault(Protocol):
    def get(self, ref: str) -> str: ...


class EnvVault:
    """ref "tenant/abc/snowflake_key" -> env var SECRET_TENANT_ABC_SNOWFLAKE_KEY."""

    ALIASES: ClassVar[dict[str, str]] = {"platform/snowflake_pat": "SNOWFLAKE_PAT"}

    def get(self, ref: str) -> str:
        name = self.ALIASES.get(ref) or (
            "SECRET_" + "".join(c if c.isalnum() else "_" for c in ref).upper()
        )
        value = os.environ.get(name)
        if value is None:
            raise KeyError(f"secret {ref!r} not found")
        return value


class FileVault:
    def __init__(self, path: Path) -> None:
        self._path = path

    def get(self, ref: str) -> str:
        data: dict[str, str] = json.loads(self._path.read_text(encoding="utf-8"))
        return data[ref]


class Vault:
    def __init__(self, backend: SecretsVault) -> None:
        self._backend = backend

    def get_secret(self, ref: str) -> str:
        return self._backend.get(ref)

    def get_private_key_der(self, ref: str) -> bytes:
        pem = self._backend.get(ref).encode()
        key = serialization.load_pem_private_key(pem, password=None)
        return key.private_bytes(
            serialization.Encoding.DER,
            serialization.PrivateFormat.PKCS8,
            serialization.NoEncryption(),
        )


@lru_cache
def get_vault() -> Vault:
    settings = get_settings()
    backend: SecretsVault = (
        FileVault(Path(settings.secrets_file_path))
        if settings.secrets_backend == "file"
        else EnvVault()
    )
    return Vault(backend)
