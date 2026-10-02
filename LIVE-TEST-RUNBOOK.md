# Live Test Runbook

> **CURRENT STATUS WARNING:** parts of this runbook predate the current
> app/database contracts. For V1 test setup, use
> `../../docs/prd/new-lab-pipeline-phase-1-test-setup.md` and
> `../../docs/prd/new-lab-pipeline-schema-decisions.md`. CV
> Measurement is now read-only for bracelet/subject setup; bracelets should be
> pre-provisioned before CV tests.

Everything below runs on your laptop. Nothing here has been executed for you —
the folder bridge can read and write files but cannot run commands on your
machine, so these are exact commands rather than a report of what happened.

Work through it in order. Each step says what "good" looks like, so you can
stop at the first thing that does not match instead of debugging three layers
at once.

---

## Do the easy tests first

There are four things being tested here and they are usually confused for each
other. Prove them one at a time, cheapest first. If you skip to the end and
something fails, you will not know which of the four broke.

| | What it proves | Setup needed | Time |
|---|---|---|---|
| **A. Reader bench check** | The reader types into a browser correctly | None. Open a web page | 5 min |
| **B. Database** | The schema is valid and the constraints hold | A MySQL client | 20 min |
| **C. Whole app on your laptop** | Tap, measure and save all work together | Python 3.11, npm | 1 hr |
| **D. Station rehearsal on the iPad** | It works in the room | The above, plus certs and LAN setup | half a day |

**C does not need the iPad.** Plug the reader into your laptop, use the
laptop's webcam, and run everything on `localhost`. Browsers treat `localhost`
as secure, so the camera works with no certificates and no LAN address. That
removes the fiddliest part of D entirely, and it is a real end-to-end test.

Do D only when C passes. D adds three things that fail independently of the
app — self-signed certificates, the iPad trusting them, and your laptop being
reachable over wifi — and they are much easier to debug once you know the
software itself is sound.

Sections 0-3 below are B. Sections 4-5 are C. Section 6 is D.

---

## 0. Commit first

The worktree is on `feature/nfc-measurement-rebuild-clean` with 29 changed and
added files sitting uncommitted. Commit before testing, so a bad live run is
one `git checkout` away from being undone.

```bash
cd "/c/Users/BrodeMcDonald/Projects/Lab Projects/cse-lab-pipeline/apps/cv-measurement-nfc-rebuild"

git status                       # sanity check: should be on ...-clean
# src/components/AthleteSelect.jsx should already be deleted; it was the
# orphaned named-athlete roster picker and must not come back.

git add -A
git commit -F- <<'MSG'
NFC-native rebuild: anonymous capture keyed on bracelet taps

Rebuilds the CV measurement station so identity is resolved once,
downstream, and never touches the capture layer. The operator never sees
an athlete name because the app does not have one.

Schema (sql/):
- Hybrid target: Schema A's three layers and capture_trial.trial_type,
  plus an opaque subject token, subject_tag_binding, an every-tap
  scan_event, and a constrained station_source lookup.
- subject_token is generated, never the bracelet UID. A replacement
  bracelet is an unbind/rebind to the same subject, so capture history
  survives. This replaces anonymous_capture_subject.nfc_tag_id.
- New anonymous lab_movement_screen keyed to capture_trial_id. Distinct
  from the identity-native production table of the same name.
- 00_preflight.sql inventories an existing database before any DDL runs.
- 02_verify_constraints.sql proves the constraints reject bad writes.

Backend:
- Removes every roster/identity endpoint and every read of production
  player/events/attendees.
- POST /api/subject/resolve, /api/capture/save, /api/capture/additional,
  /api/capture/photo, GET /api/station/audit.
- A capture may carry raw_uid instead of subject_id, so a station with no
  network can still measure and resolve at sync time.
- X-Station-Key auth and a real CORS allowlist, replacing no auth and "*".
- All measurements stored as DECIMAL centimetres; marker_cm validated.

Frontend:
- Tap-driven flow; AthleteSelect and the roster are gone.
- Permanently focused tap catcher with poll-based focus recovery.
- Local-first IndexedDB queue with backoff, idempotent on client_ref, and
  a CSV export so a shift is recoverable from the device.
- iPad portrait layout.

Tests: 16 schema constraint checks, 51 capture-path checks against a real
MySQL, 29 browser checks including the ten-taps-no-touches acceptance test.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_012XN4TkajrbYusixS4VReXF
MSG

git push -u origin feature/nfc-measurement-rebuild-clean
```

**Good:** `git show --stat HEAD` lists ~29 files, and `git log --oneline -1`
shows the commit on `feature/nfc-measurement-rebuild-clean`.

---

## 1. Preflight the database — read-only, do this before any DDL

`new_lab_pipeline` already exists in Azure, so what matters is what is already
in it. There are three possible histories and they need three different next
steps, which is what this reports.

```bash
mysql -h cse_db_test.csedb.mysql.database.azure.com \
      -u <user> -p new_lab_pipeline < sql/00_preflight.sql
```

Read the `verdict` row:

| Verdict | What it means | Next step |
|---|---|---|
| `A: EMPTY` | Nothing in it yet | Go to step 2 |
| `B: PDR DDL APPLIED` | The PDR's DDL was run — `anonymous_capture_subject` has `nfc_tag_id`, no `subject_tag_binding` | **Stop.** Send me the output; this needs a migration, not a fresh create |
| `C: OTHER BRANCH MIGRATION` | `movement_screen_result` / `station_tap_log` from the other NFC branch exist | **Stop.** Send me the output |
| `ALREADY HYBRID` | `01` has already run here | Skip step 2, go to step 3 |
| `PARTIAL/UNKNOWN` | Something else | **Stop.** Send me the table list |

Also check the `SHOW GRANTS` output at the bottom: the account needs `CREATE`,
`REFERENCES` and `INDEX`, not just `SELECT`/`INSERT`. A grant that stops at
`INSERT` fails halfway through the DDL, which is a much worse place to find
out.

---

## 2. Create the schema

Only if step 1 said `A: EMPTY`.

```bash
mysql -h cse_db_test.csedb.mysql.database.azure.com \
      -u <user> -p new_lab_pipeline < sql/01_create_new_lab_pipeline_hybrid.sql
```

**Good:** no output at all. MySQL is silent on success.

If it stops partway, the database is half-created. Do not re-run it — send me
the error, because the fix depends on which statement failed.

---

## 3. Prove the constraints actually hold

```bash
mysql -h cse_db_test.csedb.mysql.database.azure.com \
      -u <user> -p new_lab_pipeline -t < sql/02_verify_constraints.sql
```

**Good:** 16 rows, every one `PASS`. It creates and removes its own fixtures
in a reserved id block, so it is safe to re-run.

**Any FAIL means the schema is not enforcing something the app assumes**, and
the app will happily write data that cannot be resolved later. Stop and send
me the output rather than continuing to step 4.

---

## 4. Backend, locally, against the real database

Python **3.11** — MediaPipe does not support 3.12+. Check with
`python --version` before building the venv, and if your default is 3.12+ use
the 3.11 launcher (`py -3.11` on Windows).

```bash
py -3.11 -m venv .venv
source .venv/Scripts/activate        # Windows git-bash; .venv\Scripts\activate in PowerShell
pip install -r requirements.txt

cp .env.example .env
# Fill in: DB_HOST, DB_USER, DB_PASSWORD, DB_NAME=new_lab_pipeline
# Set STATION_API_KEYS to something — anything — so auth is on for the test.
# Set ALLOWED_ORIGINS=https://localhost:5173

uvicorn server:app --reload --port 8000
```

**Good:**

```bash
curl http://localhost:8000/api/health
```

returns `"ok": true`, `"auth_enabled": true`, and the artifact backend line.
`"ok": false` with a `database_error` means the connection string or the Azure
firewall rule, not the app — check that your laptop's IP is allowed on the
MySQL Flexible Server.

Then the capture path against the real database:

```bash
DB_HOST=... DB_USER=... DB_PASSWORD=... DB_NAME=new_lab_pipeline \
  python tests/test_capture_flow.py
```

**Good:** 51/51. This writes real rows to `new_lab_pipeline` — test subjects
with `TC-` tokens and fake `04...` UIDs. They are real data in a real
database, so clean them up afterwards if you want the first live session to be
the only thing in there. The subjects it creates are identifiable by their
`nfc_tag.notes` = "First seen at station cv_app" and their test UIDs.

---

## 5. Frontend

### 5a. On your laptop only — do this one first

Reader plugged into the laptop, laptop webcam as the camera, everything on
`localhost`. No certificates, no LAN address, no iPad.

```bash
# .env.local in the repo root
VITE_API_URL=http://localhost:8000
VITE_STATION_KEY=<one of the STATION_API_KEYS values>
```

```bash
npm install
npm run dev
```

Open the address Vite prints. Browsers treat `localhost` as a secure context,
so the webcam works without any certificate work. You can now tap a real
bracelet, take a real photo and watch a real row land in the database — which
is the whole thing working, end to end.

Work through the checklist in section 6 here first. Everything except the
iPad-specific items applies.

### 5b. On the iPad — only after 5a passes

```bash
# .env.local
VITE_API_URL=https://<your-laptop-lan-ip>:8000
VITE_STATION_KEY=<one of the STATION_API_KEYS values>
```

The iPad has to reach your laptop, so `localhost` will not do — use the LAN
IP. And it must be **https**, because `getUserMedia` needs a secure context on
iOS.

```bash
npm install
npm run dev
```

`@vitejs/plugin-basic-ssl` serves a self-signed cert. On the iPad you will get
a certificate warning for both the Vite origin and the uvicorn origin; accept
both. **Visit the API origin in Safari first and accept its cert**, otherwise
every `fetch` from the app fails silently with an opaque network error and it
looks like the backend is down.

Uvicorn needs TLS too for that to work:

```bash
pip install pyopenssl
uvicorn server:app --port 8000 --ssl-keyfile key.pem --ssl-certfile cert.pem
# generate a throwaway pair first:
#   openssl req -x509 -newkey rsa:2048 -nodes -keyout key.pem -out cert.pem -days 30 -subj "/CN=<lan-ip>"
```

---

## 6. The station rehearsal

This is the one that actually validates the build. Reader plugged into the
iPad, marker printed and taped up, bracelets in hand.

Work down the list. Each line is a thing that has broken before or that the
design specifically claims.

**Setup**

1. App opens on **Station Setup** (first run, nothing in localStorage).
2. Pick the marker size that matches the print **on the wall**, not the one
   you meant to print. Print the PDF from this screen at **Actual size**.
3. Enter an operator name — Start stays disabled without one.
4. Reload the page. It should come straight back to the tap screen with the
   settings intact.

**The focus invariant — the #1 documented bug**

5. Tap ten bracelets in a row without touching the screen between taps. **All
   ten must register.** This is the handoff's own acceptance test.
6. Touch the screen somewhere blank, then tap. It must still register.
7. Open Setup, press Cancel, then tap. It must still register.
8. Lock the iPad, unlock it, then tap. It must still register.
9. With the reader plugged in, no on-screen keyboard should ever appear. If it
   does, the reader is not connected — that is iOS behaviour, not a UI bug.

**Taps**

10. Tap an **unenrolled** bracelet. It resolves, shows a `TC-XXXX-XXXX` token,
    and flags "Not enrolled". Capture must still be allowed.
11. Tap the **same** bracelet again. Same token, and it must **not** say
    "First capture".
12. Type junk into the field and press Enter. It should say "Tap Not Read"
    with a specific reason, and the next real tap must still work.

**Measurement**

13. Full T-pose capture. Check the three numbers against a tape measure on at
    least one athlete — the CV core is unchanged from V1, so this is
    confirming nothing regressed, not validating the algorithm.
14. Drag an endpoint in Adjust Lines. The value re-derives.
15. Save. The button says **"Saved on this device"**, not "saved to the
    database" — that is the local-first design being honest.
16. Add assessment values on the next screen and save.

**The parts that only fail in the field**

17. Turn off the laptop's wifi (or kill uvicorn). Tap a bracelet. The station
    must show the raw UID and "Offline — resolves on sync", and **let you
    measure anyway**. Save one.
18. Bring the network back. The header pill goes from "queued" to "Synced" on
    its own within about 30 seconds.
19. Check the DB: that offline capture has a real `capture_trial`, and its
    `scan_event` row is linked to it.
20. Measure the same athlete **twice**. Two `capture_trial` rows, `trial_number`
    1 and 2, one `capture_session`. Neither overwrites the other.
21. Tap a second bracelet while an athlete is mid-measurement. A banner
    appears; nothing switches until you choose.
22. Open the audit screen. Taps that produced no data should be counted there.
23. Export the session CSV. It should contain every measurement from the
    shift, keyed by subject token.

---

## 7. What to check in the database afterwards

```sql
-- Every trial from today, with how identity resolves. No names — that is
-- the point. athlete_id is NULL for unenrolled bracelets, which is correct.
SELECT ct.id AS trial, ct.trial_number, acs.subject_token,
       nt.tag_uid, nta.athlete_id,
       lms.height_cm, lms.wingspan_cm, lms.hand_span_cm,
       lms.measurement_method, lms.scale_warning
  FROM capture_trial ct
  JOIN capture_session cs  ON cs.id = ct.capture_session_id
  JOIN anonymous_capture_subject acs ON acs.id = cs.anonymous_capture_subject_id
  LEFT JOIN subject_tag_binding stb
         ON stb.anonymous_capture_subject_id = acs.id
        AND ct.trial_timestamp >= stb.active_from
        AND (stb.active_to IS NULL OR ct.trial_timestamp < stb.active_to)
  LEFT JOIN nfc_tag nt ON nt.id = stb.nfc_tag_id
  LEFT JOIN nfc_tag_assignment nta
         ON nta.tag_id = nt.id
        AND ct.trial_timestamp >= nta.active_from
        AND (nta.active_to IS NULL OR ct.trial_timestamp < nta.active_to)
  LEFT JOIN lab_movement_screen lms ON lms.capture_trial_id = ct.id
 WHERE cs.capture_date = CURDATE()
 ORDER BY ct.trial_timestamp;

-- Taps that produced nothing. Should be only the ones you caused on purpose.
SELECT raw_scan_value, scanned_at, valid_shape, resolved, enrolled
  FROM scan_event
 WHERE DATE(scanned_at) = CURDATE() AND capture_trial_id IS NULL
 ORDER BY scanned_at;

-- What chip family the bracelets actually reported. Confirm and correct
-- chip_type from this — it is currently a guess from UID length.
SELECT tag_uid, CHAR_LENGTH(tag_uid) AS uid_len, chip_type, issued_at
  FROM nfc_tag ORDER BY issued_at DESC LIMIT 20;
```

---

## Not done, and deliberately not

- **Deploying to Azure.** The `azure-deploy` branch pushes to
  `cvmeasurements-api`, which is the App Service currently serving the **V1
  app in production**. Deploying this replaces that API with one that has no
  roster endpoints, so V1 stops working the moment it lands. That needs to be
  a scheduled cutover, not a step in a test runbook.
- **Photo storage on Azure Blob.** Photos default to App Service local disk,
  which does not survive a redeploy or a scale-out. Fine for a local test,
  not for a real session.
- **Reconciling to production `lab_movement_screen`.** Nothing populates it
  from the new pipeline yet, so existing reports will not see any of this.
