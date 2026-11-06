# Rolling out the PIN login

Replacing the CV station's auth with the shared 6-digit PIN login the
check-in desk already uses.

The whole point of the sequence below is that **no step breaks the station
that is live at the time**, and every step is reversible without a redeploy.
That costs one extra environment variable, `AUTH_ENFORCE`, and one extra
merge at the end to take the scaffolding back out.

The order matters in exactly one way: the PINs go on the server **before**
the frontend that asks for them. Everything after that is reversible.

Read this once before starting. Steps 2 and 4 are the ones that change
behaviour; everything else is positioning.

---

## What exists now

| | |
|---|---|
| Branch | `feature/pin-login` in `CSE_cvmeasurement` |
| API | Azure App Service **cvmeasurements-api**, deployed by GitHub Actions on a push to **main** |
| Frontend | Vercel, deployed from **main** |
| Check-in | Branch `feature/pin-login-guard` in `CSE_checkin` — the matching brute-force guard, deployed from `checkin-v1` |

Today the CV API accepts **anonymous requests**: `STATION_API_KEYS` has
always been empty on the App Service, so `auth_enabled` has been reporting
`false` and every endpoint answers anyone with the URL. The repo is public.
That is the thing this fixes.

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

Do this **first**, before anything deploys. The station that is live right now
sends no login at all, so adding PINs to the server changes nothing for it —
but it means that the moment the new frontend appears, there is something for
it to sign in against.

1. Go to **portal.azure.com**.
2. In the top search bar type **cvmeasurements-api** and click the **App
   Service** result.
3. In the left menu, under **Settings**, click **Environment variables**.
   *(On an older portal this is **Configuration** → **Application settings**
   — same thing.)*
4. Click **+ Add**. **Name:** `DESK_PIN` — **Value:** the 6-digit desk PIN.
   Click **Apply**.
5. Click **+ Add** again. **Name:** `ADMIN_PIN` — **Value:** the 6-digit admin
   PIN. Click **Apply**.
6. Check **ALLOWED_ORIGINS** in the same list. If it is missing or empty,
   click **+ Add**, **Name:** `ALLOWED_ORIGINS`, and set the value to BOTH
   the production origin and the feature branch's preview origin, comma
   separated, no trailing slashes:

   ```
   https://cv-measurements.vercel.app,https://cv-measurements-git-feature-pin-login-college-sports-evaluation.vercel.app
   ```

   The preview origin is in there so the dry run below works. Trim it back to
   the production origin alone at step 6. Leaving the variable empty means
   CORS falls back to `*`, which is what it does today.
7. Do **not** add `AUTH_ENFORCE` yet. That is step 4.
8. Click **Apply** at the bottom of the page, then **Confirm**. The app
   restarts; give it a minute.

Check:

9. Open `https://cvmeasurements-api.azurewebsites.net/api/health`.
10. You want `"ok": true`, `"pin_login_ready": true`, and
    `"auth_enforced": false`.

If `pin_login_ready` is `false`, read `pin_login_problems` in the same
response — it names what is wrong (not set, not 6 digits, or the two PINs are
identical). Nothing has changed for the station either way.

### Dry run on the preview, before touching production

Pushing `feature/pin-login` gave Vercel a preview build of the new frontend,
pointed at the real API. Once the PINs are set, that preview is a complete
rehearsal of step 2 that production cannot see:

```
https://cv-measurements-git-feature-pin-login-college-sports-evaluation.vercel.app
```

Open it, sign in with the desk PIN, and confirm you land in the app. The
production station is untouched and still running the old build throughout.

One caution: this is the **real database**. Resolving a tap writes a real
`scan_event`, and saving writes a real trial. Sign in and look around; use
Test Mode if you want to exercise the camera without attaching anything.

---

## Step 2 — Merge and let both sides deploy

The API and the frontend live in the same repo and both deploy from `main`,
so this is one push.

In PowerShell, from `C:\Users\BrodeMcDonald\Projects\Lab Projects\apps\CSE_cvmeasurement`:

```powershell
git checkout main
git pull
git merge feature/pin-login
git push
```

Then watch both land:

1. **github.com/cseval/CSE_cvmeasurements** → **Actions** tab. The top run is
   **Build and deploy Python app to Azure Web App - cvmeasurements-api**.
   Wait for the green tick — a few minutes.
2. **vercel.com** → the CV measurement project → **Deployments** → wait for
   **Ready**.

Vercel is usually faster than Azure. If you open the station in that gap you
may get *"That PIN was not recognised"* because the old API has no
`/api/login` yet. Wait for the Actions run to go green, then reload.

Check:

3. Open the station URL. You should get the **CV Lab** PIN screen.
4. Tap the PIN box, key in the desk PIN. You should land in the app.
5. Tap a bracelet and confirm a normal resolve.

**To roll back**, Vercel → **Deployments** → the previous **Ready** deployment
→ **⋯** → **Promote to Production**. The API is still accepting anonymous
requests at this point, so the old frontend works again immediately.

---

## Step 3 — Run a real session before closing the door

Use it for an actual session. You are checking that:

- the PIN screen comes up on a cold start;
- a bracelet tapped **at the PIN screen** does nothing — and no entry for it
  appears in the station audit;
- after signing in, taps and measurements behave exactly as before;
- the session is still alive at the end of the shift.

The setup screen will show a warning the whole time saying the API still
accepts requests with no login. That is true, and it goes away at step 4.

---

## Step 4 — Close the door

This is the step that actually turns the auth on.

1. **portal.azure.com** → **cvmeasurements-api** → **Settings** →
   **Environment variables**.
2. **+ Add**. **Name:** `AUTH_ENFORCE` — **Value:** `true`. Click **Apply**.
3. **Apply** at the bottom, then **Confirm**. Wait for the restart.
4. Reload `/api/health`: `"auth_enforced"` should now be `true`.
5. Open the station URL in a **private/incognito window**. You should get the
   PIN screen and be unable to get past it without the PIN.
6. The warning on the setup screen should be gone.

**To roll back**, change `AUTH_ENFORCE` to `false` and Apply. No deploy, no
merge, about ninety seconds. That is the entire reason the flag exists.

---

## Step 5 — Check-in's brute-force guard

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

## Step 6 — Take the scaffolding out (not urgent, don't skip)

Once step 4 has been stable for a few sessions, one more small change
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
| Browser console shows CORS errors | `ALLOWED_ORIGINS` does not exactly match the site's origin | Step 1 item 6. No trailing slash |
| Queue shows items "waiting for login" | Working as intended | They go out on the next sign-in |

One thing worth being clear about, because it is the question staff will ask:
**an expired session cannot lose a measurement.** Captures are written to the
device before anything is sent, a rejected session never marks one failed,
and they are sent as soon as somebody signs back in.
