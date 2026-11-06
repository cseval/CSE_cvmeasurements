"""
PIN login on the CV station API.

Two layers:

  - auth.py on its own: PIN checking, token signing, expiry, tampering
  - the live app through TestClient: which endpoints are guarded, what the
    rollout grace window actually allows, and that the marker PDFs and
    /api/health stay reachable without a session

The grace window is the part most worth testing. It is the thing that lets
merge 1 ship to Azure without breaking the frontend that is live at that
moment, and it is also the thing that leaves the API open if nobody ever
flips AUTH_ENFORCE. Both halves of that are asserted here.
"""

import importlib
import json
import sys
import time
import types
from datetime import date

import pytest
from fastapi.testclient import TestClient


def _install_missing_stubs():
    """
    server.py imports MediaPipe and OpenCV through pipeline.py, and a database
    driver through db.py. None of that is needed to test a PIN.

    Only genuinely-absent modules are stubbed, and never one already imported:
    test_capture_flow.py runs against a real database in the same pytest
    session, and a stub left in sys.modules would quietly break it.
    """
    stubs = {
        "artifacts": dict(describe_backend=lambda: "stub"),
        "db": dict(ping=lambda: True, LAB_TIMEZONE="America/Denver",
                   lab_today=lambda: date(2026, 11, 6),
                   list_stations=lambda: [{"station_code": "cv_app"}],
                   list_event_sessions=lambda limit: [],
                   resolve_subject=lambda *a, **k: {"ok": True},
                   save_capture=lambda *a, **k: {"ok": True},
                   save_additional=lambda *a, **k: 1,
                   record_artifact=lambda *a, **k: {"ok": True},
                   station_audit=lambda *a, **k: {"taps": []}),
        "generate_marker": dict(ALL_SIZES=[12, 16, 20],
                                marker_pdf_bytes=lambda cm: b"%PDF-stub",
                                marker_square_png_bytes=lambda cm: b"\x89PNG-stub"),
        "pipeline": dict(run=lambda *a, **k: ({"height_cm": 180.0}, None)),
    }
    for name, attrs in stubs.items():
        if name in sys.modules:
            continue
        try:
            importlib.import_module(name)
            continue
        except Exception:
            mod = types.ModuleType(name)
            mod.__dict__.update(attrs)
            sys.modules[name] = mod


_install_missing_stubs()

DESK = "314159"
ADMIN = "271828"


@pytest.fixture
def env(monkeypatch):
    """Both PINs set, enforcement off: the state right after the PINs are added."""
    monkeypatch.setenv("DESK_PIN", DESK)
    monkeypatch.setenv("ADMIN_PIN", ADMIN)
    monkeypatch.setenv("DB_PASSWORD", "pretend-db-password")
    monkeypatch.delenv("AUTH_ENFORCE", raising=False)
    monkeypatch.delenv("STATION_API_KEYS", raising=False)
    import auth
    importlib.reload(auth)
    return auth


def _app(monkeypatch, **envvars):
    """Reimport server.py with a given environment. AUTH_ENFORCE is read at import."""
    for k, v in envvars.items():
        if v is None:
            monkeypatch.delenv(k, raising=False)
        else:
            monkeypatch.setenv(k, v)
    import auth
    import server
    importlib.reload(auth)
    importlib.reload(server)
    return server, TestClient(server.app)


# ------------------------------------------------------------------ auth.py

def test_desk_pin_returns_a_desk_session(env):
    out = env.login(DESK)
    assert out["role"] == "desk"
    assert env.verify(out["token"]) == {"role": "desk", "exp": pytest.approx(
        env.verify(out["token"])["exp"])}


def test_admin_pin_returns_an_admin_session(env):
    assert env.login(ADMIN)["role"] == "admin"


def test_wrong_pin_is_401(env):
    with pytest.raises(Exception) as exc:
        env.login("000000")
    assert exc.value.status_code == 401


def test_empty_and_missing_pins_are_rejected(env):
    for bad in ("", None, "   "):
        with pytest.raises(Exception) as exc:
            env.login(bad)
        assert exc.value.status_code == 401


def test_login_is_503_when_pins_are_not_configured(monkeypatch):
    monkeypatch.delenv("DESK_PIN", raising=False)
    monkeypatch.delenv("ADMIN_PIN", raising=False)
    import auth
    importlib.reload(auth)
    with pytest.raises(Exception) as exc:
        auth.login("123456")
    assert exc.value.status_code == 503
    assert "not set" in str(exc.value.detail)


def test_status_never_leaks_the_pins(env):
    assert DESK not in json.dumps(env.status())
    assert ADMIN not in json.dumps(env.status())


def test_identical_pins_are_rejected_as_misconfiguration(monkeypatch):
    monkeypatch.setenv("DESK_PIN", DESK)
    monkeypatch.setenv("ADMIN_PIN", DESK)
    import auth
    importlib.reload(auth)
    st = auth.status()
    assert not st["ok"]
    assert any("different" in p for p in st["problems"])


def test_non_numeric_pin_is_a_configuration_problem(monkeypatch):
    monkeypatch.setenv("DESK_PIN", "abcdef")
    monkeypatch.setenv("ADMIN_PIN", ADMIN)
    import auth
    importlib.reload(auth)
    assert any("6 digits" in p for p in auth.status()["problems"])


def test_a_forged_signature_does_not_verify(env):
    token = env.login(ADMIN)["token"]
    body, _ = token.rsplit(".", 1)
    assert env.verify(f"{body}.{'A' * 43}") is None


def test_a_rewritten_role_does_not_verify(env):
    """The whole point of the signature: desk must not be able to claim admin."""
    desk = env.login(DESK)["token"]
    body, sig = desk.rsplit(".", 1)
    forged_body = env._b64(json.dumps(
        {"r": "admin", "e": int(time.time()) + 3600}, separators=(",", ":")).encode())
    assert env.verify(f"{forged_body}.{sig}") is None


def test_an_expired_token_does_not_verify(env):
    body = env._b64(json.dumps(
        {"r": "desk", "e": int(time.time()) - 1}, separators=(",", ":")).encode())
    assert env.verify(f"{body}.{env._sign(body)}") is None


def test_garbage_tokens_do_not_crash(env):
    for junk in (None, "", "no-dot", ".", "a.b", "....", "x" * 500):
        assert env.verify(junk) is None


def test_changing_a_pin_invalidates_live_sessions(env, monkeypatch):
    token = env.login(DESK)["token"]
    assert env.verify(token) is not None
    monkeypatch.setenv("DESK_PIN", "999999")
    assert env.verify(token) is None, "a PIN change must log every device out"


def test_changing_the_db_password_invalidates_live_sessions(env, monkeypatch):
    token = env.login(DESK)["token"]
    monkeypatch.setenv("DB_PASSWORD", "rotated")
    assert env.verify(token) is None


def test_session_is_capped_at_24_hours(env):
    far = "2099-01-01T00:00:00Z"
    exp = env.verify(env.login(DESK, far)["token"])["exp"]
    assert exp <= time.time() + env.MAX_SESSION_SECONDS + 1


def test_a_past_expiry_still_yields_a_usable_session(env):
    """A device with a wrong clock must not mint a token that is dead on arrival."""
    exp = env.verify(env.login(DESK, "2020-01-01T00:00:00Z")["token"])["exp"]
    assert exp > time.time()


def test_an_unparseable_expiry_falls_back_to_the_default(env):
    exp = env.verify(env.login(DESK, "not-a-timestamp")["token"])["exp"]
    assert exp == pytest.approx(time.time() + env.DEFAULT_SESSION_SECONDS, abs=5)


def test_bearer_parsing(env):
    assert env.bearer("Bearer abc") == "abc"
    assert env.bearer("bearer abc") == "abc"
    assert env.bearer("Basic abc") is None
    assert env.bearer(None) is None


# --------------------------------------------------------------- the app

GUARDED = [
    ("get", "/api/stations"),
    ("get", "/api/event-sessions"),
    ("get", "/api/station/audit"),
    ("post", "/api/subject/resolve"),
    ("post", "/api/capture/save"),
    ("post", "/api/capture/additional"),
]


def _call(client, method, path, **kw):
    """GET takes no body; POST needs one or FastAPI 422s before the guard runs."""
    if method == "post":
        kw.setdefault("json", {})
    return getattr(client, method)(path, **kw)


def test_enforced_app_rejects_every_guarded_endpoint(monkeypatch):
    _, client = _app(monkeypatch, DESK_PIN=DESK, ADMIN_PIN=ADMIN,
                     DB_PASSWORD="p", AUTH_ENFORCE="true", STATION_API_KEYS=None)
    for method, path in GUARDED:
        r = _call(client, method, path)
        assert r.status_code == 401, f"{path} answered {r.status_code} with no session"


def test_enforced_app_accepts_a_valid_session(monkeypatch):
    server, client = _app(monkeypatch, DESK_PIN=DESK, ADMIN_PIN=ADMIN,
                          DB_PASSWORD="p", AUTH_ENFORCE="true", STATION_API_KEYS=None)
    token = client.post("/api/login", json={"pin": DESK}).json()["token"]
    h = {"Authorization": f"Bearer {token}"}
    assert client.get("/api/stations", headers=h).status_code == 200
    assert client.get("/api/event-sessions", headers=h).status_code == 200


def test_expired_session_says_so_distinctly(monkeypatch):
    """
    The frontend queue has to tell "expired" from "never logged in": one
    pauses and retries after a re-login, the other is a fresh start. Same
    status, different detail.
    """
    server, client = _app(monkeypatch, DESK_PIN=DESK, ADMIN_PIN=ADMIN,
                          DB_PASSWORD="p", AUTH_ENFORCE="true", STATION_API_KEYS=None)
    import auth
    body = auth._b64(json.dumps({"r": "desk", "e": int(time.time()) - 5},
                                separators=(",", ":")).encode())
    dead = f"{body}.{auth._sign(body)}"
    r = client.get("/api/stations", headers={"Authorization": f"Bearer {dead}"})
    assert r.status_code == 401
    assert "expired" in r.json()["detail"].lower()

    r2 = client.get("/api/stations")
    assert r2.status_code == 401
    assert "expired" not in r2.json()["detail"].lower()


def test_grace_window_lets_the_old_frontend_through(monkeypatch):
    """Merge 1 on Azure, PINs not yet set, old frontend still live."""
    _, client = _app(monkeypatch, DESK_PIN=None, ADMIN_PIN=None,
                     DB_PASSWORD="p", AUTH_ENFORCE=None, STATION_API_KEYS=None)
    for method, path in GUARDED:
        r = _call(client, method, path)
        assert r.status_code != 401, f"{path} broke the live frontend"


def test_grace_window_survives_the_pins_being_set(monkeypatch):
    """
    The window that matters most: PINs are configured so login works, but the
    frontend has not shipped yet. Setting the PINs must not close the door.
    """
    _, client = _app(monkeypatch, DESK_PIN=DESK, ADMIN_PIN=ADMIN,
                     DB_PASSWORD="p", AUTH_ENFORCE=None, STATION_API_KEYS=None)
    assert client.get("/api/stations").status_code == 200
    assert client.post("/api/login", json={"pin": DESK}).status_code == 200


def test_station_key_still_works_during_the_transition(monkeypatch):
    _, client = _app(monkeypatch, DESK_PIN=DESK, ADMIN_PIN=ADMIN, DB_PASSWORD="p",
                     AUTH_ENFORCE="true", STATION_API_KEYS="key-one,key-two")
    assert client.get("/api/stations",
                      headers={"X-Station-Key": "key-two"}).status_code == 200
    assert client.get("/api/stations",
                      headers={"X-Station-Key": "wrong"}).status_code == 401


def test_me_is_strict_even_during_the_grace_window(monkeypatch):
    """Otherwise the frontend cannot tell whether it is really logged in."""
    server, client = _app(monkeypatch, DESK_PIN=DESK, ADMIN_PIN=ADMIN,
                          DB_PASSWORD="p", AUTH_ENFORCE=None, STATION_API_KEYS=None)
    assert client.get("/api/me").status_code == 401
    token = client.post("/api/login", json={"pin": ADMIN}).json()["token"]
    me = client.get("/api/me", headers={"Authorization": f"Bearer {token}"})
    assert me.status_code == 200
    assert me.json()["role"] == "admin"
    assert me.json()["expires_at"]


def test_login_endpoint_rejects_a_wrong_pin(monkeypatch):
    _, client = _app(monkeypatch, DESK_PIN=DESK, ADMIN_PIN=ADMIN,
                     DB_PASSWORD="p", AUTH_ENFORCE="true", STATION_API_KEYS=None)
    r = client.post("/api/login", json={"pin": "000000"})
    assert r.status_code == 401
    assert DESK not in r.text and ADMIN not in r.text


def test_health_and_markers_stay_public(monkeypatch):
    _, client = _app(monkeypatch, DESK_PIN=DESK, ADMIN_PIN=ADMIN,
                     DB_PASSWORD="p", AUTH_ENFORCE="true", STATION_API_KEYS=None)
    assert client.get("/api/health").status_code == 200
    assert client.get("/api/marker/20").status_code == 200
    assert client.get("/api/marker/20/pdf").status_code == 200


def test_health_reports_auth_state_without_leaking_pins(monkeypatch):
    _, client = _app(monkeypatch, DESK_PIN=DESK, ADMIN_PIN=ADMIN,
                     DB_PASSWORD="p", AUTH_ENFORCE=None, STATION_API_KEYS=None)
    body = client.get("/api/health")
    j = body.json()
    assert j["pin_login_ready"] is True
    assert j["auth_enforced"] is False, "the open grace window must be visible here"
    assert DESK not in body.text and ADMIN not in body.text


def test_health_does_not_leak_the_raw_database_error(monkeypatch):
    import db
    import server

    class Denied(Exception):
        errno = 1044

    monkeypatch.setattr(db, "ping", lambda: (_ for _ in ()).throw(
        Denied("1044 (42000): Access denied for user 'integration'@'10.0.0.4'")))
    _, client = _app(monkeypatch, DESK_PIN=DESK, ADMIN_PIN=ADMIN,
                     DB_PASSWORD="p", AUTH_ENFORCE=None, STATION_API_KEYS=None)
    monkeypatch.setattr(server.db, "ping", lambda: (_ for _ in ()).throw(
        Denied("1044 (42000): Access denied for user 'integration'@'10.0.0.4'")))
    r = client.get("/api/health")
    assert r.json()["ok"] is False
    assert "integration" not in r.text, "the DB username must not reach the browser"
    assert "10.0.0.4" not in r.text
    assert "1044" in r.text, "but the errno is the whole diagnostic, keep it"


def test_markers_are_cached_not_regenerated(monkeypatch):
    server, client = _app(monkeypatch, DESK_PIN=DESK, ADMIN_PIN=ADMIN,
                          DB_PASSWORD="p", AUTH_ENFORCE=None, STATION_API_KEYS=None)
    calls = []
    monkeypatch.setattr(server, "marker_pdf_bytes",
                        lambda cm: calls.append(cm) or b"%PDF-x")
    server._marker_pdf.cache_clear()
    for _ in range(5):
        r = client.get("/api/marker/16/pdf")
        assert r.status_code == 200
    assert len(calls) == 1, f"PDF rendered {len(calls)} times for 5 requests"
    assert "immutable" in r.headers["cache-control"]


def test_bad_marker_size_is_rejected_before_the_cache(monkeypatch):
    server, client = _app(monkeypatch, DESK_PIN=DESK, ADMIN_PIN=ADMIN,
                          DB_PASSWORD="p", AUTH_ENFORCE=None, STATION_API_KEYS=None)
    assert client.get("/api/marker/99/pdf").status_code == 400
    assert server._marker_pdf.cache_info().currsize <= len([12, 16, 20])


def test_cors_allows_the_authorization_header(monkeypatch):
    server, client = _app(monkeypatch, DESK_PIN=DESK, ADMIN_PIN=ADMIN,
                          DB_PASSWORD="p", AUTH_ENFORCE="true",
                          STATION_API_KEYS=None, ALLOWED_ORIGINS="https://station.example")
    r = client.options("/api/stations", headers={
        "Origin": "https://station.example",
        "Access-Control-Request-Method": "GET",
        "Access-Control-Request-Headers": "authorization",
    })
    assert r.status_code == 200
    assert "authorization" in r.headers["access-control-allow-headers"].lower()


# ------------------------------------------------- the guard list itself

PUBLIC_BY_DESIGN = {
    "/api/health",       # how you find out why the station is unhappy
    "/api/login",        # how you become authenticated
    "/api/marker/{cm}",  # printable target, decided public 2026-11-05
    "/api/marker/{cm}/pdf",
}


def _api_routes(server):
    for r in server.app.routes:
        path = getattr(r, "path", "")
        if path.startswith("/api/"):
            for m in sorted(getattr(r, "methods", set()) - {"HEAD", "OPTIONS"}):
                yield m.lower(), path


def test_every_api_route_is_guarded_unless_deliberately_public(monkeypatch):
    """
    Hand-maintained lists of protected endpoints rot. This reads the real
    route table, so an endpoint added later without a dependency fails here
    instead of shipping open.
    """
    server, client = _app(monkeypatch, DESK_PIN=DESK, ADMIN_PIN=ADMIN,
                          DB_PASSWORD="p", AUTH_ENFORCE="true", STATION_API_KEYS=None)
    open_routes = []
    for method, path in _api_routes(server):
        if path in PUBLIC_BY_DESIGN:
            continue
        r = _call(client, method, path.replace("{cm}", "20"))
        if r.status_code not in (401, 403):
            open_routes.append(f"{method.upper()} {path} -> {r.status_code}")
    assert not open_routes, "reachable without a session: " + ", ".join(open_routes)


def test_the_public_routes_really_are_reachable(monkeypatch):
    server, client = _app(monkeypatch, DESK_PIN=DESK, ADMIN_PIN=ADMIN,
                          DB_PASSWORD="p", AUTH_ENFORCE="true", STATION_API_KEYS=None)
    paths = {p for _, p in _api_routes(server)}
    assert PUBLIC_BY_DESIGN <= paths, f"stale list: {PUBLIC_BY_DESIGN - paths}"
    assert client.get("/api/health").status_code == 200
    assert client.get("/api/marker/12/pdf").status_code == 200


def test_multipart_endpoints_are_guarded(monkeypatch):
    """/api/measure and /api/capture/photo take files, not JSON — guarded too."""
    server, client = _app(monkeypatch, DESK_PIN=DESK, ADMIN_PIN=ADMIN,
                          DB_PASSWORD="p", AUTH_ENFORCE="true", STATION_API_KEYS=None)
    files = {"image": ("t.jpg", b"not-really-a-jpeg", "image/jpeg")}
    assert client.post("/api/measure", files=files).status_code == 401
    assert client.post("/api/capture/photo", files=files,
                       data={"capture_trial_id": 1, "capture_session_id": 1,
                             "subject_token": "TC-0000-0000"}).status_code == 401
