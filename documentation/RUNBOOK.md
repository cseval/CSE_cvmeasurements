# CV Measurement: Runbook

## Environment

Backend (App Service settings / `.env`):

| Variable | Notes |
|---|---|
| `DB_HOST`, `DB_PORT` (3306), `DB_NAME=new_lab_pipeline`, `DB_USER`, `DB_PASSWORD` | `DB_USER` is recorded here as `cse_integration` but has not been read back from the App Service, and it is not cosmetic: `DB_PASSWORD` is part of the session signing key, so whether CV and check-in share an account decides whether one sign-in covers both apps. See OPEN_ITEMS |
| `STATION_CODE=cv_app` | must exist in `station_source` |
| `DESK_PIN`, `ADMIN_PIN` | the shared 6-digit PIN login, same two numbers as the check-in desk. Must differ from each other. No separate signing secret exists: tokens are signed from both PINs plus `DB_PASSWORD`, so changing either PIN — or rotating the database password — signs every device out |
| `AUTH_ENFORCE` | **the switch that actually closes the API.** While unset or false, requests with no session are still accepted; that is the rollout grace window, not the finished state. See `PIN-LOGIN-ROLLOUT.md` |
| `LOGIN_*` | brute-force guard thresholds; the defaults in `login_guard.py` are fine |
| `STATION_API_KEYS` | transitional, retired at rollout step 6. Has always been empty in production |
| `ALLOWED_ORIGINS` | CORS. Empty falls back to `*` |
| `ARTIFACT_AZURE_CONTAINER` | private Blob container for photos |
| `PHOTO_RETENTION_DAYS` | 365 is a placeholder pending legal review |
| `LAB_TIMEZONE` | default `America/Denver` |

Frontend (Vercel): `VITE_API_URL`. The code calls `${VITE_API_URL}/api/...`; there is no rewrite in `vercel.json`. Trust the code over the old README.

## Stack constraints

- Python **3.11**. MediaPipe does not support 3.12+.
- `opencv-contrib-python-headless`, never the GUI wheel (Azure Linux has no `libxcb`). `scripts/azure_post_build.sh` strips the GUI package if Oryx pulls it in.
- App Service tier **B2 minimum**. Free/Shared hits `QuotaExceeded`.
- `tzdata` pinned in requirements.
- Frontend dev runs HTTPS via `@vitejs/plugin-basic-ssl`; mobile camera needs it.

## Marker and photo setup

- Sizes 12 / 16 / 20 cm, served as PDF (PDF page size is the physical size). Print at "Actual size."
- Tape flat on the wall at wrist height, same plane as the athlete.
- Athlete back near the wall, arms straight out at shoulder height, palms to camera, fingers together. Camera at chest height, full body in frame. Even lighting; shadows on hands are the main cause of hand-span failure.
- A wrong marker size scales every value wrong with no warning. The selected size is shown persistently on the capture screen.

## Acceptance

Ten taps, no screen touches between, all ten register.

## Tests

Branch B reported 16 + 51 + 29 tests (2026-09-10). `tests/test_lab_time.py` needs no DB and covers both DST transitions. Constraint suite check counts disagree across docs; reconcile against an actual run.
