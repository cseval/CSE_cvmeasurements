"""CV measurement station — FastAPI backend (NFC-native rebuild).

Identity model (HANDOFF-NFC-REBUILD.md):
  * The only subject input is a tag UID — an identifier, never a credential,
    and never a name. No roster reads, no player/attendees tables, ever.
  * Persistence is schema-agnostic: persistence/ maps this app's contract
    onto whichever lab schema SCHEMA_PROFILE selects (handoff §6.0).
  * All measurements cross the wire in centimeters; the adapter stores
    DECIMAL cm (display-side conversion to ft/in only).

Carried over unchanged: /api/measure (CV pipeline) and /api/marker.
Removed (identity-native): /api/athletes, /api/events,
/api/events/{id}/roster, /api/athletes/{id}/status, /api/save,
/api/save_additional — replaced by /api/subject/resolve,
/api/capture/save, /api/scan/log below.
"""
import hmac
import os
import tempfile

# Must be set before mediapipe imports so model downloads work on macOS
try:
    import certifi
    os.environ.setdefault("SSL_CERT_FILE", certifi.where())
except ImportError:
    pass

from fastapi import Depends, FastAPI, File, Form, HTTPException, Request, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import Response
from pydantic import BaseModel

from generate_marker import ALL_SIZES, marker_pdf_bytes, marker_square_png_bytes
from persistence import MARKER_SIZES, get_adapter
from pipeline import run

STATION_API_KEY = os.environ.get("STATION_API_KEY", "").strip()
adapter = get_adapter()

app = FastAPI(title="CV Measurement Station")
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["GET", "POST", "OPTIONS"],
    allow_headers=["*"],
)


def require_station_token(request: Request) -> None:
    """Static station key (handoff §4.4) — a strict improvement over open.

    STATION_API_KEY unset = dev mode (open access) so the station can be
    brought up without ceremony; production must set it.
    """
    if not STATION_API_KEY:
        return
    provided = request.headers.get("X-Station-Token", "")
    if not hmac.compare_digest(provided.encode("utf-8"), STATION_API_KEY.encode("utf-8")):
        raise HTTPException(status_code=401, detail="invalid or missing station token")


# ── station bootstrap ──────────────────────────────────────────────────
@app.get("/api/health")
async def health():
    return {"ok": True, "profile": adapter.profile, "auth_required": bool(STATION_API_KEY)}


@app.get("/api/station/bootstrap", dependencies=[Depends(require_station_token)])
async def station_bootstrap():
    return {
        "profile": adapter.profile,
        "marker_sizes": list(MARKER_SIZES),
        "uid_rule": "8-20 uppercase hex chars, even length (NTAG21x = 14, Mifare Classic = 8)",
    }


# ── subject resolution — UID in, opaque handle out, NEVER identity ─────
class ResolveRequest(BaseModel):
    uid: str
    prefix: str = ""


@app.post("/api/subject/resolve", dependencies=[Depends(require_station_token)])
async def subject_resolve(req: ResolveRequest):
    try:
        return adapter.resolve_subject(req.uid)
    except ValueError as e:
        raise HTTPException(status_code=422, detail=str(e))
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


# ── capture save: session + trial (movement_screen) + result row ───────
class CapturePayload(BaseModel):
    batch_id: str | None = None          # app-side record id (correlation)
    trial_ref: str | None = None         # set => update that trial's result only
    raw_uid: str | None = None           # null => test mode (no subject)
    prefix: str = ""                     # reader PREFIX at capture time
    station: dict = {}
    capture: dict = {}


@app.post("/api/capture/save", dependencies=[Depends(require_station_token)])
async def capture_save(payload: CapturePayload):
    try:
        return adapter.save_capture(payload.model_dump())
    except LookupError as e:
        raise HTTPException(status_code=404, detail=str(e))
    except ValueError as e:
        raise HTTPException(status_code=422, detail=str(e))
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


# ── scan log: every tap, resolved or not, capture or not ───────────────
class ScanEntry(BaseModel):
    raw_scan_value: str
    uid: str | None = None
    prefix: str = ""
    resolved: bool = False
    enrolled: bool | None = None
    subject_key: str | None = None
    binding_id: int | None = None
    station: dict = {}
    operator: str | None = None
    device_id: str | None = None
    scanned_at: str | None = None
    capture_batch_id: str | None = None


@app.post("/api/scan/log", dependencies=[Depends(require_station_token)])
async def scan_log(entry: ScanEntry):
    try:
        scan_id = adapter.log_scan(entry.model_dump())
        return {"scan_id": scan_id}
    except ValueError as e:
        raise HTTPException(status_code=422, detail=str(e))
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


# ── marker generation (unchanged) ──────────────────────────────────────
@app.get("/api/marker/{cm}", dependencies=[Depends(require_station_token)])
async def marker(cm: float):
    if cm not in ALL_SIZES:
        raise HTTPException(status_code=400, detail=f"Marker size must be one of {ALL_SIZES}")
    png_bytes = marker_square_png_bytes(cm)
    return Response(content=png_bytes, media_type="image/png")


@app.get("/api/marker/{cm}/pdf", dependencies=[Depends(require_station_token)])
async def marker_pdf(cm: float):
    if cm not in ALL_SIZES:
        raise HTTPException(status_code=400, detail=f"Marker size must be one of {ALL_SIZES}")
    pdf_bytes = marker_pdf_bytes(cm)
    headers = {"Content-Disposition": f'inline; filename="marker_{int(cm)}cm.pdf"'}
    return Response(content=pdf_bytes, media_type="application/pdf", headers=headers)


# ── CV measurement (unchanged; already identity-free) ──────────────────
@app.post("/api/measure", dependencies=[Depends(require_station_token)])
async def measure(image: UploadFile = File(...), marker_cm: float = Form(20.0)):
    suffix = os.path.splitext(image.filename or ".jpg")[1] or ".jpg"
    with tempfile.NamedTemporaryFile(suffix=suffix, delete=False) as f:
        f.write(await image.read())
        tmp_path = f.name
    try:
        measurements, _ = run(tmp_path, debug=True, marker_cm=marker_cm)
        return measurements
    except RuntimeError as e:
        raise HTTPException(status_code=422, detail=str(e))
    finally:
        os.unlink(tmp_path)
