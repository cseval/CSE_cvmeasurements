/**
 * Station session: the shared 6-digit PIN login.
 *
 * Replaces VITE_STATION_KEY, which was a build-time constant baked into the
 * bundle — readable by anyone who loaded the page, and unchangeable without a
 * redeploy. A PIN session is held per device, expires on its own, and is
 * revoked for everyone by changing the PIN.
 *
 * Deliberately dependency-free. api.js imports this to attach the header, so
 * anything this imported from api.js would be a cycle; the one call it makes
 * is written out by hand.
 *
 * What is stored, and why it is safe to store: a signed token carrying a role
 * and an expiry, nothing else. No name, no PIN, no identity of any kind. The
 * PIN itself is never written anywhere — it is posted once and discarded.
 */

const BASE = import.meta.env.VITE_API_URL ?? ''
const KEY = 'cv-station-session'

const listeners = new Set()
let session = read()

function read() {
  try {
    const raw = localStorage.getItem(KEY)
    if (!raw) return null
    const s = JSON.parse(raw)
    if (!s?.token || !s?.expires_at) return null
    return s
  } catch {
    // Private mode, cleared site data, or a half-written value. Treat an
    // unreadable session as no session rather than taking the app down.
    return null
  }
}

function write(value) {
  session = value
  try {
    if (value) localStorage.setItem(KEY, JSON.stringify(value))
    else localStorage.removeItem(KEY)
  } catch { /* storage unavailable: the session still works for this tab */ }
  listeners.forEach(fn => { try { fn(value) } catch { /* ignore */ } })
}

/** Subscribe to login/logout/expiry. Fires immediately with current state. */
export function subscribe(fn) {
  listeners.add(fn)
  try { fn(session) } catch { /* ignore */ }
  return () => listeners.delete(fn)
}

export function getSession() {
  return session
}

export function expiresAt() {
  return session?.expires_at ? new Date(session.expires_at).getTime() : 0
}

/**
 * Is there a session that is still good right now?
 *
 * Checked against the device clock, which is the same clock that asked for
 * the expiry in the first place. A minute of slack absorbs the case where the
 * token dies mid-request: better to prompt for the PIN a moment early than to
 * send a request that is certain to 401.
 */
export function isLoggedIn() {
  return !!session?.token && expiresAt() > Date.now() + 60_000
}

export function role() {
  return isLoggedIn() ? session.role : null
}

export function authHeader() {
  return session?.token ? { Authorization: `Bearer ${session.token}` } : {}
}

/** The device's own end of today, so a session dies at local midnight. */
function endOfToday() {
  const d = new Date()
  d.setHours(23, 59, 59, 999)
  return d.toISOString()
}

/**
 * Exchange a PIN for a session. Throws with a readable message on a bad PIN.
 * The PIN is not stored, logged, or retained after this call returns.
 */
export async function login(pin) {
  const res = await fetch(`${BASE}/api/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ pin, expires_at: endOfToday() }),
  })
  const body = await res.json().catch(() => null)
  if (!res.ok) {
    const err = new Error(body?.detail || `Login failed (${res.status})`)
    err.status = res.status
    throw err
  }
  write({ token: body.token, role: body.role, expires_at: body.expires_at })
  return body
}

export function logout() {
  write(null)
}

/**
 * Called by api.js when the server rejects a session.
 *
 * Clearing it here is what turns a 401 into a visible "log in again" prompt
 * instead of every subsequent request failing silently in the background.
 */
export function onUnauthorized() {
  if (session) write(null)
}
