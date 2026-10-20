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

Auth: every /api endpoint except /api/health requires an X-Station-Key header
matching one of STATION_API_KEYS. The previous build had no auth at all and
CORS wide open, which meant anyone with the URL could read the roster of any
event by name. A static per-station key is not sophisticated, but it is the
difference between "open to the internet" and "not".
"""

import logging
import os
import secrets
import tempfile
from datetime import datetime

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
import db
from generate_marker import ALL_SIZES, marker_pdf_bytes, marker_square_png_bytes
from pipeline import run

logging.basicConfig(level=os.environ.get("LOG_LEVEL", "INFO"))
log = logging.getLogger(__name__)

app = FastAPI(title="CV Measurement Station", version="2.0.0")

# ------------------------------------------------------------------- auth

_KEYS = {k.strip() for k in os.environ.get("STATION_API_KEYS", "").split(",") if k.strip()}
if not _KEYS:
    log.warning(
        "STATION_API_KEYS is empty — the API is UNAUTHENTICATED. Set it to one "
        "or more comma-separated station keys before this is reachable from "
        "anywhere but localhost."
    )


async def require_station_key(x_station_key: str | None = Header(default=None)):
    if not _KEYS:
        return None
    if not x_station_key:
        raise HTTPException(status_code=401, detail="Missing X-Station-Key")
    # compare_digest against each key: a plain `in` leaks key length and
    # content through timing, and this check runs on every tap.
    if not any(secrets.compare_digest(x_station_key, k) for k in _KEYS):
        raise HTTPException(status_code=403, detail="Invalid station key")
    return x_station_key


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
    allow_headers=["Content-Type", "X-Station-Key"],
)

STATION_CODE = os.environ.get("STATION_CODE", "cv_app")


# ------------------------------------------------------------------ health

@app.get("/api/health")
async def health():
    """Unauthenticated on purpose — it is how the station tells you why it is unhappy."""
    try:
        db_ok = db.ping()
        db_err = None
    except Exception as exc:
        db_ok, db_err = False, str(exc)
    return {
        "ok": db_ok,
        "database": os.environ.get("DB_NAME", "new_lab_pipeline"),
        "database_error": db_err,
        "station_code": STATION_CODE,
        "auth_enabled": bool(_KEYS),
        "artifact_backend": artifacts.describe_backend(),
        "marker_sizes_cm": sorted(ALL_SIZES),
        # Surfaced so a wrong LAB_TIMEZONE is visible here rather than being
        # inferred a week later from capture dates that are off by one.
        "lab_timezone": db.LAB_TIMEZONE,
        "lab_date": db.lab_today().isoformat(),
    }


# ------------------------------------------------------------ station setup

@app.get("/api/stations", dependencies=[Depends(require_station_key)])
async def stations():
    try:
        return db.list_stations()
    except Exception as exc:
        raise HTTPException(status_code=500, detail=str(exc))


@app.get("/api/event-sessions", dependencies=[Depends(require_station_key)])
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


@app.post("/api/subject/resolve", dependencies=[Depends(require_station_key)])
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


@app.post("/api/capture/save", dependencies=[Depends(require_station_key)])
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


@app.post("/api/capture/additional", dependencies=[Depends(require_station_key)])
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


@app.post("/api/capture/photo", dependencies=[Depends(require_station_key)])
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

@app.get("/api/station/audit", dependencies=[Depends(require_station_key)])
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

@app.get("/api/marker/{cm}")
async def marker(cm: float):
    if cm not in ALL_SIZES:
        raise HTTPException(status_code=400, detail=f"Marker size must be one of {sorted(ALL_SIZES)}")
    return Response(content=marker_square_png_bytes(cm), media_type="image/png")


@app.get("/api/marker/{cm}/pdf")
async def marker_pdf(cm: float):
    if cm not in ALL_SIZES:
        raise HTTPException(status_code=400, detail=f"Marker size must be one of {sorted(ALL_SIZES)}")
    headers = {"Content-Disposition": f'inline; filename="marker_{int(cm)}cm.pdf"'}
    return Response(content=marker_pdf_bytes(cm), media_type="application/pdf", headers=headers)


# ---------------------------------------------------------------- measure

@app.post("/api/measure", dependencies=[Depends(require_station_key)])
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
