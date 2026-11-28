"""Make the key pair for one client's Snowflake service user.

python -m app.cli.client_key --ref platform/snowflake_key_acme --name acme

Writes two git-ignored files in secrets/snowflake/:
  acme_rsa_key.p8   the private key (keep it; it is the only copy)
  acme.env-line     the one line to add to the server's environment so the vault finds the key

and prints only what is safe to share: the public key for the client's admin, its fingerprint (the
admin compares it with `DESC USER`), and the name of the environment variable. The private key is
never printed. The same reference goes in the Connect form's "Vault key reference".
"""

import argparse
import base64
import hashlib
from pathlib import Path
from typing import Any

from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.primitives.asymmetric import rsa

from app.core.secrets import EnvVault


def repo_root() -> Path:
    here = Path.cwd().resolve()
    for p in (here, *here.parents):
        if (p / "docker-compose.yml").exists():
            return p
    return here


def make_key(ref: str, name: str, out_dir: Path, force: bool = False) -> dict[str, Any]:
    """Create the key pair, write the two files, and return what may be shown."""
    if not name.replace("-", "").replace("_", "").isalnum():
        raise ValueError("name may contain letters, digits, - and _ only")
    pem_path, line_path = out_dir / f"{name}_rsa_key.p8", out_dir / f"{name}.env-line"
    if (pem_path.exists() or line_path.exists()) and not force:
        raise FileExistsError(f"{pem_path.name} or {line_path.name} exists: it holds a key in use")
    out_dir.mkdir(parents=True, exist_ok=True)
    key = rsa.generate_private_key(public_exponent=65537, key_size=2048)
    pem = key.private_bytes(
        serialization.Encoding.PEM,
        serialization.PrivateFormat.PKCS8,
        serialization.NoEncryption(),
    )
    der = key.public_key().public_bytes(
        serialization.Encoding.DER, serialization.PublicFormat.SubjectPublicKeyInfo
    )
    variable = EnvVault.name_for(ref) + "_B64"
    pem_path.write_bytes(pem)
    line_path.write_text(f"{variable}={base64.b64encode(pem).decode()}\n", encoding="utf-8")
    return {
        "private_key_file": str(pem_path),
        "env_line_file": str(line_path),
        "env_variable": variable,
        "public_key": base64.b64encode(der).decode(),
        "fingerprint": "SHA256:" + base64.b64encode(hashlib.sha256(der).digest()).decode(),
    }


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawTextHelpFormatter)
    ap.add_argument("--ref", required=True, help="the vault key reference, as typed in the form")
    ap.add_argument("--name", required=True, help="a short client name for the file names")
    ap.add_argument(
        "--out", help="folder for the files (default: secrets/snowflake at the repo root)"
    )
    ap.add_argument(
        "--force", action="store_true", help="replace an existing key (it breaks logins)"
    )
    args = ap.parse_args()
    out = Path(args.out) if args.out else repo_root() / "secrets" / "snowflake"
    info = make_key(args.ref, args.name, out, args.force)
    print(f"private key (keep it, never share): {info['private_key_file']}")
    print(f"environment line to add on the server: {info['env_line_file']}")
    print(f"  variable: {info['env_variable']}")
    print(f"fingerprint (the admin compares it with DESC USER): {info['fingerprint']}")
    print("public key to send to the client's admin:")
    print(info["public_key"])


if __name__ == "__main__":
    main()
