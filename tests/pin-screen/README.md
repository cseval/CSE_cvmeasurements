# Driving the PIN screen in a browser

The on-screen keyboard has twice compiled, passed review and still been broken
at runtime — once because an effect's cleanup ran on every render and closed
the keyboard on the same render that opened it. Nothing caught it except
pressing the keys. So the PIN screen gets driven, not just unit-tested.

`stub-server.mjs` stands in for the station API with `AUTH_ENFORCE=true`, and
serves the built app from `dist/` on the same origin, so the bundle's
`VITE_API_URL` must be empty for the requests to come back to it.

```bash
npm install
VITE_API_URL= npx vite build

node tests/pin-screen/stub-server.mjs &      # http://localhost:8099
node tests/pin-screen/drive.mjs
```

Playwright is not a devDependency on purpose: installing it downloads browsers,
and this package is built on Vercel. Install it when you want to run this:

```bash
npm i -D playwright && npx playwright install chromium
```

What it checks, in order: the app opens locked; the reader stays attached while
signed out but a tap resolves nothing; the keypad opens and *stays* open after
a keypress; the PIN is masked both in the field and in the keypad's own preview
strip; a wrong PIN is refused and cleared; the right one gets in; the stored
session contains no PIN; a tap after login resolves and carries the session;
an expired session returns to the PIN screen.

The masked-preview check exists because the first version masked only the
field. The keypad panel echoed the PIN in plain text, directly under the
operator's thumb, and every assertion passed. It was found by looking at a
screenshot.
