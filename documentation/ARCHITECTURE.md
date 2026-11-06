# CV Measurement: Architecture

## Shape

```
iPad (portrait) + USB-C HID reader
   React/Vite (Vercel) -- HTTPS --> FastAPI + MediaPipe + OpenCV (Azure App Service, Python 3.11)
                                          |
                                          v
                                 new_lab_pipeline (cse_integration)
                                 Azure Blob (private container) for photos
```

The frontend does no CV work. Each capture is a multipart POST of a JPEG; MediaPipe runs server-side.

## Operator flow

```
Station setup (once per shift)  marker size, event session, station, operator; persisted locally
  -> Idle "TAP TO BEGIN"         hidden input always focused
  -> tap                         UID -> anonymous_capture_subject (created if new); non-identifying confirmation
  -> Camera                      live camera or photo library; optional 5s countdown
  -> Results                     annotated photo, three cards, Adjust Lines, Enter Manually, Save
  -> AdditionalInfo              age/weight/hips/t-spine/grip on the same trial
  -> back to idle                no roster
```

Test Mode measures with no subject attached, for checking marker prints and camera position without polluting data.

## Endpoints

`/api/health`, `/api/stations`, `/api/event-sessions`, `/api/subject/resolve`, `/api/capture/save`, `/api/capture/additional`, `/api/capture/photo`, `/api/station/audit`, `/api/measure`, `/api/marker/{cm}[/pdf]`.

Removed in the rebuild: `/api/events`, `/api/events/{id}/roster`, `/api/athletes`, `/api/athletes/{player_id}/status`, `AthleteSelect.jsx`, and every read of production `player`, `events`, `attendees`.

## Tables

Written or read by `db.py`: `station_source`, `event_session`, `nfc_tag`, `anonymous_capture_subject`, `subject_tag_binding`, `capture_session`, `capture_trial`, `scan_event`, `lab_movement_screen`, `file_artifact`, plus reads of `nfc_tag_assignment` / `athlete` for the `enrolled` flag.

Does not touch `station_tap_log`, `entity_crosswalk`, `source_import_batch`.

- `capture_trial.trial_type = 'movement_screen'`.
- `new_lab_pipeline.lab_movement_screen` is anonymous, keyed to `capture_trial_id`, all linear values DECIMAL cm. It shares a name with the identity-native `cse_db.lab_movement_screen`, which stays untouched. Always qualify the database name.
- Every save creates a new trial. A second visit never overwrites the first.

## File map

| File | Role |
|---|---|
| `server.py` | FastAPI app and endpoints |
| `db.py` | Queries; `_lab_date`, `_lab_day_bounds_utc`, `_coerce_captured_at` |
| `pipeline.py` | `run(image_path, debug, marker_cm)`, full CV flow, also a CLI |
| `calibrate.py` | ArUco detection -> `px_per_cm` |
| `measure.py` | Height / wingspan / hand math from landmarks |
| `visualize.py` | Annotated overlay |
| `generate_marker.py` | Marker PNG/PDF |
| `nfc.py`, `tokens.py`, `artifacts.py` | Rebuild: tap handling, subject tokens, photo storage |
| `src/App.jsx` | Screen state machine |
| `src/components/StationSetup.jsx`, `StationAudit.jsx` | Rebuild: station config, tap audit |
| `Camera.jsx`, `Results.jsx`, `AdjustCanvas.jsx`, `AdditionalInfo.jsx`, `BrandBar.jsx`, `Instructions.jsx` | Carried over |

## Tap capture

- Reader types the UID as uppercase hex, no separators, then Enter.
- Validate `^[0-9A-F]{8,20}$`, even length (plus `PREFIX` if configured). Never hard-code 14; 8-char tags exist.
- Re-focus after every submit, screen change and modal dismiss.
- Every tap logged to `scan_event`, resolved or not. An unenrolled tap still captures and is surfaced for reconciliation.
- Same UID minutes later is a legitimate second trial.

## Photos

Kept, stored via `file_artifact` with `purge_after`, moving to a private Azure Blob container (`ARTIFACT_AZURE_CONTAINER`). Per-session toggle. Never exposed through the Binder.
