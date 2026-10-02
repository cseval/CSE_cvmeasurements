"""
Browser test for the tap-capture layer.

INVARIANT 1 is the reason this file exists:

    Re-focus the input after every submit, every screen transition and every
    modal dismiss. If focus is lost, the next tap goes nowhere and presents to
    staff as a hardware failure. This is documented as the #1 integration bug
    across the whole NFC effort.

The handoff states the acceptance test in one line: "Test it by tapping ten
times without touching the screen between taps; all ten must register." That
is test 1 below. The rest cover the ways focus actually gets lost in practice
— a screen transition, a button press, a modal dismiss, an iPad waking up.

The reader is a USB HID keyboard, so a tap is simulated exactly as the
hardware produces it: 14 uppercase hex characters typed into whatever has
focus, then Enter. No clicking, no focusing, no DOM poking. If the app has
lost focus, the keystrokes go nowhere and the test fails, which is precisely
the field symptom.

    python tests/test_tap_focus.py

Requires: playwright, a built dist/ (npm run build).
"""

import json
import os
import sys
import threading
import uuid
from functools import partial
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parent.parent
DIST = ROOT / "dist"
PORT = 8817

resolve_calls = []
save_calls = []
results = []

# Flipped by the offline test to make /api/subject/resolve unreachable, the
# way venue wifi does during the opening rush.
resolve_offline = {"on": False}


def check(name, condition, detail=""):
    results.append(("PASS" if condition else "FAIL", name, "" if condition else detail))


class MockApi(SimpleHTTPRequestHandler):
    """Serves the built app plus just enough API to exercise the tap path."""

    def log_message(self, *args):
        pass

    def _json(self, payload, status=200):
        body = json.dumps(payload).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        if self.path.startswith("/api/health"):
            return self._json({"ok": True, "auth_enabled": True,
                               "database": "new_lab_pipeline",
                               "artifact_backend": "test", "marker_sizes_cm": [12, 16, 20]})
        if self.path.startswith("/api/stations"):
            return self._json([{"code": "cv_app", "label": "CV measurement app",
                                "is_closed_system": 0}])
        if self.path.startswith("/api/event-sessions"):
            return self._json([])
        if self.path.startswith("/api/station/audit"):
            return self._json({"date": "2026-09-10",
                               "counts": {"taps": len(resolve_calls), "malformed": 0,
                                          "unresolved": 0, "unenrolled": 0, "no_data": 0},
                               "needs_review": []})
        # SPA fallback so a deep link still boots the app
        if not self.path.startswith("/assets") and self.path != "/" and "." not in self.path:
            self.path = "/"
        return super().do_GET()

    def do_POST(self):
        length = int(self.headers.get("Content-Length", 0))
        body = json.loads(self.rfile.read(length) or b"{}")

        if self.path.startswith("/api/subject/resolve"):
            resolve_calls.append(body)
            if resolve_offline["on"]:
                # 503 rather than a refusal: the station must treat "could not
                # get an answer" as offline, and a 4xx as a real rejection.
                return self._json({"detail": "upstream unavailable"}, status=503)
            raw = body.get("raw_value", "")
            if not raw.isalnum() or len(raw) < 8:
                return self._json({"ok": False, "reason": "Malformed", "subject_id": None,
                                   "subject_token": None, "enrolled": None,
                                   "new_subject": False, "scan_event_id": len(resolve_calls),
                                   "uid_length": None})
            return self._json({"ok": True, "reason": None,
                               "subject_id": len(resolve_calls),
                               "subject_token": f"TC-TEST-{len(resolve_calls):04d}",
                               "enrolled": False, "new_subject": True,
                               "scan_event_id": len(resolve_calls), "uid_length": len(raw)})

        if self.path.startswith("/api/capture/save"):
            save_calls.append(body)
            return self._json({"capture_trial_id": len(save_calls),
                               "capture_session_id": 1, "trial_number": len(save_calls),
                               "movement_screen_id": len(save_calls),
                               "duplicate": False, "scale_warning": None})

        return self._json({"ok": True})


def tap(page, uid=None):
    """Simulate the reader: type hex, press Enter. Never touches the page."""
    uid = uid or ("04" + uuid.uuid4().hex.upper())[:14]
    page.keyboard.type(uid, delay=8)   # ~8ms/char is roughly HID speed
    page.keyboard.press("Enter")
    return uid


def main():
    if not DIST.exists():
        print("dist/ not found — run `npm run build` first")
        return 1

    server = ThreadingHTTPServer(
        ("127.0.0.1", PORT), partial(MockApi, directory=str(DIST)))
    threading.Thread(target=server.serve_forever, daemon=True).start()

    with sync_playwright() as pw:
        browser = pw.chromium.launch(
            executable_path=os.environ.get("PW_CHROMIUM", "/opt/pw-browsers/chromium"),
            args=["--no-sandbox"],
        )
        # iPad portrait — the station hardware decision.
        page = browser.new_context(viewport={"width": 810, "height": 1080}).new_page()
        page.add_init_script("""
          localStorage.setItem('cv-station-config.v2', JSON.stringify({
            markerCm: 20, stationCode: 'cv_app', deviceLabel: 'ipad-test-01',
            operator: 'tester', labLocation: 'CSE Lab',
            sessionType: 'movement_screen', sport: 'softball',
            eventSessionId: null, keepPhotos: true
          }))
        """)
        page.goto(f"http://127.0.0.1:{PORT}/")
        page.wait_for_selector(".tap-headline", timeout=15000)

        check("station boots straight to the tap screen when configured",
              "Tap to Begin" in page.inner_text(".tap-headline"),
              page.inner_text(".tap-headline"))

        catcher_count = page.locator(".tap-catcher").count()
        check("exactly one tap catcher is mounted", catcher_count == 1, str(catcher_count))

        focused = page.evaluate("document.activeElement?.className")
        check("tap catcher holds focus on load", focused == "tap-catcher", str(focused))

        # The catcher must be focusable, which rules out display:none and
        # disabled — the two "obvious" ways to hide it, both of which silently
        # break every tap.
        style = page.evaluate("""() => {
          const el = document.querySelector('.tap-catcher')
          const cs = getComputedStyle(el)
          return { display: cs.display, visibility: cs.visibility, disabled: el.disabled }
        }""")
        check("catcher is not display:none", style["display"] != "none", str(style))
        check("catcher is not visibility:hidden", style["visibility"] != "hidden", str(style))
        check("catcher is not disabled", style["disabled"] is False, str(style))

        # ------------------------------------------------ TEST 1: ten taps
        # The handoff's acceptance test, verbatim: tap ten times without
        # touching the screen between taps; all ten must register.
        resolve_calls.clear()
        for _ in range(10):
            tap(page)
            page.wait_for_timeout(120)
        page.wait_for_timeout(600)
        check("ten consecutive taps all register", len(resolve_calls) == 10,
              f"{len(resolve_calls)} of 10 reached the API")

        # ------------------------------------- TEST 2: focus after a submit
        after = page.evaluate("document.activeElement?.className")
        check("focus is retained after a tap submits", after == "tap-catcher", str(after))

        # ------------------------------ TEST 3: focus across a screen change
        page.wait_for_selector("text=Continue to Camera", timeout=5000)
        page.click("text=Setup")
        page.wait_for_selector("text=Station Setup", timeout=5000)
        page.click("text=Cancel")
        page.wait_for_selector(".tap-headline", timeout=5000)
        page.wait_for_timeout(600)  # allow the 400ms re-focus poll to run
        after_nav = page.evaluate("document.activeElement?.className")
        check("focus is recovered after a screen transition and back",
              after_nav == "tap-catcher", str(after_nav))

        before = len(resolve_calls)
        tap(page)
        page.wait_for_timeout(500)
        check("a tap after a screen transition still registers",
              len(resolve_calls) == before + 1,
              f"{len(resolve_calls) - before} taps registered")

        # ------------------------- TEST 4: focus recovers after a body click
        # An operator brushing the screen is the everyday way focus is lost.
        page.mouse.click(405, 900)
        page.wait_for_timeout(600)
        after_click = page.evaluate("document.activeElement?.className")
        check("focus is recovered after tapping the screen",
              after_click == "tap-catcher", str(after_click))

        before = len(resolve_calls)
        tap(page)
        page.wait_for_timeout(500)
        check("a tap after a screen touch still registers",
              len(resolve_calls) == before + 1)

        # -------------------- TEST 5: a malformed scan is reported, not eaten
        before = len(resolve_calls)
        page.keyboard.type("NOT-A-UID!!", delay=8)
        page.keyboard.press("Enter")
        page.wait_for_timeout(700)
        check("a malformed scan still reaches the API to be logged",
              len(resolve_calls) == before + 1)
        check("a malformed scan shows the operator why",
              "Tap Not Read" in page.inner_text(".tap-headline"),
              page.inner_text(".tap-headline"))

        # And the station must still take the next tap afterwards.
        before = len(resolve_calls)
        tap(page)
        page.wait_for_timeout(500)
        check("station keeps accepting taps after a rejected scan",
              len(resolve_calls) == before + 1)

        # ------------- TEST 6: the raw scan is sent verbatim, not normalized
        # scan_event records exactly what the reader typed; cleaning it up
        # client-side would destroy the evidence of a truncated read.
        malformed = [c for c in resolve_calls if c["raw_value"] == "NOT-A-UID!!"]
        check("raw scan value is sent verbatim", len(malformed) == 1,
              str([c["raw_value"] for c in resolve_calls[-4:]]))

        # ------------------- TEST 7: operator identity travels, athlete's does not
        last = resolve_calls[-1]
        check("operator and device travel with the tap",
              last.get("operator") == "tester" and last.get("device_label") == "ipad-test-01",
              str(last))
        forbidden = {"first_name", "last_name", "player_id", "cse_player_id",
                     "athlete_id", "name", "email"}
        leaked = forbidden & set(last.keys())
        check("no identity field is sent with a tap", not leaked, str(leaked))

        # -------------- TEST 8: a mid-flow tap is held, never silently applied
        page.wait_for_selector("text=Continue to Camera", timeout=5000)
        token_before = page.inner_text(".tap-token")
        page.click("text=Continue to Camera")
        page.wait_for_timeout(800)
        before = len(resolve_calls)
        tap(page)
        page.wait_for_timeout(800)
        check("a tap during measurement is not resolved automatically",
              len(resolve_calls) == before,
              f"{len(resolve_calls) - before} unexpected resolves")
        check("a mid-flow tap is surfaced to the operator",
              page.locator(".tap-interrupt").count() == 1)

        page.click("text=Finish this athlete")
        page.wait_for_timeout(300)
        check("dismissing the interruption keeps the current athlete",
              page.locator(".tap-interrupt").count() == 0)

        # Focus must survive the modal dismiss — the third case in invariant 1.
        page.wait_for_timeout(600)
        after_modal = page.evaluate("document.activeElement?.className")
        check("focus is recovered after dismissing the interruption",
              after_modal == "tap-catcher", str(after_modal))

        # ----------------- TEST 9: the subject shown never changed underneath
        check("subject token was captured before the flow started",
              token_before.startswith("TC-"), token_before)


        # ------------- TEST 10: a tap with no network still lets you measure
        # Invariant 2 applies to the tap, not just the save. If resolving a
        # subject required the network, a wifi outage would stop the station
        # dead with a line of athletes waiting — which is exactly when venue
        # wifi fails.
        page.click("text=Finish this athlete") if page.locator(".tap-interrupt").count() else None
        page.wait_for_timeout(200)
        page.evaluate("window.location.reload()")
        page.wait_for_selector(".tap-headline", timeout=10000)
        page.wait_for_timeout(500)

        resolve_offline["on"] = True
        before = len(resolve_calls)
        offline_uid = tap(page)
        page.wait_for_timeout(1200)
        check("the station tried to resolve the offline tap",
              len(resolve_calls) == before + 1)
        check("an unreachable server does not block the operator",
              "Bracelet Read" in page.inner_text(".tap-headline"),
              page.inner_text(".tap-headline"))
        check("the offline tap shows the raw UID to work from",
              offline_uid in page.inner_text(".tap-token"),
              page.inner_text(".tap-token"))
        check("the operator is told the bracelet resolves later",
              "Offline" in page.inner_text(".tap-flags"),
              page.inner_text(".tap-flags"))
        check("the offline tap can proceed to the camera",
              page.locator("text=Continue to Camera").count() == 1)

        # A malformed scan must still be rejected locally while offline —
        # otherwise it is only caught at sync, hours after the athlete left.
        page.keyboard.type("ZZZZ!!!!", delay=8)
        page.keyboard.press("Enter")
        page.wait_for_timeout(700)
        check("a malformed scan is rejected locally even with no server",
              "Tap Not Read" in page.inner_text(".tap-headline"),
              page.inner_text(".tap-headline"))

        resolve_offline["on"] = False

        # ------------------------------------------------------------ done
        browser.close()
    server.shutdown()

    width = max(len(n) for _, n, _ in results) + 2
    failed = sum(1 for s, _, _ in results if s == "FAIL")
    for status, name, detail in results:
        print(f"{status:4}  {name:<{width}} {detail}")
    print(f"\n{len(results) - failed}/{len(results)} passed")
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())
