"""
CV measurement station API — NFC-native.

What changed from the previous build, in one place:

  GONE   GET  /api/athletes            name search over production `player`
  GONE   GET  /api/events              event search over production `events`
  GONE   GET  /api/events/{id}/roster  named roster
  GONE   GET  /api/athletes/{id}/status
  GONE   POST /api/save                upsert keyed on cse_player_id
  GONE   POST /api/save_additional

  NEW    POST /api/subject/resolve     a tap in, an anonymous subject out
  NEW    POST /api/capture/save        a new trial, every time
  NEW    POST /api/capture/additional
  NEW    POST /api/capture/photo
  NEW    GET  /api/station/audit       taps that produced no data
  NEW    GET  /api/stations, /api/event-sessions   for station setup

  KEPT   POST /api/measure             already identity-free
  KEPT   GET  /api/marker/{cm}, /pdf

No endpoint accepts or returns a name, a cse_player_id, or an athlete_id.

Auth: every /api endpoint except /api/health, /api/login and the marker
images requires a session from the shared 6-digit PIN login — the same DESK_PIN
and ADMIN_PIN the check-in app uses. The browser sends `Authorization: Bearer
<token>`; see auth.py.

This replaces the static X-Station-Key, which was never actually turned on
(STATION_API_KEYS has been empty in production, so the API has been open).
During the rollout both are accepted and neither is required; AUTH_ENFORCE
is the switch that closes the door. See the three-merge sequence in
documentation/RUNBOOK.md.
"""

import logging
import os
import secrets
import tempfile
from datetime import datetime, timezone
from functools import lru_cache

# Must be set before mediapipe imports so model downloads work on macOS
try:
    import certifi
    os.environ.setdefault("SSL_CERT_FILE", certifi.where())
except ImportError:
    pass

from fastapi import Depends, FastAPI, File, Form, Header, HTTPException, Query, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import Response
from pydantic import BaseModel, Field

import artifacts
import auth
import db
from generate_marker import ALL_SIZES, marker_pdf_bytes, marker_square_png_bytes
from pipeline import run

logging.basicConfig(level=os.environ.get("LOG_LEVEL", "INFO"))
log = logging.getLogger(__name__)

app = FastAPI(title="CV Measurement Station", version="2.0.0")

# ------------------------------------------------------------------- auth

# Transitional, removed in merge 3. Empty in production and always has been.
_KEYS = {k.strip() for k in os.environ.get("STATION_API_KEYS", "").split(",") if k.strip()}

AUTH_ENFORCE = os.environ.get("AUTH_ENFORCE", "").strip().lower() in ("1", "true", "yes", "on")

if not AUTH_ENFORCE:
    log.warning(
        "AUTH_ENFORCE is off — requests with no session are still accepted. "
        "This is the rollout grace window and it leaves the API open to anyone "
        "with the URL. Set AUTH_ENFORCE=true once the station frontend is "
        "logging in."
    )
elif not auth.configured():
    log.error(
        "AUTH_ENFORCE is on but the PINs are not usable (%s) — every request "
        "will be rejected until DESK_PIN and ADMIN_PIN are set correctly.",
        "; ".join(auth.status()["problems"]),
    )


async def require_session(
    authorization: str | None = Header(default=None),
    x_station_key: str | None = Header(default=None),
) -> dict:
    """
    A valid PIN session, or — during the rollout — the old station key, or —
    until AUTH_ENFORCE is set — nothing at all.

    The grace path exists so merge 1 can ship to Azure without breaking the
    frontend that is live at that moment. The order is: deploy this, set the
    PINs, deploy the frontend that logs in, then set AUTH_ENFORCE=true.
    Flipping AUTH_ENFORCE back off is the rollback.
    """
    session = auth.verify(auth.bearer(authorization))
    if session:
        return session

    if _KEYS and x_station_key and any(
        secrets.compare_digest(x_station_key, k) for k in _KEYS
    ):
        return {"role": "desk", "exp": None, "via": "station_key"}

    if not AUTH_ENFORCE:
        return {"role": "desk", "exp": None, "via": "unauthenticated"}

    # A token that was sent but did not verify is an expired or tampered
    # session, and the station needs to tell those apart from "never logged
    # in" so the queue can pause rather than discard. Both are 401; the
    # detail string is what the frontend reads.
    if authorization:
        raise HTTPException(status_code=401, detail="Session expired — log in again")
    raise HTTPException(status_code=401, detail="Log in with the station PIN")


# ------------------------------------------------------------------- CORS

_origins = [o.strip() for o in os.environ.get("ALLOWED_ORIGINS", "").split(",") if o.strip()]
if not _origins:
    log.warning(
        "ALLOWED_ORIGINS is empty — falling back to '*'. Set it to the station "
        "frontend's origin (the Vercel URL) in production."
    )
    _origins = ["*"]

app.add_middleware(
    CORSMiddleware,
    allow_origins=_origins,
    allow_methods=["GET", "POST", "OPTIONS"],
    # X-Station-Key stays until merge 3 retires the transitional path.
    allow_headers=["Content-Type", "Authorization", "X-Station-Key"],
)

STATION_CODE = os.environ.get("STATION_CODE", "cv_app")


# ------------------------------------------------------------------ health

# The errno is the diagnostic that matters — 1044 and 1045 look identical in
# a browser but mean completely different fixes. The raw exception string is
# what we must not return: it carries the database user and host.
_DB_ERROR_HINTS = {
    1044: "this user has no access to that database",
    1045: "database login rejected (wrong user or password)",
    1049: "that database does not exist",
    2003: "cannot reach the database host",
    2005: "database host name does not resolve",
}


def _safe_db_error(exc: Exception) -> str:
    errno = getattr(exc, "errno", None)
    if errno in _DB_ERROR_HINTS:
        return f"{_DB_ERROR_HINTS[errno]} (MySQL {errno})"
    if errno:
        return f"database error (MySQL {errno}) — see server logs"
    return "database error — see server logs"


@app.get("/api/health")
async def health():
    """Unauthenticated on purpose — it is how the station tells you why it is unhappy."""
    try:
        db_ok = db.ping()
        db_err = None
    except Exception as exc:
        db_ok = False
        log.exception("health: database check failed")
        db_err = _safe_db_error(exc)
    pin = auth.status()
    return {
        "ok": db_ok,
        "database": os.environ.get("DB_NAME", "new_lab_pipeline"),
        "database_error": db_err,
        "station_code": STATION_CODE,
        # Whether a session is *required*, not merely available. During the
        # rollout these differ, and that gap is the thing worth seeing.
        "auth_enforced": AUTH_ENFORCE,
        "pin_login_ready": pin["ok"],
        "pin_login_problems": pin["problems"],
        "station_key_enabled": bool(_KEYS),
        "artifact_backend": artifacts.describe_backend(),
        "marker_sizes_cm": sorted(ALL_SIZES),
        # Surfaced so a wrong LAB_TIMEZONE is visible here rather than being
        # inferred a week later from capture dates that are off by one.
        "lab_timezone": db.LAB_TIMEZONE,
        "lab_date": db.lab_today().isoformat(),
    }


# ------------------------------------------------------------------- login

class LoginRequest(BaseModel):
    pin: str = Field(..., max_length=12, description="6 digits. Never logged.")
    expires_at: str | None = Field(
        default=None, max_length=40,
        description="The device's own end-of-today as ISO 8601, so a session "
                    "ends at local midnight wherever the event is. Capped "
                    "server-side at 24 hours.",
    )


@app.post("/api/login")
async def login(req: LoginRequest):
    """Unauthenticated on purpose — it is how you become authenticated."""
    return auth.login(req.pin, req.expires_at)


@app.get("/api/me")
async def me(session: dict = Depends(auth.require_login)):
    """
    Strict: this always requires a real token, even while AUTH_ENFORCE is off.
    The frontend uses it to answer "is my session still good?", and a grace
    path that answered yes to everyone would make that question useless.
    """
    exp = session.get("exp")
    return {
        "role": session["role"],
        "expires_at": (
            datetime.fromtimestamp(exp, timezone.utc).isoformat() if exp else None
        ),
    }


# ------------------------------------------------------------ station setup

@app.get("/api/stations", dependencies=[Depends(require_session)])
async def stations():
    try:
        return db.list_stations()
    except Exception as exc:
        raise HTTPException(status_code=500, detail=str(exc))


@app.get("/api/event-sessions", dependencies=[Depends(require_session)])
async def event_sessions(limit: int = Query(default=40, ge=1, le=200)):
    try:
        return db.list_event_sessions(limit)
    except Exception as exc:
        raise HTTPException(status_code=500, detail=str(exc))


# ---------------------------------------------------------- tap resolution

class ResolveRequest(BaseModel):
    raw_value: str = Field(
        ..., max_length=200,
        description="Exactly what the reader typed, before any cleanup. "
                    "Sent raw so scan_event can record it verbatim.",
    )
    operator: str | None = Field(default=None, max_length=100)
    device_label: str | None = Field(default=None, max_length=100)
    station_code: str | None = Field(default=None, max_length=30)


@app.post("/api/subject/resolve", dependencies=[Depends(require_session)])
async def resolve(req: ResolveRequest):
    """
    A tap in, an anonymous subject out.

    Always 200 for a well-formed request, including when the scan itself is
    rejected: a malformed tap is a logged event with ok=False, not a server
    error, and the station needs the reason string to show the operator.
    """
    try:
        return db.resolve_subject(
            req.raw_value,
            station_code=req.station_code or STATION_CODE,
            operator=req.operator,
            device_label=req.device_label,
        )
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc))
    except Exception as exc:
        log.exception("resolve failed")
        raise HTTPException(status_code=500, detail=str(exc))


# --------------------------------------------------------------- capture

class CaptureSaveRequest(BaseModel):
    # Exactly one of these two identifies the subject.
    #
    #   subject_id  normal online path: the station resolved the tap while the
    #               athlete was standing there
    #   raw_uid     offline path: the station had no network at tap time, held
    #               the raw scan locally, and the server resolves it now
    #
    # The second one is what lets a station work through a total outage.
    # Requiring an online resolve before measuring would break the
    # write-locally-first invariant at the worst moment — venue wifi fails
    # during the opening rush, with a line of athletes waiting.
    subject_id: int | None = None
    raw_uid: str | None = Field(default=None, max_length=200)
    device_label: str | None = Field(default=None, max_length=100)
    client_ref: str = Field(
        ..., min_length=8, max_length=64,
        description="Idempotency key minted on the device before the first "
                    "send. A retry with the same value returns the original "
                    "trial instead of creating a second one.",
    )
    height_cm: float | None = Field(default=None, gt=0, lt=400)
    wingspan_cm: float | None = Field(default=None, gt=0, lt=400)
    hand_span_cm: float | None = Field(default=None, gt=0, lt=100)

    measurement_method: str = Field(default="cv", max_length=20)
    height_method: str | None = Field(default=None, max_length=20)
    wingspan_method: str | None = Field(default=None, max_length=20)
    hand_span_method: str | None = Field(default=None, max_length=20)

    marker_cm: float | None = None
    px_per_cm: float | None = Field(default=None, gt=0)
    cv_warnings: list[str] | None = None

    event_session_id: int | None = None
    lab_location: str | None = Field(default=None, max_length=100)
    session_type: str | None = Field(default=None, max_length=30)
    sport: str | None = Field(default=None, max_length=20)
    operator: str | None = Field(default=None, max_length=100)
    notes: str | None = Field(default=None, max_length=255)
    scan_event_id: int | None = None
    station_code: str | None = Field(default=None, max_length=30)
    captured_at: datetime | None = Field(
        default=None,
        description="ISO 8601 instant the measurement was taken, from the "
                    "device clock. A capture queued during an outage can sync "
                    "hours later, and this is what keeps it dated to the day "
                    "it actually happened. Omitted means server time.",
    )


@app.post("/api/capture/save", dependencies=[Depends(require_session)])
async def capture_save(req: CaptureSaveRequest):
    if req.marker_cm is not None and req.marker_cm not in ALL_SIZES:
        raise HTTPException(
            status_code=400,
            detail=f"marker_cm must be one of {sorted(ALL_SIZES)}",
        )
    if not any((req.height_cm, req.wingspan_cm, req.hand_span_cm)):
        raise HTTPException(
            status_code=400,
            detail="At least one measurement is required to create a trial",
        )
    if bool(req.subject_id) == bool(req.raw_uid):
        raise HTTPException(
            status_code=400,
            detail="Pass exactly one of subject_id (resolved online) or "
                   "raw_uid (captured offline, resolve now)",
        )
    try:
        payload = req.model_dump(exclude={"station_code"})
        return db.save_capture(station_code=req.station_code or STATION_CODE, **payload)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc))
    except Exception as exc:
        log.exception("capture save failed")
        raise HTTPException(status_code=500, detail=str(exc))


class AdditionalRequest(BaseModel):
    movement_screen_id: int
    age_years: int | None = Field(default=None, ge=4, le=80)
    weight_lb: float | None = Field(default=None, gt=0, lt=600)
    hip_er_r: float | None = Field(default=None, ge=-90, le=180)
    hip_ir_r: float | None = Field(default=None, ge=-90, le=180)
    hip_er_l: float | None = Field(default=None, ge=-90, le=180)
    hip_ir_l: float | None = Field(default=None, ge=-90, le=180)
    tspine_rot_l: float | None = Field(default=None, ge=-90, le=180)
    tspine_rot_r: float | None = Field(default=None, ge=-90, le=180)
    grip_str_r: float | None = Field(default=None, ge=0, le=200)
    grip_str_l: float | None = Field(default=None, ge=0, le=200)


@app.post("/api/capture/additional", dependencies=[Depends(require_session)])
async def capture_additional(req: AdditionalRequest):
    try:
        fields = req.model_dump(exclude={"movement_screen_id"})
        updated = db.save_additional(req.movement_screen_id, fields)
        if updated == 0:
            # Distinguish "nothing to write" from "that row does not exist" —
            # the second is a bug in the client's id handling and should not
            # look like success.
            return {"ok": True, "updated": 0,
                    "note": "no values provided, or row not found"}
        return {"ok": True, "updated": updated}
    except Exception as exc:
        log.exception("additional save failed")
        raise HTTPException(status_code=500, detail=str(exc))


MAX_PHOTO_BYTES = 12 * 1024 * 1024


@app.post("/api/capture/photo", dependencies=[Depends(require_session)])
async def capture_photo(
    image: UploadFile = File(...),
    capture_trial_id: int = Form(...),
    capture_session_id: int = Form(...),
    subject_token: str = Form(...),
    kind: str = Form("tpose_annotated"),
):
    """
    Store a capture photo against a trial.

    Separate from /api/capture/save on purpose: the measurement must land even
    if the photo upload fails or the shift ends before the queue drains. A
    photo is worth keeping; it is not worth blocking a measurement on.
    """
    if kind not in ("tpose_raw", "tpose_annotated"):
        raise HTTPException(status_code=400, detail="kind must be tpose_raw or tpose_annotated")
    content = await image.read()
    if not content:
        raise HTTPException(status_code=400, detail="Empty upload")
    if len(content) > MAX_PHOTO_BYTES:
        raise HTTPException(
            status_code=413,
            detail=f"Photo exceeds {MAX_PHOTO_BYTES // (1024 * 1024)}MB",
        )
    try:
        result = db.record_artifact(
            capture_trial_id=capture_trial_id,
            capture_session_id=capture_session_id,
            subject_token=subject_token,
            kind=kind,
            content=content,
        )
        if result is None:
            raise HTTPException(status_code=502, detail="Artifact storage unavailable")
        return result
    except HTTPException:
        raise
    except Exception as exc:
        log.exception("photo save failed")
        raise HTTPException(status_code=500, detail=str(exc))


# ----------------------------------------------------------------- audit

@app.get("/api/station/audit", dependencies=[Depends(require_session)])
async def station_audit(
    station_code: str | None = Query(default=None),
    on_date: str | None = Query(
        default=None,
        description="YYYY-MM-DD in the lab's timezone, defaults to the "
                    "lab-local today (not the server's UTC today)",
    ),
):
    from datetime import date as _date
    try:
        parsed = _date.fromisoformat(on_date) if on_date else None
    except ValueError:
        raise HTTPException(status_code=400, detail="on_date must be YYYY-MM-DD")
    try:
        return db.station_audit(station_code or STATION_CODE, parsed)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc))
    except Exception as exc:
        log.exception("audit failed")
        raise HTTPException(status_code=500, detail=str(exc))


# ----------------------------------------------------------------- marker

# These two stay public: an operator printing a marker should not have to be
# logged in, and the file is three black squares on white. They are cached
# because they are not free — rendering the PDF measured ~250ms, and it runs
# on the same instance as MediaPipe, so an unauthenticated caller in a loop
# is competing with live measurements for CPU. cm is validated against
# ALL_SIZES before either call, so the cache keys are bounded to that set.
_MARKER_CACHE_HEADERS = {"Cache-Control": "public, max-age=31536000, immutable"}


@lru_cache(maxsize=8)
def _marker_png(cm: float) -> bytes:
    return marker_square_png_bytes(cm)


@lru_cache(maxsize=8)
def _marker_pdf(cm: float) -> bytes:
    return marker_pdf_bytes(cm)


@app.get("/api/marker/{cm}")
async def marker(cm: float):
    if cm not in ALL_SIZES:
        raise HTTPException(status_code=400, detail=f"Marker size must be one of {sorted(ALL_SIZES)}")
    return Response(content=_marker_png(cm), media_type="image/png",
                    headers=dict(_MARKER_CACHE_HEADERS))


@app.get("/api/marker/{cm}/pdf")
async def marker_pdf(cm: float):
    if cm not in ALL_SIZES:
        raise HTTPException(status_code=400, detail=f"Marker size must be one of {sorted(ALL_SIZES)}")
    headers = {"Content-Disposition": f'inline; filename="marker_{int(cm)}cm.pdf"',
               **_MARKER_CACHE_HEADERS}
    return Response(content=_marker_pdf(cm), media_type="application/pdf", headers=headers)


# ---------------------------------------------------------------- measure

@app.post("/api/measure", dependencies=[Depends(require_session)])
async def measure(image: UploadFile = File(...), marker_cm: float = Form(20.0)):
    """
    Unchanged CV path, with one fix: marker_cm is now validated against the
    sizes we actually publish printable markers for. It used to accept any
    float from the client, and an out-of-range value scales every measurement
    linearly with nothing anywhere saying so.
    """
    if marker_cm not in ALL_SIZES:
        raise HTTPException(
            status_code=400,
            detail=f"marker_cm must be one of {sorted(ALL_SIZES)}",
        )
    suffix = os.path.splitext(image.filename or ".jpg")[1] or ".jpg"
    with tempfile.NamedTemporaryFile(suffix=suffix, delete=False) as f:
        f.write(await image.read())
        tmp_path = f.name
    try:
        measurements, _ = run(tmp_path, debug=True, marker_cm=marker_cm)
        return measurements
    except RuntimeError as exc:
        raise HTTPException(status_code=422, detail=str(exc))
    finally:
        os.unlink(tmp_path)
