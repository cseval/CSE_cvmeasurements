# CV Measurement: Open Items

*Updated 2026-11-06*

## Done
- [x] Branch B committed and pushed; `AthleteSelect.jsx` removed.
- [x] Rebuilt backend deployed to App Service, frontend to Vercel (cutover 2026-10-21, API deploys from `main`).
- [x] `sport` / `movement` fix in `_get_or_create_session`.
- [x] `bindable_until`: no longer applicable to CV. Check-in stamps it; CV code no longer references it.

## Security (high priority)
- [ ] **API is still open until `AUTH_ENFORCE=true` is set.** The PIN login is built and merged-ready on `feature/pin-login`, but it is deliberately not *required* until that one App Service variable is set — that is what lets the backend ship without breaking the live frontend. Until then every endpoint still accepts anonymous requests, as it has since 2026-10-21. `/api/health` reports `auth_enforced`, and the station setup screen shows a warning the whole time it is false. **Follow `PIN-LOGIN-ROLLOUT.md`; the open state ends at step 4.**
- [x] **Static station key replaced.** `VITE_STATION_KEY` is gone from the bundle. The shared desk/admin PIN login from check-in is in, built on the on-screen keypad (the NFC reader suppresses the iOS software keyboard, so an `<input>` would be unusable). `STATION_API_KEYS` is still accepted during the rollout and is removed at step 6.
- [x] **PIN brute-force guard** (2026-11-06). The inherited 2026-09-30 decision was unlimited attempts and no lockout, written for an app that was not exposed. A 6-digit PIN is a million guesses on a public URL. `login_guard.py` adds a delay, a per-address lockout, and a global failure rate so rotating `X-Forwarded-For` does not dodge it. Shared verbatim with check-in (`feature/pin-login-guard` there).
- [ ] **Verify which database account the App Service uses.** The session signing key includes `DB_PASSWORD`, so if CV and check-in share an account, a token from one app works in the other; if not, each app needs its own sign-in. RUNBOOK below records `cse_integration`, which would mean they are shared — but that has not been read back from the App Service. One is not better than the other; it just needs to be known before anyone describes this as single sign-on.
- [ ] `ALLOWED_ORIGINS` may still be empty on App Service (CORS falls back to `*`). Rollout step 1 item 6.
- [ ] Repo `cseval/CSE_cvmeasurements` is public. Decide whether to make it private. More pressing now that `login_guard.py`'s thresholds are readable.

## Housekeeping
- [x] (2026-11-04) Archive branch A: rename `feature/nfc-measurement-rebuild` to `archive/nfc-rebuild-adapter-approach` and push.

## Code changes owed
- [x] **Reconcile the local-first queue with the PIN session** (2026-11-06). Three things were wrong once sessions expire: a 401 counted as a permanent 4xx and stalled every queued capture on its first retry; the photo phase swallowed a 401, marked the record synced and dropped the blobs, destroying the only copy; and `flush()` ran on its timer while logged out, burning the retry budget of good records. A rejected session now consumes no attempt, parks nothing, and drops no photo. 15 tests in `tests/queue-session`, mutation-checked.
- [ ] Remove the rollout scaffolding once `AUTH_ENFORCE=true` has been stable: the grace branch in `require_session`, `STATION_API_KEYS`, and the `X-Station-Key` CORS header. Rollout step 6.

## Unbuilt downstream
- CSE Bracelet Binder.
- Reconciliation job into production `cse_db.lab_movement_screen`.
- Photo purge job (reads `purge_after`).
- Photos: **not stored for now (decided 2026-11-04).** Keep the per-session photo toggle off. Blob deferred; without it, photos would land on App Service disk, which is wiped on redeploy.

## Needs a human / legal
- Photo retention window (`PHOTO_RETENTION_DAYS=365` placeholder) and unclaimed-token shelf life.
- Guardian consent point.
- Where the athlete-facing view lives (TC Locker or the Binder).
