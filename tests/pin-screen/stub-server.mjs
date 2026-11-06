/**
 * Stand-in for the station API, so the built app can be driven in a browser.
 *
 * Enforces the Bearer session the way the real server does with
 * AUTH_ENFORCE=true, because the point of the exercise is the behaviour when
 * a session is missing or has run out.
 */

import { createServer } from 'node:http'
import { readFile } from 'node:fs/promises'
import { extname, join } from 'node:path'

const DESK = '314159'
const ADMIN = '271828'
const DIST = new URL('./dist/', import.meta.url).pathname

const TYPES = {
  '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css',
  '.png': 'image/png', '.svg': 'image/svg+xml', '.json': 'application/json',
}

// Every API request the browser makes, so the test can assert on what was and
// was not called.
export const seen = []
let tokens = new Map()
let forceExpired = false

function json(res, code, body, headers = {}) {
  const text = JSON.stringify(body)
  res.writeHead(code, { 'Content-Type': 'application/json', ...headers })
  res.end(text)
}

function session(req) {
  const h = req.headers.authorization || ''
  if (!h.toLowerCase().startsWith('bearer ')) return null
  const t = h.slice(7).trim()
  if (forceExpired) return null
  return tokens.get(t) || null
}

function guard(req, res) {
  if (session(req)) return true
  json(res, 401, { detail: req.headers.authorization ? 'Session expired' : 'Log in with the station PIN' })
  return false
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x')
  const path = url.pathname

  if (path.startsWith('/api/')) {
    seen.push({ path, auth: !!req.headers.authorization })

    if (path === '/api/health') {
      return json(res, 200, {
        ok: true, database: 'new_lab_pipeline', database_error: null,
        station_code: 'cv_app', auth_enforced: true,
        pin_login_ready: true, pin_login_problems: [],
        station_key_enabled: false,
        login_guard: { tracked_addresses: 0, locked_out: 0, failures_in_window: 0, window_seconds: 900 },
        artifact_backend: 'stub', marker_sizes_cm: [12, 16, 20],
        lab_timezone: 'America/Denver', lab_date: '2026-11-06',
      })
    }

    if (path === '/api/login' && req.method === 'POST') {
      let body = ''
      for await (const c of req) body += c
      const { pin } = JSON.parse(body || '{}')
      const role = pin === ADMIN ? 'admin' : pin === DESK ? 'desk' : null
      if (!role) return json(res, 401, { detail: 'Wrong PIN' })
      const token = `tok-${role}-${Date.now()}`
      tokens.set(token, { role })
      forceExpired = false
      return json(res, 200, {
        token, role,
        expires_at: new Date(Date.now() + 8 * 3600 * 1000).toISOString(),
      })
    }

    if (path === '/api/me') {
      if (!guard(req, res)) return
      return json(res, 200, { role: session(req).role, expires_at: null })
    }

    // Test control, not part of the real API.
    if (path === '/api/__expire') { forceExpired = true; return json(res, 200, { ok: true }) }
    if (path === '/api/__seen') return json(res, 200, seen)
    if (path === '/api/__reset') { seen.length = 0; return json(res, 200, { ok: true }) }

    if (!guard(req, res)) return

    if (path === '/api/stations') return json(res, 200, [{ station_code: 'cv_app', label: 'CV app' }])
    if (path === '/api/event-sessions') return json(res, 200, [])
    if (path === '/api/station/audit') return json(res, 200, { counts: { taps: 0, measured: 0, gaps: 0 } })
    if (path === '/api/subject/resolve') {
      return json(res, 200, {
        ok: true, subject_id: 1, subject_token: 'TC-1234-5678',
        enrolled: true, first_capture: false, scan_event_id: 9,
      })
    }
    if (path === '/api/capture/save') {
      return json(res, 200, { capture_trial_id: 1, capture_session_id: 1, trial_number: 1 })
    }
    return json(res, 404, { detail: 'no stub for ' + path })
  }

  // static
  let file = path === '/' ? '/index.html' : path
  try {
    const buf = await readFile(join(DIST, file))
    res.writeHead(200, { 'Content-Type': TYPES[extname(file)] || 'application/octet-stream' })
    res.end(buf)
  } catch {
    const buf = await readFile(join(DIST, 'index.html'))
    res.writeHead(200, { 'Content-Type': 'text/html' })
    res.end(buf)
  }
})

server.listen(8099, () => console.log('stub on http://localhost:8099'))
