# CV Measurement Station (NFC rebuild)

Measures an athlete's height, wingspan, and hand span from a single T-pose photo against a wall with a printed ArUco marker. A second screen collects manual assessment data (age, weight, hip ER/IR, t-spine rotation, grip strength). The NFC rebuild replaces the old "pick a named player from an event roster" flow with a bracelet tap, so the station never sees who the athlete is.

| | |
|---|---|
| Repo | `cseval/CSE_cvmeasurements` (`cvmeasurement`) |
| Local folder | `Lab Projects\apps\CSE_cvmeasurement` |
| Old worktree (archived) | `Lab Projects\_archive\cv-measurement-nfc-rebuild-worktree` |
| Deployed branch | `main` (branch B work merged) |
| Superseded branch | `feature/nfc-measurement-rebuild` (branch A, adapter approach), to archive as `archive/nfc-rebuild-adapter-approach` |
| Frontend | React 18 + Vite 5 on Vercel |
| Backend | FastAPI + MediaPipe + OpenCV, Python 3.11, Azure App Service (`cvmeasurements-api`) |
| Database | `new_lab_pipeline` (account `cse_integration`). Must never write to production `cse_db` |
| Station hardware | iPad + USB-C HID reader, portrait UI |

## Status (updated 2026-11-04)

- Rebuild committed, pushed and deployed. Cutover 2026-10-21; API deploys from `main`.
- Not currently in use at events.
- **API currently unauthenticated** (`STATION_API_KEYS` empty). Being replaced with the shared PIN login; see OPEN_ITEMS.

## Related docs

`ARCHITECTURE.md`, `RUNBOOK.md`, `DECISIONS.md`, `OPEN_ITEMS.md`. Database: `new_lab_pipeline/documentation/`.
