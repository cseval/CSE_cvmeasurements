# CV Measurement App — NFC-Native Rebuild Handoff

**For:** goose (or any agent/engineer picking this up cold)
**Repo:** `cvmeasurement` (`cseval/CVMeasurements`) — `C:\Users\BrodeMcDonald\Projects\Lab Projects\cvmeasurement`
**Companion docs:** `..\NEW Pipeline\new-lab-pipeline-pdr.md` (the target schema — read it), `..\NEW Pipeline\sql\01_create_cse_v2_schema.sql`, `..\NEW Pipeline\firmware\code.py`
**Written:** August 2026
**Scope decided:** full rebuild, NFC-native from the ground up. Not a patch on the existing app.

---

## 1. What we are actually trying to accomplish

The CSE lab is being rebuilt around a single architectural idea: **athlete identity is resolved exactly once, downstream, and never touches the capture layer.**

Every station in the lab — QTM/force plates, Rapsodo, Trackman, Blast, check-in, and this measurement app — stops asking "who is this person?" and starts asking "which tag is this?" An athlete wears an NFC bracelet. They tap. The tap emits the tag's factory-burned UID as uppercase hex. That UID is the only subject key any capture system ever sees. Names, `cse_player_id`, emails, and DOBs live in the production database and are joined in later, once, through a single mapping table.

The PDR states the rule in one sentence, and it is worth reproducing verbatim because it is the whole design:

> **Raw capture tables never carry `athlete_id`, `player_id`, or `cse_player_id` directly.** The only table where a physical tag and an athlete identity are linked is `nfc_tag_assignment`. Everything else resolves identity by joining through it (and, beyond this database, through `entity_crosswalk`) — never by storing identity redundantly for convenience.

Why this matters enough to justify a rebuild:

- **Joins stop being fuzzy.** The old biomech pipeline documents two separate defects: biomechanics tables cannot be reliably joined to Rapsodo/Trackman data, and the ingest script resolves athletes by fuzzy name matching against the player table. Tag-based identity attacks the second directly — a UID is exact or it is absent, never *wrong* — and gives trial-level pairing a deterministic key to hang off. (The source deck lists these as distinct limitations; do not repeat a causal claim between them that it does not make.)
- **PII stops sprawling.** Capture files, device exports, and landing tables carry no names. That collapses the surface area for a data problem involving minors.
- **New capture types plug in without schema work.** `capture_trial.trial_type` means a movement screen, a pitch, a swing, and whatever comes next all share one shape.

The CV measurement app is one station in that lab. Today it is the *most* identity-native thing in the building — it is built entirely around picking a named human out of a roster. That is exactly backwards from where everything else is going, which is why it is being rebuilt rather than adjusted.

---

## 2. Where the app sits today

### 2.1 What it does

A web app that measures an athlete's **height**, **wingspan**, and **hand span** from a single phone photo. The athlete stands in a T-pose against a wall with a printed ArUco marker taped beside them at wrist height. The marker establishes a pixel-per-cm scale; MediaPipe locates body and hand landmarks; the app returns measurements in centimeters plus an annotated photo showing exactly which points were used. A second screen collects manually-measured assessment data (age, weight, hip ER/IR, t-spine rotation, grip strength) for the same athlete.

It works. The CV half of this app is not the problem and should be carried over close to intact.

### 2.2 Operator flow, as built

```
Instructions
  → AthleteSelect     Step 1: pick marker size (12/16/20cm) + print marker PDF
                      Step 2: search event by name → select
                      Step 3: roster loads → tap a named player
                      (or "Test Mode" → no athlete, measure only)
  → Camera            live camera or photo-library pick; optional 5s countdown
  → Results           annotated photo, three measurement cards,
                      "Adjust Lines" (drag endpoints, re-derives values),
                      "Enter Manually" (type values if CV failed),
                      Save → upsert to DB
  → AdditionalInfo    age/weight/hips/t-spine/grip → update same row
  → back to AthleteSelect, same event roster preserved
```

### 2.3 Architecture

```
React 18 + Vite 5 (Vercel)  ──HTTPS──▶  FastAPI + MediaPipe + OpenCV (Azure App Service, Python 3.11)
                                              │
                                              ▼
                                    Production MySQL (Azure Database for MySQL)
                                    tables: player, events, attendees, lab_movement_screen
```

The frontend does **no** CV work. Every capture is a multipart POST of a full JPEG to Azure; MediaPipe runs server-side. Every screen transition that touches data is a network round trip. There is no local persistence, no queue, no offline mode.

### 2.4 File map

| File | Role |
|---|---|
| `server.py` | FastAPI app, all endpoints, CORS wide open (`allow_origins=["*"]`) |
| `db.py` | Raw `mysql.connector` queries — events, roster, status, upsert, additional |
| `pipeline.py` | `run(image_path, debug, marker_cm)` — the whole CV flow, also a CLI |
| `calibrate.py` | ArUco detection → `px_per_cm` |
| `measure.py` | Height / wingspan / hand-width math from landmarks |
| `visualize.py` | Draws the annotated overlay returned to the client |
| `generate_marker.py` | Marker PNG/PDF generation, served by `/api/marker/{cm}` |
| `src/App.jsx` | Screen state machine (`instructions`/`athlete`/`camera`/`results`/`additional`) |
| `src/components/Instructions.jsx` | Entry screen — photo-setup guidance, "Start". Rewrite for the tap flow; keep the setup guidance |
| `src/components/BrandBar.jsx` | Shared header, imported by four components. Carry over |
| `src/components/AthleteSelect.jsx` | Event search → roster → player pick. **This is the component the rebuild deletes.** |
| `src/components/Camera.jsx` | getUserMedia capture + file-library fallback |
| `src/components/Results.jsx` | Measurement cards, adjust, manual entry, save |
| `src/components/AdjustCanvas.jsx` | Draggable endpoint correction, re-derives cm from px |
| `src/components/AdditionalInfo.jsx` | Second-screen assessment fields |

### 2.5 API surface

| Endpoint | Purpose | Identity-bearing? |
|---|---|---|
| `GET /api/events?q=` | Search `events` by name | — |
| `GET /api/events/{id}/roster` | `attendees` ⋈ `player` → named roster | **yes** |
| `GET /api/athletes?q=` | Name search over `player` | **yes** — *dead code, UI no longer calls it* |
| `GET /api/athletes/{player_id}/status` | Does this player already have a `lab_movement_screen` row? | **yes** |
| `POST /api/measure` | Image + `marker_cm` → measurements + annotated image | no |
| `POST /api/save` | Upsert height/wingspan/hand into `lab_movement_screen` | **yes** |
| `POST /api/save_additional` | Update assessment columns on a row id | via row id |
| `GET /api/marker/{cm}` / `/pdf` | Printable marker | — |

### 2.6 The write path today

`upsert_measurement()` in `db.py`:

- Looks up the athlete's **most recent** `lab_movement_screen` row (`ORDER BY session_date DESC, created_at DESC LIMIT 1`).
- If a row exists → `UPDATE` its `height`, `wingspan`, `hand_size`, plus `event_id = COALESCE(?, event_id)` and `user_id = COALESCE(?, user_id)`. Note those last two — §4.1 removes them from the write path and they are easy to miss.
- If not → `INSERT` a new row carrying `cse_player_id`, `first_name`, `last_name`, a generated `screen_id` UUID, today's date as both `session_date` and `assessment_date`, plus `event_id` and `user_id` passed from the client.

Units, as actually stored: `height` as a **string** in cm; `wingspan` rounded to whole **inches**; `hand_size` in **inches** to one decimal.

### 2.7 Known problems in the current build

These are facts about the code, not opinions, and several are fixed for free by the rebuild:

1. **A second visit overwrites the first.** The upsert targets the latest existing row rather than creating a new one, so there is no longitudinal history. A lab that measures the same athlete across a season currently cannot see change over time.
2. **Names are written into the measurement row.** `first_name`/`last_name` are denormalized into `lab_movement_screen`. Directly contrary to the target architecture.
3. **Unit mixing is lossy.** Height as a string in cm, wingspan rounded to a whole inch (±1.27cm of quantization on a measurement the CV resolves far finer than that), hand span in inches. Everything should be stored in cm as a decimal and converted at display time only.
4. **Zero auth.** No API key, no token, no origin restriction. Anyone with the URL can read the roster of any event by name and write measurements.
5. **`marker_cm` is client-supplied and unvalidated.** Selecting 20cm while holding a 12cm printout yields confidently wrong measurements with no warning. The scale error propagates linearly into every value.
6. **Fully online.** Any network hiccup at the station loses the operator's work. There is no local write, no retry queue.
7. **README is stale on deployment.** It documents relative `/api/...` paths plus a Vercel rewrite; the code actually calls `${import.meta.env.VITE_API_URL}/api/...` everywhere, and `vercel.json` contains no `rewrites` block. Trust the code.
8. **`GET /api/athletes` is orphaned.** Left over from the pre-roster flow.

---

## 3. Where we are going

### 3.0 ⚠ Two competing schemas exist on disk — pick one before writing any DB code

This is the single most important thing to resolve before the rebuild starts. `NEW Pipeline\` contains **two different, incompatible target schemas**, both fully specified, neither marked as superseded.

**Schema A — `new-lab-pipeline-pdr.md`** (modified 2026-08-17)
Target DB `new_lab_pipeline`. Three layers. Subject key is `anonymous_capture_subject.subject_token` — *usually* equal to `nfc_tag.tag_uid`, but deliberately abstracted so QR / manual / device-generated capture methods can plug in later without touching the table. Identity reached through `nfc_tag_assignment` → `athlete` → `entity_crosswalk` → `cse_player_id`. Trials modelled as `capture_trial` with a `trial_type` discriminator (`'movement_screen'` is the one this app writes). MySQL `TIMESTAMP`. Product of a design review with Hermes.

**Schema B — `sql\01_create_cse_v2_schema.sql`** (modified 2026-07-31 — older, but *more concrete*)
Target DB `cse_db_v2_dev`. Built around **`cse_token`** — an abstract 12-char identity (`TC-4K7M-92QX`), deliberately *not* the physical tag. `token_binding` maps a physical medium (`nfc_bracelet` / `nfc_card` / `qr_card`) to that token, so a lost bracelet is a rebinding to the same `cse_id` and capture history is untouched. `identity_link` is written once at claim time by TC Locker. `capture_session` is one row per station visit. `scan_event` logs *every* tap including unresolved ones. `DATETIME(3)` in UTC throughout.

Points that should weigh on the decision:

- **Schema B already knows about this app by name.** Its `station_source` seed data literally contains `('cv_app', 'CV measurement app', 0)`. Schema A has station *attributes* — `capture_session.source_device`, `.lab_location`, `.session_type`, and `land_qtm_capture_meta.qtm_station_id` — but no station lookup table, so station codes are free text rather than a constrained set.
- **Schema B's `scan_event` solves the unenrolled-tap problem outright** — `cse_id` is nullable by design and `raw_scan_value` always holds exactly what the reader typed. Schema A leaves this to the application.
- **Schema B survives a lost bracelet more gracefully.** Identity is the abstract `cse_token`; a lost bracelet is an unbind/rebind to the *same* `cse_id` and capture history is untouched. Schema A can do the same through `nfc_tag_assignment` and its `previous_assignment_id` chain, but only if `subject_token` is treated as the abstraction the PDR says it is rather than being filled with the raw UID — which is the tempting shortcut. If Schema A wins, decide the reissue story explicitly.
- **Schema A is newer and is what the V1 diagram in the project reflects.** It is also the one that came out of the Hermes review, and the one the NFC station validation protocol's acceptance queries are written against.
- **Neither has anywhere to store the actual measurements.** See §6.1 — this is true regardless of which you pick.

**On `station_tap_log`.** This name appears in the NFC station validation protocol and is *not* an alias for Schema B's `scan_event` — do not collapse them. It is a Schema-A-aligned lab tap log (`station_id`, `bracelet_uid`, `tapped_at`, `tap_round`) whose job is to let closed systems with no injection point — Rapsodo, Trackman, Blast — be joined on a timestamp window. `scan_event` is an audit log keyed on `raw_scan_value` / `cse_id` / `resolved` / `binding_id`, with no `tap_round` and no window-join role. If you implement one thinking it is the other, you will ship a table missing the column that three of five stations join on.

**Do not let goose pick.** Get a human answer, then delete or clearly archive the losing file so the next person does not hit this.

The rest of this section is written against **Schema A** because it is the newer document. If Schema B wins, the shape of the work does not change — a tap resolves to a durable subject key, a session and a trial are created, no PII is written — only the table and column names change.

### 3.1 The target data model (Schema A)

Read `new-lab-pipeline-pdr.md` §4 and §7 in full. The three layers:

```
LAYER 1 — Operational identity (thin, local, no PII)
  athlete, entity_crosswalk, guardian, guardian_athlete_relationship,
  event, event_session, event_roster_entry

LAYER 2 — Anonymous capture  ← the measurement app writes HERE
  nfc_tag, nfc_tag_assignment,
  anonymous_capture_subject, capture_session, capture_trial,
  source_import_batch, file_artifact

LAYER 3 — Device/modality raw capture (keyed to capture_trial only)
  land_qtm_*, land_theia_*, land_force_platform_geometry, land_qrf_raw,
  raw_rapsodo_*
```

The tables that matter for this app:

- **`anonymous_capture_subject`** — `subject_token`, `capture_method` (`'nfc'`), `nfc_tag_id`. This is what capture keys off. Per the PDR, `subject_token` is "usually equal to `nfc_tag.tag_uid`, but abstracted so a future non-NFC capture method (QR, manual code, device-generated ID) can plug in without changing this table" — treat it as an opaque token, not as the UID. The table deliberately does not reference `nfc_tag_assignment` or `athlete`.
- **`capture_session`** — one lab visit / station visit. `anonymous_capture_subject_id`, `event_session_id`, `capture_date`, `lab_location`, `session_type`, `source_device`, `operator`. **No identity column.**
- **`capture_trial`** — `capture_session_id`, `trial_number`, `trial_type` (`'movement_screen'` for this app), `trial_timestamp`, `validity_flag`, `notes`.
- **`file_artifact`** — where the annotated/raw photo goes if we keep it.
- **`nfc_tag_assignment`** — the *only* tag↔athlete link. Has MySQL generated-column unique indexes enforcing one active assignment per tag and per athlete. Those virtual columns are load-bearing; do not remove them.

### 3.2 The target operator flow

```
Station setup (once per session)   operator picks marker size, event session, station id
  ↓
Idle "TAP TO BEGIN" screen         hidden input focused, waiting for HID keystrokes
  ↓  athlete taps bracelet → reader types 14 hex chars + Enter
Subject resolved                   UID → anonymous_capture_subject (created if new)
                                   screen shows a NON-IDENTIFYING confirmation
  ↓
Camera                             unchanged from today
  ↓
Results                            unchanged: annotated photo, adjust, manual entry
  ↓  Save
Local write first, sync second     capture_session + capture_trial(trial_type='movement_screen')
  ↓
AdditionalInfo                     unchanged fields, attached to the same trial
  ↓
back to idle, ready for next tap   no roster to return to — there is no roster
```

The event/roster picker disappears entirely. The operator never sees or selects a name.

### 3.3 How the tap physically arrives

The reader is a **USB HID keyboard**, not an API. Firmware: Waveshare RP2040-Zero + PN532 over I²C, CircuitPython (`NEW Pipeline/firmware/code.py`). On tag detection it types the UID as uppercase hex with no separators and presses Enter. Settings that matter to the app:

- `COOLDOWN = 3.0` — the same tag cannot re-fire within 3 seconds
- `SEND_ENTER = True` — the form submits itself
- `PREFIX = ""` — optionally set to e.g. `"BR-"` to distinguish sources

**UID length is not fixed — do not hard-code it.** The firmware formats whatever the tag returns: `"".join("{:02X}".format(b) for b in uid)`. An NTAG21x UID is 7 bytes → **14** hex characters. A Mifare Classic UID is 4 bytes → **8** hex characters. Which chip the ordered bracelets actually carry is still an open project item — the validation gate reads "if it returns Mifare Classic rather than NTAG21x, UID reading still works on this hardware," and Schema B's `token_binding.chip_type` comment lists `MifareClassic1K` alongside `NTAG213`/`NTAG215`. Validate as `^[0-9A-F]{8,20}$` with an even length (plus `PREFIX` if configured), store the raw string, and record the observed length during station validation rather than asserting it in code. `nfc_tag.tag_uid` is `VARCHAR(20)`; Schema B's `token_binding.uid` is `VARCHAR(32)`.

For the app, this means the tap is indistinguishable from someone typing very fast into a focused text field. There is no NFC API to call. **Any screen that can receive a tap must have a focused input at all times.**

---

## 4. The delta — what to build

### 4.1 Remove

- `src/components/AthleteSelect.jsx` in its entirety.
- `GET /api/events`, `GET /api/events/{id}/roster`, `GET /api/athletes`, `GET /api/athletes/{player_id}/status`.
- `search_athletes()`, `search_events()`, `get_event_roster()`, `get_athlete_status()` from `db.py`.
- All `first_name` / `last_name` / `player_id` / `user_id` fields from request and response models.
- Every read of the production `player`, `events`, and `attendees` tables.

### 4.2 Add

- **A tap-capture layer.** A persistently-focused hidden input that accumulates keystrokes until Enter, validates the shape (uppercase hex, even length, 8–20 chars — see §3.3 on why not a fixed 14 — plus `PREFIX` if configured), and resolves the UID. Must re-focus after *every* submit, every screen transition, and every modal dismiss.
- **`POST /api/subject/resolve`** — UID in, `anonymous_capture_subject_id` out, creating the subject and its `nfc_tag` row on first sight. Returns no identity, ever.
- **Session bootstrap.** A one-time-per-shift station config screen: marker size, `event_session_id`, `lab_location`, `station/source_device`, `operator`. Persisted locally so a reload does not lose it.
- **`POST /api/capture/save`** — writes `capture_session` (or reuses today's for this subject) + a `capture_trial` with `trial_type='movement_screen'`, then the measurement values (see the open decision in §6.1).
- **Local-first persistence with a sync queue.** IndexedDB write on save, background retry to the API, a visible pending/synced indicator, and a CSV export so a session can be recovered from the device if the backend is unreachable for the whole shift.
- **Unenrolled-tag handling.** A tap for a UID with no active assignment must still capture successfully — anonymous capture does not require the assignment to exist yet — but the UI should surface it so staff can reconcile before the athlete leaves the building. Under Schema B this is already modelled: write a `scan_event` with `resolved = 0`, `cse_id = NULL`, and `raw_scan_value` set to exactly what the reader typed. Under Schema A you build the equivalent yourself.
- **A scan log, whichever schema wins.** Log every tap at this station — resolved or not, successful capture or not — with the raw reader output, station, device, operator, and UTC timestamp. This is the concrete deliverable behind the "little ability to audit data quality" gap in the old pipeline. A station that scanned but produced no data must show up as a visible gap rather than disappearing.
- **Repeat-tap guard.** The firmware's 3s cooldown handles a bracelet resting in the field. The app still needs to handle "same UID tapped again five minutes later," which is a legitimate second trial, not a duplicate.

### 4.3 Keep, close to intact

The CV core is good. Carry it over with minimal changes:

- `pipeline.py`, `calibrate.py`, `measure.py`, `visualize.py`, `generate_marker.py` — unchanged.
- `POST /api/measure` — unchanged; it is already identity-free.
- `Camera.jsx` — unchanged.
- `Results.jsx` presentation, `AdjustCanvas.jsx` endpoint dragging, and the "Enter Manually" path. These three are the app's real-world resilience and losing any of them makes the station worse.
- **Test Mode** — measure with no subject attached. Keep it; it is how you sanity-check a marker print or a camera position without polluting data.

### 4.4 Fix while rebuilding

- Store **all** measurements as `DECIMAL` centimeters. Convert to feet/inches at render only.
- Every save creates a **new** trial. Never overwrite a prior visit.
- Validate `marker_cm` against the detected marker where possible, and at minimum make the selected size impossible to forget — display it persistently on the capture screen.
- Put an auth token on the API. Even a static station key in an env var is a strict improvement over open.

---

## 5. Invariants — do not break these

These are inherited from the check-in station build, where they were learned the expensive way.

1. **Re-focus the input after every submit.** If focus is lost, the next tap goes nowhere and presents to staff as a hardware failure. This is documented as the #1 integration bug across the whole NFC effort. Test it by tapping ten times without touching the screen between taps; all ten must register.
2. **Write locally first, sync second.** Never block a staffer on a network round trip with a line of athletes in front of them. Lab and venue wifi fails during the opening rush, reliably.
3. **No identity in the capture path.** Not in a request body, not in a response, not in a log line, not in a local-storage key, not in a filename.
4. **A tap is an identifier, not a credential.** A UID is readable by anyone with a phone and clonable onto a blank tag in seconds. Fine for attaching a measurement to a subject. Never treat it as proof of who someone is.
5. **A missing tap must fail loudly and stay recoverable.** A trial that lands with no subject must be visibly unassigned — never silently dropped, and never attributed to the previous athlete.

---

## 6. Open decisions — goose should not invent answers to these

### 6.0 Which schema (blocking, decide first)

See §3.0. Two complete, incompatible target schemas exist. Everything below §6.1 assumes this is settled.

### 6.1 There is no table for the measurement values (blocking)

This is the biggest gap, and it exists in **both** schemas. Schema A's `capture_trial` with `trial_type='movement_screen'` gives you a trial row but **nowhere to put height, wingspan, hand span, hip ER/IR, t-spine rotation, or grip strength** — PDR §10 explicitly defers movement-screen summaries and `trial_metric` to V1.5. Schema B is worse in this respect: it has no trial or metric table at all, only `capture_session`, `capture_window`, and `scan_event`.

Meanwhile the current write target, `lab_movement_screen`, lives in the *production* database and is identity-native by construction (`cse_player_id`, `first_name`, `last_name`).

Three plausible resolutions, all requiring a human decision:

- **(a)** Pull `trial_metric` / a `movement_screen_result` table forward from V1.5 into V1 so measurements land in `new_lab_pipeline` keyed to `capture_trial_id`. Cleanest, requires a schema addition.
- **(b)** Keep writing `lab_movement_screen` in production, but key it by a resolved `cse_player_id` obtained *after the fact* through `nfc_tag_assignment` → `entity_crosswalk`. Preserves existing reports; puts identity resolution inside this app, which cuts against the architecture.
- **(c)** Write anonymously to `new_lab_pipeline` now and build a separate reconciliation job that populates `lab_movement_screen` downstream. Most faithful to the design; most work.

**Recommend (a) or (c). Do not let the rebuild default into (b) by inertia** — it is the path of least resistance and it quietly reintroduces exactly the coupling the whole pipeline exists to remove.

### 6.2 What hardware runs the station

The reader is USB-C HID. The current app is a phone web app using `getUserMedia` over HTTPS. A phone with a USB-C reader hanging off it is awkward at a measurement station where the operator is also framing a full-body photo from several feet back.

Options: an iPad with reader attached (matches the check-in station build; note no iPad has ever shipped NFC reader hardware, which is why the HID build exists at all); a laptop/tablet with an attached webcam; or tap-at-arrival on a fixed station device with the camera on a separate phone that joins by session. **This decision changes the UI layout materially** and should be settled before the frontend is built.

### 6.3 Do we keep the photos?

`file_artifact` exists and can hold them. Storing a full-body photo of a minor athlete is a materially different data-retention posture than storing three numbers. Decide deliberately, not by defaulting to whatever is easiest.

### 6.4 Enrollment ownership

Bracelet → athlete enrollment happens at check-in (`checkin.html`), not here. Confirm that the measurement app never needs to enroll, and that an unenrolled tap at this station is a reconcile-later condition rather than a blocker.

---

## 7. Quick reference

**Environment**

```
DB_HOST= DB_PORT=3306 DB_NAME= DB_USER= DB_PASSWORD=      # backend .env / App Service settings
VITE_API_URL=                                              # frontend, Vercel env
```

**Stack constraints**

- Python **3.11** — MediaPipe does not support 3.12+.
- `opencv-contrib-python-headless`, never the GUI wheel (Azure Linux has no `libxcb`); `scripts/azure_post_build.sh` strips the GUI package if Oryx pulls it in.
- Azure App Service tier **B2 minimum** — MediaPipe and OpenCV need real CPU/RAM. Free/Shared hits `QuotaExceeded`.
- Frontend dev runs HTTPS via `@vitejs/plugin-basic-ssl`; mobile camera access requires it.

**Marker**

- Sizes offered: 12 / 16 / 20 cm. Served as a PDF because a PDF's page size *is* the physical size — printing HTML at a CSS size is not reliable across printer drivers.
- Print at "Actual size," not "Fit to page." Tape flat on the wall at wrist height, same plane as the athlete.

**Reader**

- `NEW Pipeline/firmware/code.py` — PWM buzzer variant (the buzzers on hand are passive; a plain digital high produces a faint tick and nothing else).
- Types uppercase hex, no separators, then Enter. 14 characters for a 7-byte NTAG21x UID, 8 for a 4-byte Mifare Classic UID — chip family is still an open item, so do not assume a length.

**Photo setup that produces good measurements**

Back near the wall, arms fully extended horizontally at shoulder height, palms to camera, fingers together. Camera at chest height, full body in frame. Even lighting — shadows on hands are the main cause of hand-span detection failure.
