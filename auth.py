"""
PIN login for the CV measurement app.

A verbatim port of CSE_checkin/auth.py. The logic is deliberately identical
so the two apps stay diffable and a future change to one is a copy to the
other. Only this docstring differs.

Two shared 6-digit PINs, both set as environment variables (Azure App
Service here, Vercel in check-in):

    DESK_PIN    opens the station
    ADMIN_PIN   opens the station plus anything marked admin

Logging in returns a signed session token that lasts until the end of the
day on the device that logged in (capped at 24 hours). The browser sends it
on every request as `Authorization: Bearer <token>`.

The token is signed with a key derived from both PINs and the database
password, so:
  - nothing extra has to be configured to sign sessions, and
  - changing either PIN logs every device out on the next deploy.

A consequence worth knowing: CV and check-in use different database
accounts (`integration` vs `cse_integration`), so their signing keys differ
and a token from one app will not verify in the other. The operator types
the same PIN into both apps and gets a separate session in each. That is
the intended behaviour — one compromised session does not open both — but
it is not single sign-on, and nobody should expect it to be.

Prototype scope, inherited from check-in's decision of 2026-09-30: unlimited
PIN attempts, no lockout. Revisit before wider use; a 6-digit PIN with no
attempt limit can be guessed.
"""

import base64
import hashlib
import hmac
import json
import os
import re
import time
from datetime import datetime, timezone

from fastapi import Header, HTTPException

_PIN_RE = re.compile(r"^\d{6}$")
MAX_SESSION_SECONDS = 24 * 3600
DEFAULT_SESSION_SECONDS = 16 * 3600


def _pins() -> dict[str, str]:
    return {
        "desk": os.environ.get("DESK_PIN", "").strip(),
        "admin": os.environ.get("ADMIN_PIN", "").strip(),
    }


def configured() -> bool:
    """True when login can actually work. Drives the transitional grace path."""
    return status()["ok"]


def status() -> dict:
    """For /api/health. Says whether login can work, never what the PINs are."""
    p = _pins()
    problems = []
    for role, pin in p.items():
        var = f"{role.upper()}_PIN"
        if not pin:
            problems.append(f"{var} is not set")
        elif not _PIN_RE.match(pin):
            problems.append(f"{var} must be exactly 6 digits")
    if p["desk"] and p["desk"] == p["admin"]:
        problems.append("DESK_PIN and ADMIN_PIN must be different")
    return {"ok": not problems, "problems": problems}


def _signing_key() -> bytes:
    p = _pins()
    material = "|".join(["cse-pin-session-v1", p["desk"], p["admin"],
                         os.environ.get("DB_PASSWORD", "")])
    return hashlib.sha256(material.encode()).digest()


def _b64(data: bytes) -> str:
    return base64.urlsafe_b64encode(data).rstrip(b"=").decode()


def _unb64(text: str) -> bytes:
    return base64.urlsafe_b64decode(text + "=" * (-len(text) % 4))


def _sign(body: str) -> str:
    return _b64(hmac.new(_signing_key(), body.encode(), hashlib.sha256).digest())


def login(pin: str, expires_at: str | None = None) -> dict:
    """
    Check a PIN. Returns {token, role, expires_at} or raises HTTPException.

    expires_at is the device's own "end of today" as an ISO timestamp, so the
    session ends at local midnight wherever the event is. The server caps it
    at 24 hours from now.
    """
    st = status()
    if not st["ok"]:
        raise HTTPException(503, "Login is not set up yet: " + "; ".join(st["problems"]))

    pin = (pin or "").strip()
    p = _pins()
    role = None
    # compare_digest on both, every time, so timing does not hint which matched
    is_admin = hmac.compare_digest(pin, p["admin"])
    is_desk = hmac.compare_digest(pin, p["desk"])
    if is_admin:
        role = "admin"
    elif is_desk:
        role = "desk"
    if not role:
        raise HTTPException(401, "Wrong PIN")

    now = time.time()
    exp = now + DEFAULT_SESSION_SECONDS
    if expires_at:
        try:
            dt = datetime.fromisoformat(expires_at.replace("Z", "+00:00"))
            if dt.tzinfo is None:
                dt = dt.replace(tzinfo=timezone.utc)
            exp = dt.timestamp()
        except ValueError:
            pass
    exp = int(max(now + 60, min(exp, now + MAX_SESSION_SECONDS)))

    body = _b64(json.dumps({"r": role, "e": exp}, separators=(",", ":")).encode())
    token = f"{body}.{_sign(body)}"
    return {"token": token, "role": role,
            "expires_at": datetime.fromtimestamp(exp, timezone.utc).isoformat()}


def verify(token: str | None) -> dict | None:
    """Returns {role, exp} for a valid, unexpired token, else None."""
    if not token or "." not in token or not status()["ok"]:
        return None
    body, sig = token.rsplit(".", 1)
    if not hmac.compare_digest(sig, _sign(body)):
        return None
    try:
        data = json.loads(_unb64(body))
    except Exception:
        return None
    if data.get("r") not in ("desk", "admin") or int(data.get("e", 0)) < time.time():
        return None
    return {"role": data["r"], "exp": int(data["e"])}


def bearer(authorization: str | None) -> str | None:
    if authorization and authorization.lower().startswith("bearer "):
        return authorization[7:].strip()
    return None


async def require_login(authorization: str | None = Header(default=None)) -> dict:
    session = verify(bearer(authorization))
    if not session:
        raise HTTPException(401, "Log in with the desk PIN")
    return session


async def require_admin(authorization: str | None = Header(default=None)) -> dict:
    session = verify(bearer(authorization))
    if not session:
        raise HTTPException(401, "Log in with the admin PIN")
    if session["role"] != "admin":
        raise HTTPException(403, "This needs the admin PIN")
    return session
