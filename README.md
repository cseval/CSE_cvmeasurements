# CV Measurement Station — NFC-native

> **Current contract update — 2026-09-14+ cleanup:** CV Measurement is now
> **read-only** for bracelet/subject setup. It must not create `nfc_tag`,
> `anonymous_capture_subject`, or `subject_tag_binding` on first sight of a UID.
> Check-in, Binder, or pre-event provisioning owns those rows. Unknown UID / no
> active binding at CV returns `ok: false`, writes an unresolved `scan_event`
> when possible, and creates no setup rows. See
> `../../docs/prd/new-lab-pipeline-schema-decisions.md`.

Measures an athlete's **height**, **wingspan** and **hand span** from a single
T-pose photo, and attaches the result to whoever tapped a bracelet on the
reader — without ever learning who that is.

This is a rebuild, not a patch. The previous version was built entirely around
picking a named human out of an event roster, which is backwards from where
the rest of the lab is going.

---

## The idea in one sentence

> Athlete identity is resolved exactly once, downstream, and never touches the
> capture layer.

Every station in the lab stops asking "who is this person?" and starts asking
"which tag is this?" The athlete taps. The reader types the tag's UID. That
tag is the only subject key this app ever sees. Names, `cse_player_id`, emails
and DOBs are joined in later, once, through the identity-layer binding contract
(`subject_identity_binding` in the current V1 database contract).

The operator running this station never sees a name, because the app does not
have one and is not allowed to ask.

---

## Decisions that were open, and how they landed

The handoff document left four blocking decisions. All four are settled:

| Decision | Resolution |
|---|---|
| **Which schema** | **Hybrid.** Schema A's three layers and `capture_trial.trial_type` as the base — that is what the V1 diagram and the validation protocol's acceptance queries are written against. Pulled forward from Schema B: an opaque subject token, a physical-medium binding table, an every-tap scan log, and a constrained station lookup. |
| **Where measurements go** | A **new** `lab_movement_screen` table inside `new_lab_pipeline`, keyed to `capture_trial_id`, no identity column. |
| **Station hardware** | **iPad + USB-C reader.** The UI is laid out for portrait at ~810px with large touch targets. |
| **Photos** | **Kept**, wired to `file_artifact`, with a `purge_after` date stamped at write time and a per-session toggle in setup. |

### ⚠ On the name `lab_movement_screen`

There are now **two different tables with this name in two different
databases**:

- `cse_db.lab_movement_screen` — production, identity-native, carries
  `cse_player_id`, `first_name`, `last_name`. Untouched by this app.
- `new_lab_pipeline.lab_movement_screen` — **new**, anonymous, keyed to
  `capture_trial_id`.

They are not the same table and must never be joined as if they were. Qualify
the database name in any query that could reach both.

### The hybrid's one real departure from the PDR

Schema A puts `nfc_tag_id` directly on `anonymous_capture_subject`, and says
`subject_token` is "usually equal to `nfc_tag.tag_uid`". Taken literally, that
makes the subject *be* the physical bracelet — so replacing a lost bracelet
creates a brand new subject and the athlete's capture history splits in two,
with nothing in the data saying they are the same person.

So:

- `subject_token` is **generated**, opaque, `TC-XXXX-XXXX` over a 30-character
  ambiguity-free alphabet. Never the UID.
- `anonymous_capture_subject.nfc_tag_id` is **replaced** by
  `subject_tag_binding`, which binds a physical medium to a durable subject
  with the same one-active-row constraints as `nfc_tag_assignment`.

A replacement bracelet is an unbind and a rebind. Every `capture_session`
already pointing at that subject stays correct. `sql/02_verify_constraints.sql`
tests this explicitly.

**This changes two acceptance queries** in
`claude/nfc-station-validation-protocol.html`, which join
`nfc_tag ON nt.id = acs.nfc_tag_id`. They now need to go through
`subject_tag_binding` — see "Updated acceptance queries" below.

### `scan_event` and `station_tap_log` are not the same table

Both exist in the schema. They do different jobs and collapsing them ships a
table missing the column three of five stations join on.

- **`scan_event`** — audit log of every tap at an **open** station, keyed on
  `raw_scan_value` / `resolved` / binding. This app writes it. No `tap_round`,
  no window-join role.
- **`station_tap_log`** — `station_id`, `bracelet_uid`, `tapped_at`,
  `tap_round`. Exists so **closed** systems with no injection point (Rapsodo,
  TrackMan, Blast) can be joined on a timestamp window. This app does **not**
  write it, because it has a real injection point and creates its trial
  directly.

---

## Operator flow

```
Station setup (once per shift)
    marker size · station · operator · lab · event session · keep photos?
  ↓
"TAP TO BEGIN"                 hidden focused input, waiting for HID keystrokes
  ↓  athlete taps → reader types hex + Enter
Subject resolved               opaque token shown, plus a bound/unbound flag
  ↓
Camera                         marker size shown persistently
  ↓
Results                        annotated photo · Adjust Lines · Enter Manually
  ↓  Save → writes to IndexedDB and returns immediately
Additional Info                age/weight/hips/t-spine/grip
  ↓
back to idle                   no roster to return to — there is no roster
```

---

## The five invariants

These are inherited from the check-in station build, where they were learned
the expensive way. Each one has a test.

1. **Re-focus the input after every submit, transition and modal dismiss.**
   The reader is a keyboard; if focus is lost the next tap goes nowhere and
   presents to staff as a hardware failure. Documented as the #1 integration
   bug across the whole NFC effort. → `tests/test_tap_focus.py`, including the
   handoff's own acceptance test: ten taps, no screen touches, all ten
   register.
2. **Write locally first, sync second.** Save writes to IndexedDB and returns.
   A background worker drains the queue with backoff. The header shows a
   pending count, and the audit screen exports a CSV so a whole shift is
   recoverable from the device. → `src/lib/queue.js`
3. **No identity in the capture path.** Not in a request body, a response, a
   log line, a localStorage key, or a filename. → asserted in both test files.
4. **A tap is an identifier, not a credential.** A UID is readable by anyone
   with a phone and clonable in seconds. Fine for attaching a measurement.
   Never proof of who someone is.
5. **A missing tap fails loudly and stays recoverable.** A tap arriving
   mid-measurement is *held and surfaced*, never silently applied — a trial
   must never be attributed to the previous athlete.

---

## What changed from the old build

**Deleted**

- `src/components/AthleteSelect.jsx` is no longer imported by anything. It is
  the last file in the tree that reads named athletes, so it has been removed
  from the worktree.

**Deleted**

- `GET /api/events`, `GET /api/events/{id}/roster`, `GET /api/athletes`,
  `GET /api/athletes/{player_id}/status`, `POST /api/save`,
  `POST /api/save_additional`
- Every read of production `player`, `events` and `attendees`

**Fixed while rebuilding** — all eight of the known problems in the handoff:

| # | Problem | Fix |
|---|---|---|
| 1 | Second visit overwrote the first | Every save creates a **new** `capture_trial`. Longitudinal history works. |
| 2 | Names denormalized into the measurement row | No identity column exists to write to. |
| 3 | Lossy unit mixing (height as a string in cm, wingspan rounded to a whole inch) | All `DECIMAL` centimetres. Converted to ft/in at render only. |
| 4 | Zero auth, CORS `*` | `X-Station-Key` on every endpoint, `ALLOWED_ORIGINS` on CORS. |
| 5 | `marker_cm` client-supplied and unvalidated | Validated against published sizes server-side, shown persistently on the capture screen, and stored with `px_per_cm` so a bad shift can be rescaled rather than remeasured. Implausible values raise a `scale_warning`. |
| 6 | Fully online | Local-first queue with retry and CSV export. |
| 7 | README stale on deployment | This file. The code calls `${VITE_API_URL}/api/...`; there is no Vercel rewrite. |
| 8 | `GET /api/athletes` orphaned | Gone. |

**Kept close to intact** — the CV core is good: `pipeline.py`, `calibrate.py`,
`measure.py`, `visualize.py`, `generate_marker.py`, `POST /api/measure`,
`Camera.jsx`, `AdjustCanvas.jsx`, the Results presentation, Enter Manually,
and Test Mode.

---

## API

| Endpoint | Purpose |
|---|---|
| `GET /api/health` | DB reachable, auth on, artifact backend. Unauthenticated on purpose. |
| `POST /api/subject/resolve` | A tap in, an existing anonymous subject out. Read-only for tag/subject/binding setup. Unknown UID or missing active binding returns `ok: false` and creates no setup rows. Returns no identity, ever. |
| `POST /api/capture/save` | New `capture_session` (or today's) + `capture_trial` + `lab_movement_screen`. Idempotent on `client_ref`. |
| `POST /api/capture/additional` | Assessment fields onto an existing result row. |
| `POST /api/capture/photo` | Photo → `file_artifact`. Separate from save so a photo failure never costs a measurement. |
| `GET /api/station/audit` | Taps that produced no data, unenrolled taps, malformed scans. |
| `GET /api/stations`, `GET /api/event-sessions` | Station setup pickers. |
| `POST /api/measure` | Unchanged CV path. Now validates `marker_cm`. |
| `GET /api/marker/{cm}`, `/pdf` | Printable marker. |

---

## Running it

### Database

```bash
# Historical hybrid baseline only. The live V1 test schema has additional
# app-contract tables and decisions recorded in ../../docs/prd/.
mysql -h "$DB_HOST" -u "$DB_USER" -p < sql/01_create_new_lab_pipeline_hybrid.sql
mysql -h "$DB_HOST" -u "$DB_USER" -p new_lab_pipeline < sql/02_verify_constraints.sql
```

The second one prints PASS/FAIL per check. **Any FAIL means the schema is not
enforcing something the app assumes**, and the app will happily write data that
cannot be resolved later. Run it against a scratch copy — it creates and
removes its own fixtures.

### Backend

```bash
cp .env.example .env      # fill it in
pip install -r requirements.txt
uvicorn server:app --reload --port 8000
```

Python **3.11** — MediaPipe does not support 3.12+. Use
`opencv-contrib-python-headless`, never the GUI wheel (Azure Linux has no
`libxcb`); `scripts/azure_post_build.sh` strips it if Oryx pulls it in. App
Service tier **B2 minimum**: MediaPipe and OpenCV need real CPU and RAM, and
free/shared hits `QuotaExceeded`.

### Frontend

```bash
npm install
npm run dev      # HTTPS via basic-ssl; mobile camera access requires it
npm run build
```

```
VITE_API_URL=https://your-api.azurewebsites.net
VITE_STATION_KEY=<one of STATION_API_KEYS>
```

`VITE_STATION_KEY` is baked into the bundle, so it is not a secret from anyone
holding the iPad. It is a gate against the open internet, which is a strict
improvement on having none.

### Tests

```bash
# Schema constraints — 16 checks
mysql ... new_lab_pipeline < sql/02_verify_constraints.sql

# Capture path against a real database — 41 checks
DB_HOST=... DB_USER=... DB_PASSWORD=... python tests/test_capture_flow.py

# Tap capture and the focus invariant, in a real browser — 23 checks
npm run build && python tests/test_tap_focus.py
```

---

## The reader

Waveshare RP2040-Zero + PN532 over I²C, CircuitPython
(`planning-docs/hardware/code.py`). On tag detection it types the UID as
uppercase hex with no separators and presses Enter. Settings that matter here:

- `COOLDOWN = 3.0` — the same tag cannot re-fire within 3 seconds
- `SEND_ENTER = True` — the form submits itself
- `PREFIX = ""` — must match `NFC_PREFIX` on the server

Beeps: one long = accepted, two short = same tag still cooling down, three
short = read or type failed.

### UID length is not fixed — nothing hard-codes it

The firmware formats whatever the tag returns. A 7-byte NTAG21x UID is 14 hex
characters; a 4-byte Mifare-family UID is 8. Both are in circulation at the
lab: every bracelet in `planning-docs/NFC Bracelet IDs.xlsx` is 14 characters
beginning `04` (the NXP manufacturer byte, consistent with NTAG21x), and two
of the cards in that sheet are 8.

Validation is `^[0-9A-F]{8,20}$` with an even length. `nfc_tag.tag_uid` is
`VARCHAR(32)`. The observed family is recorded per tag in `nfc_tag.chip_type`
at first sight, as an observation to correct during station validation — not
as an assumption in code.

### iPad and the on-screen keyboard

iOS suppresses the software keyboard whenever a hardware keyboard is
connected, so focusing the tap catcher with the reader plugged in shows
nothing. **Unplugged — which is how you will test on a desk — the keyboard
does appear.** Treat that as a sign the reader is not connected, not as a UI
bug.

---

## Photo setup that produces good measurements

Back near the wall, arms fully extended horizontally at shoulder height, palms
to camera, fingers together. Camera at chest height, full body in frame. Even
lighting — shadows on the hands are the main cause of hand-span detection
failure.

Markers print at 12 / 16 / 20 cm, served as PDF because a PDF's page size *is*
the physical size; printing HTML at a CSS size is not reliable across printer
drivers. Print at **Actual size**, not Fit to page. Tape flat on the wall at
wrist height, in the same plane as the athlete.

---

## Updated acceptance queries

The validation protocol's Q1 and Q2 join `nfc_tag ON nt.id = acs.nfc_tag_id`.
That column no longer exists. Route through `subject_tag_binding`, and make
the binding join time-bounded the same way the assignment join already is —
otherwise a trial captured before a bracelet was reissued resolves through the
*current* binding rather than the one that was active at the time:

```sql
FROM capture_trial ct
LEFT JOIN capture_session cs
       ON cs.id = ct.capture_session_id
LEFT JOIN anonymous_capture_subject acs
       ON acs.id = cs.anonymous_capture_subject_id
LEFT JOIN subject_tag_binding stb
       ON stb.anonymous_capture_subject_id = acs.id
      AND ct.trial_timestamp >= stb.active_from
      AND (stb.active_to IS NULL OR ct.trial_timestamp < stb.active_to)
LEFT JOIN nfc_tag nt
       ON nt.id = stb.nfc_tag_id
LEFT JOIN subject_identity_binding sib
       ON sib.anonymous_capture_subject_id = acs.id
      AND sib.nfc_tag_id = nt.id
      AND sib.status = 'active'
LEFT JOIN athlete a
       ON a.id = sib.athlete_id
```

Two other identifier notes for that document: the trial's time column is
`trial_timestamp`, not `started_at`; the trial's kind is `trial_type`, not
`modality`; and `capture_trial` reaches a subject through `capture_session`,
not through a direct `subject_id`.

---

## Still open

- **Bracelet setup ownership.** Bracelet/subject setup happens through
  pre-provisioning, Check-in, or Binder — never here. This app treats an
  unknown/unprovisioned UID as a setup error: unresolved `scan_event`, `ok:false`,
  no capture rows, and no setup rows created.
- **Photo retention window.** `PHOTO_RETENTION_DAYS` defaults to 365 and the
  server warns when it is unset. That default is a placeholder, not a legal
  determination — the guardian-consent and biometric-statute review is the
  long-lead item that should set it.
- **Chip family.** Bracelets read as 7-byte UIDs, consistent with NTAG21x.
  Confirm the part number during station validation and correct
  `nfc_tag.chip_type`.
- **Blob storage.** Photos default to App Service local disk, which does not
  survive a redeploy or a scale-out. Set the Azure variables before this
  carries real sessions.
- **Archive the losing schema.** `sql/01_create_cse_v2_schema.sql` in
  `planning-docs` is now superseded by the hybrid. Delete or clearly archive it
  so the next person does not hit the same fork.
