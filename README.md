# CV Measurement Station — NFC-Native

Web app that measures an athlete's **height**, **wingspan**, and **hand span**
from a single phone photo (T-pose + ArUco marker for scale), plus a
second-screen assessment (age, weight, hip ER/IR, t-spine, grip strength).

**Rebuilt August 2026 to be NFC-native** (see `HANDOFF-NFC-REBUILD.md`):

- **No roster, no names, no identity in the capture path.** The athlete
  taps an NFC bracelet; the reader (USB HID keyboard) types the tag UID
  and presses Enter. That UID is the only subject key the app ever sees.
- **Local-first.** Saves land in IndexedDB immediately and sync to the
  backend in the background with retry + backoff. A CSV export recovers
  a whole shift if the network is down.
- **Every save is a new trial.** Repeat visits are never overwritten.
- **All measurements stored in centimeters** (`DECIMAL`); ft/in is a
  display-time conversion only.
- **Station auth.** `X-Station-Token` header checked against
  `STATION_API_KEY` (unset = dev mode, open access).
- **Audit.** Every tap — resolved or not, captured or not — is logged to
  the local scan store and synced to the station tap log
  (`station_tap_log` under Schema A, `scan_event` under Schema B).

## Architecture

```
React 18 + Vite 5 (Vercel)  ──HTTPS──▶  FastAPI + MediaPipe + OpenCV (Azure, Python 3.11)
                                              │
                                              ▼
                         persistence/ adapter (SCHEMA_PROFILE)
                         a → new_lab_pipeline        b → cse_db_v2_dev
```

The frontend does no CV work. The persistence layer is schema-agnostic:
`persistence/base.py` defines the contract, `persistence/schema_a.py` and
`persistence/schema_b.py` implement it against the two candidate lab
schemas, and `persistence/__init__.py` selects via `SCHEMA_PROFILE`.
The API contract the app speaks is identical under both.

## Operator flow

```
Station setup (once per shift: station id, lab, event session, operator,
marker size 12/16/20 + PDF, reader prefix, API token)
  → Idle "TAP TO BEGIN" (hidden input focused — the reader is armed)
      → tap → subject resolved (UID only; unenrolled tags proceed, flagged)
  → Camera (live view or photo library; optional 5s countdown)
  → Results (annotated photo, Adjust Lines, Enter Manually,
             save-local-first, pending/synced status)
  → Additional Info (same capture record, same server trial)
  → back to Idle (next tap)
```

Test Mode measures with no subject attached (sanity-checking a marker
print or camera position without polluting data).

## Tap protocol

The reader is a USB HID keyboard (`NEW Pipeline/firmware/code.py`):
uppercase hex, no separators, then Enter; 3 s per-tag cooldown; optional
`PREFIX`. UID length is **not fixed** (NTAG21x = 14 hex chars, Mifare
Classic = 8) — validation is `8–20` hex chars, even length, plus the
configured prefix. Any screen that can receive a tap keeps a focused
input at all times (`TapCatcher` is mounted once, outside the screen
switch, and re-focuses after every submit, blur, and tab return —
invariant 1 from the handoff).

## API

| Endpoint | Purpose |
|---|---|
| `GET /api/health` | liveness; shows active schema profile + auth state |
| `GET /api/station/bootstrap` | marker sizes, UID rule, profile |
| `POST /api/subject/resolve` | UID in → opaque subject handle + `enrolled` flag. **Never returns identity.** |
| `POST /api/capture/save` | session + trial (`trial_type='movement_screen'`) + result row. `trial_ref` set → update that trial's result (additional-info path). |
| `POST /api/scan/log` | one row per tap, resolved or not |
| `POST /api/measure` | image + `marker_cm` → measurements + annotated image (unchanged CV path) |
| `GET /api/marker/{cm}` / `/pdf` | printable marker (12/16/20 cm) |

All endpoints except `/api/health` require `X-Station-Token` when
`STATION_API_KEY` is set.

## Environment

```
# backend (.env / App Service settings)
DB_HOST= DB_PORT=3306 DB_NAME= DB_USER= DB_PASSWORD=   # point at the chosen target DB
SCHEMA_PROFILE=a | b          # handoff §6.0 — human decision (default: a)
STATION_API_KEY=              # station token; unset = dev mode (open)

# frontend (Vercel)
VITE_API_URL=                 # base URL (overridable per-station in Station Setup)
```

## Stack constraints

- Python **3.11** (MediaPipe does not support 3.12+).
- `opencv-contrib-python-headless` only (Azure Linux has no `libxcb`);
  `scripts/azure_post_build.sh` strips the GUI package if Oryx pulls it in.
- Azure App Service tier **B2 minimum** (MediaPipe/OpenCV need real CPU/RAM).
- Frontend dev runs HTTPS via `@vitejs/plugin-basic-ssl` (mobile camera).
- MySQL **8.0.19+** (the app uses the `AS new` upsert-alias form).

## Migrations

`migrations/02_station_extras.sql` — **pending confirmation** of the
handoff's §6.1 decision. Implements option (a) (a
`movement_screen_result` table keyed to the trial, all values `DECIMAL`
cm) plus `station_tap_log` (Schema A). Apply after the schema choice is
made; run the block for your profile only.

## Tests

```
python scripts/test_validate_uid.py      # UID validation (server contract)
node scripts/test_tap_protocol.mjs       # UID validation (client) + 10-tap invariant
```

## Repo layout

| File | Role |
|---|---|
| `server.py` | FastAPI app, endpoints, station auth |
| `persistence/` | schema-agnostic contract + Schema A/B adapters |
| `pipeline.py` `calibrate.py` `measure.py` `visualize.py` `generate_marker.py` | CV core (carried over unchanged) |
| `src/App.jsx` | screen state machine + tap wiring |
| `src/components/TapCatcher.jsx` | persistent focused input (invariant 1) |
| `src/components/StationSetup.jsx` | once-per-shift station config |
| `src/components/IdleScreen.jsx` | "TAP TO BEGIN" + status + audit trail |
| `src/components/Results.jsx` | CV results, adjust, manual entry, local-first save |
| `src/components/AdditionalInfo.jsx` | assessment fields, same record/trial |
| `src/components/Camera.jsx` `AdjustCanvas.jsx` | carried over unchanged |
| `src/lib/storage.js` | localStorage config + IndexedDB stores |
| `src/lib/sync.js` | background sync queue (retry/backoff) + API client |
| `src/lib/tapProtocol.js` | UID validation (shared) |
| `src/lib/csv.js` | CSV recovery export |
