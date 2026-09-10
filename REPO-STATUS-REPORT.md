# CV Measurement Station — Repository Status Report

*Prepared 2026-09-10 as a scope baseline ahead of the NFC-bracelet V2 rebuild.*

> **Read this first.** This repo currently contains **two overlapping things**:
>
> 1. **The V1 app that is actually deployed and used** — a phone-camera body-measurement
>    station where the operator picks an athlete from a roster. This is what "the app does"
>    today and is the subject of most of this report.
> 2. **An in-progress NFC rebuild already sitting uncommitted in the working tree** on branch
>    `feature/nfc-measurement-rebuild` (rewritten `server.py`, new `persistence/`, new React
>    screens, a 28 KB `HANDOFF-NFC-REBUILD.md`, and a fully rewritten `README.md`).
>    A previous effort has already started the NFC direction. See
>    [§10 In-Progress NFC Rebuild](#10-in-progress-nfc-rebuild-working-tree-only) before you
>    write the V2 PRD — some of what you're about to spec may already be half-built.

---

## 1. What the app does (V1, in production)

It's a **computer-vision measuring station**. An operator (lab/event staff) photographs an
athlete standing in a T-pose next to a printed scale marker, and the app returns three body
measurements from that single photo:

- **Height**
- **Wingspan** (fingertip to fingertip)
- **Hand span** (thumb tip to pinky tip)

It then optionally captures a **second-screen manual assessment** — age, weight, hip
external/internal rotation (L/R), thoracic-spine rotation (L/R), and grip strength (L/R) — and
saves everything to the lab's MySQL database, tied to a specific athlete and event.

The whole thing is designed to run on a **phone in the field** at combines/showcases: the camera
is the phone camera, the UI is a mobile web app, and the CV work happens on a backend server.

---

## 2. Tech stack

| Layer | Technology |
|---|---|
| **Frontend** | React 18 + Vite 5, plain JSX (no TS, no router, no state library — a hand-rolled screen state machine in `App.jsx`) |
| **Frontend hosting** | Vercel (`vercel.json`: `npm run build` → `dist/`) |
| **Backend** | Python 3.11, FastAPI, served by Uvicorn (`Procfile`) |
| **Backend hosting** | Azure App Service (Linux, B2 tier min), CI/CD via GitHub Actions |
| **Computer vision** | MediaPipe 0.10.14 (Pose + Hands models), OpenCV (`opencv-contrib-python-headless` 4.10) for ArUco marker detection, NumPy, Pillow-HEIF (iPhone HEIC support) |
| **Database** | MySQL 8.0.19+ via `mysql-connector-python` |
| **Config** | `python-dotenv` (`.env`) for DB creds |

**Hard stack constraints (don't "upgrade" these blindly):**
- **Python must be 3.11** — MediaPipe does not support 3.12+.
- Must use **headless** OpenCV — Azure Linux has no `libxcb`; `scripts/azure_post_build.sh`
  force-reinstalls the headless wheel because MediaPipe pulls the GUI wheel as a dependency.
- Azure tier **B2 minimum** — MediaPipe/OpenCV need real CPU/RAM.
- Frontend dev server runs **HTTPS** (`@vitejs/plugin-basic-ssl`) because mobile browsers
  require a secure context for camera access.

---

## 3. Architecture & deployment topology

```
   Phone browser (operator)
        │  HTTPS
        ▼
   React SPA on Vercel  ──── /api/* ────▶  FastAPI on Azure App Service (Python 3.11)
                                                │
                                                ├─ MediaPipe Pose + Hands (CV)
                                                ├─ OpenCV ArUco (scale calibration)
                                                └─ mysql-connector ──▶ Lab MySQL DB
```

- The frontend does **no** CV work; it only captures the image and renders results.
- `VITE_API_URL` (build-time env on Vercel) points the SPA at the Azure backend.
- In local dev, Vite proxies `/api` → `http://localhost:8000` (`vite.config.js`).

**CI/CD — two GitHub Actions workflows deploy the backend to the same Azure app
(`cvmeasurements-api`):**
- `.github/workflows/main_cvmeasurements-api.yml` — on push to `main`
- `.github/workflows/azure-deploy_cvmeasurements-api.yml` — on push to `azure-deploy`

Both build with Python 3.11 and let Azure's Oryx run `pip install`. The frontend deploys
separately via Vercel on push.

---

## 4. The CV measurement pipeline (how a photo becomes numbers)

Entry point: `pipeline.run(image_path, marker_cm)` (called by `POST /api/measure`).

1. **Load image** (`pipeline._load_image`) — JPEG/PNG/HEIC (HEIC decoded via Pillow-HEIF for
   iPhone photos).
2. **Scale calibration** (`calibrate.detect_marker`) — finds the printed **ArUco marker**
   (`DICT_5X5_50`, ID 0) and computes **pixels-per-cm** from its known physical size
   (12 / 16 / 20 cm). If no marker is found, the whole request fails with a 422 — the marker is
   the ruler.
3. **Pose** (MediaPipe Pose, `model_complexity=2`) → **height** and **wingspan**:
   - **Height** (`measure.measure_height`): crown-to-lower-heel vertical distance. Crown is
     estimated from the nose landmark using a `HEAD_OFFSET_RATIO = 0.10` fudge factor (nose sits
     ~10% of the nose→heel span below the true crown).
   - **Wingspan** (`measure.measure_wingspan`): fingertip-to-fingertip.
4. **Hands** (MediaPipe Hands) → **hand span** and wingspan refinement:
   - Tries full-image hand detection first; falls back to **cropping + upsampling** each hand
     region (`MIN_HAND_CROP_PX = 400`) when hands are too small in frame.
   - **Hand span** (`measure.measure_hand_width`): thumb tip (landmark 4) → pinky tip (20).
   - If both hands are found, wingspan is **upgraded** to use the middle-fingertip (landmark 12)
     from the Hands model instead of the coarser Pose index landmarks.
5. **Return** measurements in **centimeters**, plus:
   - `endpoints` — pixel coordinates of crown/heel, both wingspan tips, and thumb/pinky, so the
     frontend can render **draggable adjustment handles** over the photo.
   - `debug_image` / `raw_image` — base64 JPEGs (annotated overlay + original).
   - `warnings` — e.g. "No pose detected", "Hand span could not be detected".

**Marker generation** (`generate_marker.py`, served by `/api/marker/{cm}` and `/pdf`): renders
the ArUco marker at exact physical size. The **PDF** encodes the true page size so "print at 100%"
is dimensionally exact — critical, because the marker's printed size is the entire calibration
basis. Sizes: **12, 16, 20 cm**.

Supporting CV modules: `calibrate.py` (marker detection), `visualize.py` (diagnostic overlay),
`measure.py` (the geometry). `pipeline.py` also runs as a CLI for offline testing.

---

## 5. Database — what it touches

**Engine:** the lab's MySQL DB, reached with raw parameterized SQL in `db.py` (V1). Connection
from env vars: `DB_HOST`, `DB_PORT`, `DB_NAME`, `DB_USER`, `DB_PASSWORD`.

The V1 app reads/writes **four tables**:

| Table | Access | Columns used |
|---|---|---|
| `player` | **read** | `CSE_PlayerID`, `FirstName`, `LastName`, `UserID` — athlete search |
| `events` | **read** | `CSE_EventID`, `EventName`, `Date`, `City`, `State` — event search |
| `attendees` | **read** | `userid`, `event_id`, `first_name`, `last_name` — event roster (joined to `player` on `UserID`) |
| `lab_movement_screen` | **read + write** | the measurement record (see below) |

**`lab_movement_screen` is the only table the app writes to.** Operations (`db.py`):

- `get_athlete_status(player_id)` — does this player already have a row, and does it already have
  measurement data? Drives the "existing athlete" UX.
- `upsert_measurement(...)` — **smart save**: if the player has a row, **UPDATE** its
  `height`/`wingspan`/`hand_size` (+ `event_id`, `user_id` via `COALESCE`); otherwise **INSERT**
  a new row with a generated `screen_id` (UUID), `session_date`, `assessment_date`. Returns
  `('inserted' | 'updated', row_id)`.
- `update_additional(row_id, fields)` — second-screen assessment values, whitelisted to:
  `age`, `weight`, `hips_r_hip_er`, `hips_r_hip_ir`, `hips_l_hip_er`, `hips_l_hip_ir`,
  `tspine_tspine_rot_l`, `tspine_tspine_rot_r`, `grip_grip_str_r`, `grip_grip_str_l`.

**Unit-handling quirk worth flagging for V2:** V1 stores **height in cm** (as a string) but
**wingspan and hand_size converted to inches** inside `upsert_measurement`. Units are inconsistent
across columns. (The in-progress NFC rebuild deliberately moves to all-centimeter `DECIMAL`
storage — see §10.)

**Identity model (V1):** every saved record is tied to a real athlete identity —
`cse_player_id`, `first_name`, `last_name` all land in the row. This is precisely what the NFC
rebuild is trying to remove from the capture path.

---

## 6. How employees (operators) interact with it

V1 is a linear, single-operator screen flow (`src/App.jsx` state machine → components):

1. **Instructions** (`Instructions.jsx`) — how to set up the shot (T-pose, marker at wrist
   height, camera at chest height, full body in frame).
2. **Athlete Select / Setup** (`AthleteSelect.jsx`) — the operator:
   - picks a **marker size** (12/16/20) and can **print the marker PDF** on the spot,
   - **searches an event** (type-ahead → `/api/events`), selects it, loads its **roster**
     (`/api/events/{id}/roster`),
   - **picks the athlete** from the roster; the app checks that athlete's status
     (`/api/athletes/{id}/status`) so it knows whether this is a new or repeat measurement.
3. **Camera** (`Camera.jsx`) — live phone camera; capture a photo → `POST /api/measure`.
4. **Results** (`Results.jsx`) — shows the annotated photo with the three measurements. The
   operator can:
   - **Adjust the lines** (`AdjustCanvas.jsx`) — drag the crown/heel/fingertip/hand handles to
     correct the CV, which recomputes values against the known `px_per_cm`,
   - **retry** the photo,
   - **save** → `POST /api/save` (the smart upsert),
   - continue to additional info.
5. **Additional Info** (`AdditionalInfo.jsx`) — the manual assessment fields → `POST
   /api/save_additional`, written to the same `lab_movement_screen` row. On done, it loops back to
   the athlete list **with the same event/roster preserved** so the operator can run the next
   athlete quickly.

Branding: `BrandBar.jsx` + CSE / Triple Crown logos in `src/assets/`. UI conventions are
documented in `UI_STYLE_GUIDE.md` and `UI_STYLE_GUIDE_V2.md`.

There is **no operator authentication** in V1 — anyone with the URL can use it and write to the DB.
(The NFC rebuild adds a static `X-Station-Token`.)

---

## 7. API surface (V1, `server.py` at HEAD)

| Endpoint | Method | Purpose |
|---|---|---|
| `/api/athletes?q=` | GET | Search players by name |
| `/api/events?q=` | GET | Search events by name |
| `/api/events/{event_id}/roster` | GET | Athletes attending an event |
| `/api/athletes/{player_id}/status` | GET | Whether player has a row / existing data |
| `/api/save` | POST | Smart upsert of the 3 measurements |
| `/api/save_additional` | POST | Second-screen assessment fields |
| `/api/measure` | POST | image + `marker_cm` → measurements + annotated image |
| `/api/marker/{cm}` · `/api/marker/{cm}/pdf` | GET | Printable scale marker |

CORS is wide open (`allow_origins=["*"]`). No auth. All identity/roster endpoints
(`/api/athletes`, `/api/events`, roster, status, save, save_additional) are exactly the ones the
NFC rebuild removes.

---

## 8. Environment & configuration

```
# Backend (.env / Azure App Service settings)
DB_HOST=          DB_PORT=3306      DB_NAME=
DB_USER=          DB_PASSWORD=

# Frontend (Vercel build env)
VITE_API_URL=     # base URL of the Azure backend
```

Secrets in play: the Azure DB credentials (backend) and the Azure service-principal secrets used
by the GitHub Actions deploy workflows. Nothing is committed — `.env`, `node_modules`, `dist`,
`__pycache__`, `marker/`, and `samples/*` are gitignored.

---

## 9. Repo layout (V1 core)

| Path | Role |
|---|---|
| `server.py` | FastAPI app + endpoints |
| `db.py` | All MySQL access (V1) — **deleted in the working tree by the rebuild** |
| `pipeline.py` | CV orchestration (photo → measurements) |
| `calibrate.py` | ArUco marker detection / px-per-cm |
| `measure.py` | Height / wingspan / hand-span geometry |
| `visualize.py` | Diagnostic overlay drawing |
| `generate_marker.py` | Printable marker PNG/PDF |
| `src/App.jsx` | Screen state machine |
| `src/components/*` | `Instructions`, `AthleteSelect`, `Camera`, `AdjustCanvas`, `Results`, `AdditionalInfo`, `BrandBar` |
| `.github/workflows/*` | Azure backend CI/CD |
| `Procfile`, `vercel.json`, `vite.config.js`, `requirements.txt`, `package.json` | Build/deploy config |

---

## 10. In-progress NFC rebuild (working tree only)

**This is not yet committed** — it lives as uncommitted changes on
`feature/nfc-measurement-rebuild`. It's a partial implementation of the exact idea you're about to
write a PRD for, so review it before you spec V2. Source of truth: **`HANDOFF-NFC-REBUILD.md`**
(28 KB) and the rewritten `README.md`.

**What's already changed / added in the working tree:**

- **Identity removed from the capture path.** `db.py` is deleted; a new schema-agnostic
  `persistence/` layer replaces it (`base.py` contract + `schema_a.py` / `schema_b.py` adapters,
  selected by a `SCHEMA_PROFILE` env var). The subject key is a **tag UID only** — never a name,
  never a roster lookup.
- **`server.py` fully rewritten** to a new API: `/api/subject/resolve` (UID → opaque handle +
  `enrolled` flag), `/api/capture/save`, `/api/scan/log`, `/api/station/bootstrap`, `/api/health`,
  plus a static `X-Station-Token` station auth. The old athletes/events/roster/save endpoints are
  gone. `/api/measure` and `/api/marker` carry over unchanged.
- **New React screens** (referenced by the new README, present as `??` untracked files):
  `TapCatcher.jsx` (a permanently-focused hidden input that catches NFC-reader keystrokes),
  `StationSetup.jsx` (once-per-shift config), `IdleScreen.jsx` ("TAP TO BEGIN"), plus a
  `src/lib/` with `storage.js` (IndexedDB), `sync.js` (background sync w/ retry), `tapProtocol.js`,
  and `csv.js` (offline recovery export). `AthleteSelect.jsx` is deleted.
- **Hardware model:** the NFC bracelet reader is treated as a **USB HID keyboard** that types the
  tag's hex UID and presses Enter. UID validation: 8–20 uppercase hex chars, even length.
- **New data model direction:** all measurements stored as **`DECIMAL` centimeters** (ft/in is
  display-only); **every save is a new trial** (no more overwriting repeat visits); a `migrations/`
  folder holds pending SQL (`02_station_extras.sql`) that is **explicitly awaiting a schema
  decision** (§6.1 of the handoff).
- **Local-first sync:** saves hit IndexedDB immediately and sync in the background, so a station
  keeps working through a network outage.

**Open decisions the handoff flags (relevant to your PRD):**
- **Which lab schema** the persistence layer targets — Schema A (`new_lab_pipeline`) vs Schema B
  (`cse_db_v2_dev`) — is called out as a *human decision* that's **not yet made**.
- `migrations/02_station_extras.sql` is **pending confirmation** and should not be applied until
  the schema is chosen.

---

## 11. Things to weigh for the V2 PRD

- **Reconcile with the in-progress rebuild.** Decide whether V2 builds on the uncommitted NFC work
  (and gets it committed/reviewed) or starts clean. Right now that work is unmerged and undecided
  in places.
- **Schema decision is the critical-path blocker** — Schema A vs B gates the migration and the
  persistence adapter.
- **Enrollment / UID → athlete mapping.** V1 got identity from the roster; the NFC model
  deliberately keeps identity out of the station. Where and how a bracelet UID becomes a known
  athlete (enrollment, and later re-association of anonymized trials) is the biggest new design
  question and isn't fully resolved in the handoff.
- **Unit consistency.** V1's mixed cm/inch storage should be settled deliberately in V2 (the
  rebuild's all-cm `DECIMAL` approach is the cleaner target).
- **The CV core is stable and reusable.** `pipeline.py` / `calibrate.py` / `measure.py` /
  `generate_marker.py` and the marker/measure endpoints are identity-free already and carry over
  unchanged — V2 is really a rework of *identity, persistence, auth, and operator flow*, not of the
  measurement engine.

---

*Sources: committed HEAD (`e2f1ec1`) for the V1 baseline; working-tree changes and
`HANDOFF-NFC-REBUILD.md` for the in-progress rebuild.*
