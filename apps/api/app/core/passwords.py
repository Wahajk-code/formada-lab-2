"""Password hashing (ADR 0023): scrypt from the standard library, no extra dependency.

Stored as scrypt$n$r$p$salt$hash (base64). Parameters travel with the hash, so they can be
raised later and old hashes still verify. Comparison is constant-time.
"""

import base64
import hashlib
import hmac
import os

N, R, P, DKLEN = 2**14, 8, 1, 32


def _b64(raw: bytes) -> str:
    return base64.b64encode(raw).decode()


def hash_password(password: str) -> str:
    salt = os.urandom(16)
    digest = hashlib.scrypt(password.encode(), salt=salt, n=N, r=R, p=P, dklen=DKLEN)
    return f"scrypt${N}${R}${P}${_b64(salt)}${_b64(digest)}"


def verify_password(password: str, stored: str | None) -> bool:
    if not stored:
        return False
    try:
        scheme, n, r, p, salt, digest = stored.split("$")
        if scheme != "scrypt":
            return False
        expected = base64.b64decode(digest)
        actual = hashlib.scrypt(
            password.encode(), salt=base64.b64decode(salt), n=int(n), r=int(r), p=int(p),
            dklen=len(expected),
        )  # fmt: skip
    except (ValueError, TypeError):
        return False
    return hmac.compare_digest(actual, expected)


# Verified against when the email is unknown, so a miss takes as long as a wrong password.
DUMMY_HASH = hash_password("not-a-real-password")
