# CV Measurement: Decision Log

| Date | # | Decision |
|---|---|---|
| 2026-08 | | Full rebuild, NFC-native, not a patch. CV core (`pipeline`, `calibrate`, `measure`, `visualize`, `generate_marker`, `/api/measure`, Camera, Results, AdjustCanvas, Enter Manually, Test Mode) carried over intact |
| 2026-09-10 | 1 | Schema is the hybrid: Schema A base plus opaque `subject_token`, `subject_tag_binding`, `scan_event`, `station_source` from Schema B. Schema B (`cse_db_v2`) lost |
| 2026-09-10 | 2 | Measurements go in a new anonymous `lab_movement_screen` in `new_lab_pipeline`, keyed to `capture_trial_id`, DECIMAL cm |
| 2026-09-10 | 3 | Station hardware: iPad + USB-C HID reader, portrait UI |
| 2026-09-10 / 09-14 | 4 | Photos kept via `file_artifact` with `purge_after`, moving to a private Blob container |
| 2026-09-10 | | Keep branch B (committed to the hybrid); take three things from A (offline tap fix, tap buffer handling, audit-log-before-captures on sync); archive A |
| 2026-09-14 | 5 -> 6 | Printed claim card deferred to V2. V1 is bracelet only |
| 2026-09-14 | 7 | Nobody identified at the event. Athletes bind later via the CSE Bracelet Binder. Athletes keep their bands |
| 2026-09-14 | 8 | UID is the only V1 credential (known gap). Mitigations: no photos on bind, 72h `bindable_until`, height knowledge check, reversible claims, rate limiting, multi-band detection |
| 2026-10-01 | | API uses `cse_integration` |
| 2026-10-20 | | Calendar dates lab-local (`LAB_TIMEZONE`), instants UTC; station sends `captured_at` so late syncs are dated correctly |
| planned | | Shared desk/admin PIN login with check-in |
