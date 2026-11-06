# Rolling out the PIN login

Replacing the CV station's auth with the shared 6-digit PIN login the
check-in desk already uses.

The whole point of the sequence below is that **no step breaks the station
that is live at the time**, and every step is reversible without a redeploy.
That costs one extra environment variable, `AUTH_ENFORCE`, and one extra
merge at the end to take the scaffolding back out.

The API and the frontend live in one repo, but they do **not** have to ship
together: the Azure workflow can be run by hand against the feature branch,
so the new backend goes in front of the current station before anything
user-facing changes. That is what lets each half be proved separately.

Read this once before starting. Steps 3 and 5 are the ones users notice;
everything else is positioning.

---

## What exists now

| | |
|---|---|
| Branch | `feature/pin-login` in `CSE_cvmeasurement` |
| API | Azure App Service **cvmeasurements-api**, deployed by GitHub Actions on a push to **main** |
| Frontend | Vercel, deployed from **main** |
| Check-in | Branch `feature/pin-login-guard` in `CSE_checkin` — the matching brute-force guard, deployed from `checkin-v1` |

Today the CV API accepts **anonymous requests**: `STATION_API_KEYS` has
always been empty on the App Service, so `auth_enabled` reports `false` and
every endpoint answers anyone with the URL. The repo is public. That is the
thing this fixes.

`auth_enabled` is also the quickest way to tell which backend is deployed.
The old one reports it; the new one replaces it with `auth_enforced`,
`pin_login_ready` and `login_guard`.

---

## Before you start: pick the PINs

They must be the **same two numbers already set on the check-in app**, or
staff will have two PINs to remember and no reason why.

To read what check-in is using: Vercel → the **CSE_checkin** project →
**Settings** → **Environment Variables** → the eye icon next to `DESK_PIN`,
then `ADMIN_PIN`.

If check-in does not have them set either, choose two different 6-digit
numbers now and use the same pair in both places.

> The session token is signed with a key derived from both PINs plus the
> database password. So changing a PIN signs every device out, which is the
> intended way to revoke access. It also means a token from check-in will
> **not** work on CV and vice versa — the two apps use different database
> accounts, so their signing keys differ. Same PIN, separate session in each
> app. That is not single sign-on and should not be described as one.

---

## Step 1 — Set the PINs on the App Service

Nothing deploys here. The station that is live right now sends no login at
all, so adding PINs changes nothing for it — they just sit there until there
is code that reads them.

1. **portal.azure.com** → search **cvmeasurements-api** → click the **App
   Service** result.
2. Left menu, under **Settings** → **Environment variables**. *(Older portal:
   **Configuration** → **Application settings**.)* Stay on the **App
   settings** tab.
3. **+ Add** → **Name:** `DESK_PIN`, **Value:** the 6-digit desk PIN →
   **Apply**.
4. **+ Add** → **Name:** `ADMIN_PIN`, **Value:** the 6-digit admin PIN →
   **Apply**.
5. Find **ALLOWED_ORIGINS**. If it is missing or empty, **+ Add** →
   **Name:** `ALLOWED_ORIGINS` → value (comma separated, no spaces, no
   trailing slashes):

   ```
   https://cv-measurements.vercel.app,https://cv-measurements-git-feature-pin-login-college-sports-evaluation.vercel.app
   ```

   The second origin is the feature branch's preview build, needed for the
   dry run in step 2. Trim it back to production alone at step 7. Empty means
   CORS falls back to `*`, which is what it does today.
6. Do **not** add `AUTH_ENFORCE`. That is step 5.
7. **Apply** at the bottom of the page, then **Confirm**. The app restarts,
   30–60 seconds.

The PINs take their values from check-in, so staff have one PIN and not two.
Both are already set there: **vercel.com** → **cse-checkin** → **Settings** →
**Environment Variables** → the eye icon on `DESK_PIN`, then `ADMIN_PIN`.

> **You cannot verify this step yet, and that is expected.** `/api/health`
> still reports `auth_enabled` — the *old* field — because the code that
> knows about PINs is not deployed. Verification happens at step 2.

---

## Step 2 — Deploy the backend by itself

The API and the frontend are in one repo, but they do not have to ship
together: the Azure workflow has a `workflow_dispatch` trigger with no branch
condition, so it can be run against the feature branch. Vercel only builds
production from `main`, so production stays on the old frontend throughout.

This is what makes the rest low-risk — it puts the new API in front of the
*current* station before anything user-facing changes.

1. **github.com/cseval/CSE_cvmeasurements** → **Actions** tab.
2. In the left sidebar click **Build and deploy Python app to Azure Web App -
   cvmeasurements-api**.
3. On the right, **Run workflow** ▾.
4. In the **Use workflow from** dropdown choose **feature/pin-login**.
5. Click the green **Run workflow**.
6. Wait for the green tick — a few minutes.

**The live station keeps working.** The new backend accepts anonymous
requests until `AUTH_ENFORCE` is set, so the old frontend — which sends a
station key the server no longer requires — carries on exactly as before.

### Now verify

Open `https://cvmeasurements-api.azurewebsites.net/api/health`. The shape
changes; that is how you know the new code is live:

- `"ok": true`
- `"pin_login_ready": true` ← the PINs from step 1 are usable
- `"auth_enforced": false` ← still open, correct for now
- a `"login_guard"` block
- `auth_enabled` is **gone**, replaced by `station_key_enabled`

If `pin_login_ready` is `false`, read `pin_login_problems` in the same
response — it names the fault: not set, not exactly 6 digits, or the two PINs
identical.

### Dry run the new frontend, without touching production

Pushing `feature/pin-login` gave Vercel a preview build. With the new backend
now live, that preview is a complete rehearsal on a URL production cannot
see:

```
https://cv-measurements-git-feature-pin-login-college-sports-evaluation.vercel.app
```

Open it, sign in with the desk PIN, land in the app. Meanwhile the real
station is still on the old build and still working.

⚠️ This is the **real database**. Resolving a tap writes a real `scan_event`;
saving writes a real trial. Use Test Mode to exercise the camera without
attaching anything to a subject.

---

## Step 3 — Merge, and put the new frontend live

Only now, and only because step 2 proved the API half works.

```powershell
cd "C:\Users\BrodeMcDonald\Projects\Lab Projects\apps\CSE_cvmeasurement"
git push                         # make sure the branch is current on origin
git checkout main
git pull
git merge feature/pin-login
git push
```

That push re-runs the Azure workflow (deploying the same code again, a no-op
in effect) and triggers the Vercel production build.

1. **vercel.com** → **cv-measurements** → **Deployments** → wait for **Ready**
   on the `main` deployment.
2. Open `https://cv-measurements.vercel.app`. You should get the **CV Lab**
   PIN screen.
3. Sign in with the desk PIN.
4. Tap a bracelet and confirm a normal resolve.

**To roll back**, Vercel → **Deployments** → the previous **Ready**
deployment → **⋯** → **Promote to Production**. The API still accepts
anonymous requests, so the old frontend works again immediately. Seconds, not
a redeploy.

---

## Step 4 — Run a real session before closing the door

Use it for an actual session. You are checking that:

- the PIN screen comes up on a cold start (force-quit Safari on the iPad and
  reopen);
- a bracelet tapped **while the PIN screen is up** does nothing, and no entry
  for it appears in the station audit afterwards;
- after signing in, taps and measurements behave exactly as before;
- the session is still alive at the end of the shift.

The setup screen shows a warning the whole time saying the API still accepts
requests with no login. That is true, and step 5 clears it.

---

## Step 5 — Close the door

1. **portal.azure.com** → **cvmeasurements-api** → **Settings** →
   **Environment variables**.
2. **+ Add** → **Name:** `AUTH_ENFORCE`, **Value:** `true` → **Apply**.
3. **Apply** at the bottom, then **Confirm**. Wait for the restart.

Verify:

4. Reload `/api/health` → `"auth_enforced": true`.
5. Open `https://cv-measurements.vercel.app` in a **private/incognito
   window** — PIN screen, and no way past it without the PIN.
6. The warning on the setup screen is gone.
7. A station already signed in keeps working; its session is still valid.

**To roll back**, set `AUTH_ENFORCE` to `false` and Apply. Ninety seconds, no
merge, no deploy. That is the entire reason the flag exists.

---

## Step 6 — Check-in's brute-force guard

Separate repo, separate deploy, and it can be done at any point — it does
not interact with the steps above.

```powershell
cd "C:\Users\BrodeMcDonald\Projects\Lab Projects\apps\CSE_checkin"
git checkout checkin-v1
git pull
git merge feature/pin-login-guard
git push
```

Vercel deploys `checkin-v1` automatically. Then check
`https://<checkin-url>/api/health` shows a `login_guard` block.

Nothing about the desk changes. A staffer who mistypes a PIN and then gets it
right is not slowed down at all; what now costs something is repetition.

---

## Step 7 — Take the scaffolding out (not urgent, don't skip)

Once step 5 has been stable for a few sessions, one more small change
removes the transitional paths, so nobody later mistakes them for features:

- drop the `AUTH_ENFORCE` grace branch from `require_session`
- drop `STATION_API_KEYS` and the `X-Station-Key` CORS header
- drop `AUTH_ENFORCE` and `STATION_API_KEYS` from the App Service

Do this as its own merge, after which the only way into the API is a PIN.

Leaving the grace branch in place indefinitely is the realistic failure mode
here: it is invisible, it reports itself only in `/api/health`, and it means
the API is still open. `StationSetup` shows a warning on the setup screen the
whole time `auth_enforced` is false, which is there to stop exactly that.

---

## If something goes wrong

| Symptom | Cause | Fix |
|---|---|---|
| PIN screen says *"Login is not set up on the server"* | `DESK_PIN`/`ADMIN_PIN` missing, not 6 digits, or identical | Step 1. `/api/health` → `pin_login_problems` names which |
| Every PIN rejected right after a deploy | The database password was rotated — it is part of the signing key | Everyone signs in again. Expected, not a fault |
| *"Too many wrong PINs"* | The brute-force lockout, 10 failures in 15 minutes from one address | Wait it out, or restart the App Service to clear it |
| Station shows the PIN screen mid-shift | The session expired or was rejected | Sign in again. **Nothing is lost** — captures taken while signed out sit in the local queue and send themselves after the login |
| Browser console shows CORS errors | `ALLOWED_ORIGINS` does not exactly match the site's origin | Step 1 item 5. No trailing slash |
| Queue shows items "waiting for login" | Working as intended | They go out on the next sign-in |

One thing worth being clear about, because it is the question staff will ask:
**an expired session cannot lose a measurement.** Captures are written to the
device before anything is sent, a rejected session never marks one failed,
and they are sent as soon as somebody signs back in.
