"""
Brute-force guard for the shared 6-digit PIN login.

Shared verbatim by the CV measurement app and the check-in app, exactly as
auth.py is. Change it in one and copy it to the other.

Why it exists: a 6-digit PIN is a million guesses, both APIs are on public
URLs, and the original PIN decision (2026-09-30) was explicitly "unlimited
attempts, no lockout" for a prototype that was not yet exposed. Unthrottled,
a single connection at 10 requests a second walks the whole space in under
two days and nothing anywhere slows down or trips.

Three layers, because each one alone has a hole:

  1. A short delay on a failed attempt, once an address has missed a few
     times. Costs the attacker wall-clock; costs a typo'd PIN nothing.
  2. A per-address lockout after MAX_FAILS. Returns 429 immediately without
     comparing the PIN, so a locked address cannot even be timed.
  3. A global failure rate. Layers 1 and 2 key on the client address, which
     comes from X-Forwarded-For and is therefore only as trustworthy as the
     platform in front of us — an attacker who can vary it gets a fresh
     bucket every request. When failures across ALL addresses exceed
     GLOBAL_FAILS in the window, every failure slows down regardless of who
     it claims to be. Spoofing the header stops helping.

The delay is an async sleep, so a slowed request releases its worker rather
than holding it. That matters on the CV app, which shares its instance with
MediaPipe: a blocking sleep here would be its own denial of service.

State is in-process and deliberately bounded. On the CV app (Azure App
Service, a long-lived process) it behaves as written. On check-in (Vercel,
serverless) each instance keeps its own counters and they reset when an
instance is recycled, so layers 1 and 2 are best-effort there and layer 3
is what carries. Durable cross-instance counters would need a table, and
adding one is a schema change this is not the place to make.
"""

import asyncio
import os
import time
from collections import deque

# Tunable through the environment mostly so tests can set the delay to zero.
FAIL_WINDOW_SECONDS = int(os.environ.get("LOGIN_FAIL_WINDOW_SECONDS", "900"))
MAX_FAILS = int(os.environ.get("LOGIN_MAX_FAILS", "10"))
LOCKOUT_SECONDS = int(os.environ.get("LOGIN_LOCKOUT_SECONDS", "900"))
SLOW_AFTER = int(os.environ.get("LOGIN_SLOW_AFTER", "3"))
DELAY_SECONDS = float(os.environ.get("LOGIN_FAIL_DELAY_SECONDS", "0.5"))
GLOBAL_FAILS = int(os.environ.get("LOGIN_GLOBAL_FAILS", "50"))

# A spoofed header must not be able to grow this without bound.
MAX_TRACKED = 2048

_fails: dict[str, deque[float]] = {}
_locked: dict[str, float] = {}
_global: deque[float] = deque()


def client_key(request) -> str:
    """
    Who is attempting. X-Forwarded-For's first entry is the client as far as
    Azure App Service and Vercel report it; both set the header themselves.
    It is still client-influenced in principle, which is precisely why the
    global layer above does not depend on it.
    """
    xff = request.headers.get("x-forwarded-for", "")
    if xff:
        return xff.split(",")[0].strip()[:64]
    client = getattr(request, "client", None)
    return (getattr(client, "host", None) or "unknown")[:64]


def _prune(now: float) -> None:
    while _global and _global[0] < now - FAIL_WINDOW_SECONDS:
        _global.popleft()
    for key in [k for k, until in _locked.items() if until <= now]:
        _locked.pop(key, None)
    for key in [k for k, hits in _fails.items()
                if not hits or hits[-1] < now - FAIL_WINDOW_SECONDS]:
        _fails.pop(key, None)
    # Hard cap after pruning: drop whoever was least recently seen.
    if len(_fails) > MAX_TRACKED:
        for key in sorted(_fails, key=lambda k: _fails[k][-1])[:len(_fails) - MAX_TRACKED]:
            _fails.pop(key, None)


def locked_for(key: str) -> int:
    """Seconds this address stays locked out, or 0 if it is not."""
    now = time.time()
    _prune(now)
    until = _locked.get(key, 0)
    return max(0, int(until - now)) if until > now else 0


async def penalise(key: str) -> None:
    """
    Record a failed attempt and apply whatever slowdown it has earned.

    Called after the PIN is known to be wrong, so a correct PIN never waits.
    """
    now = time.time()
    _prune(now)

    hits = _fails.setdefault(key, deque())
    hits.append(now)
    while hits and hits[0] < now - FAIL_WINDOW_SECONDS:
        hits.popleft()
    _global.append(now)

    if len(hits) >= MAX_FAILS:
        _locked[key] = now + LOCKOUT_SECONDS

    if DELAY_SECONDS > 0 and (len(hits) >= SLOW_AFTER or len(_global) >= GLOBAL_FAILS):
        await asyncio.sleep(DELAY_SECONDS)


def succeed(key: str) -> None:
    """A correct PIN clears that address. It does not clear the global count."""
    _fails.pop(key, None)
    _locked.pop(key, None)


def snapshot() -> dict:
    """For /api/health. Counts only — never an address, never a PIN."""
    now = time.time()
    _prune(now)
    return {
        "tracked_addresses": len(_fails),
        "locked_out": len(_locked),
        "failures_in_window": len(_global),
        "window_seconds": FAIL_WINDOW_SECONDS,
    }


def reset() -> None:
    """Test hook. Nothing in the app should call this."""
    _fails.clear()
    _locked.clear()
    _global.clear()
