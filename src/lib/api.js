/**
 * API client for the station.
 *
 * Every request carries the PIN session as `Authorization: Bearer <token>`.
 * This replaced VITE_STATION_KEY, which was a build-time constant baked into
 * the bundle: readable by anyone who loaded the page, identical on every
 * station, and unchangeable without a redeploy.
 *
 * The one thing callers must handle is isAuthError(). A rejected session is
 * not a bad request — the data is fine and the same call will succeed once
 * someone logs back in. Treating it as permanent is how a queue loses a
 * shift of measurements, so it is classified here rather than at each call
 * site.
 */

import { authHeader, onUnauthorized } from './auth.js'

const BASE = import.meta.env.VITE_API_URL ?? ''

export class ApiError extends Error {
  constructor(message, status, body) {
    super(message)
    this.status = status
    this.body = body
  }
}

/** A rejected or expired session: retriable after a login, never permanent. */
export function isAuthError(err) {
  return err instanceof ApiError && (err.status === 401 || err.status === 403)
}

function headers(extra = {}) {
  return { ...extra, ...authHeader() }
}

async function parse(res) {
  const body = await res.json().catch(() => null)
  if (!res.ok) {
    if (res.status === 401) {
      // Drop the dead session so the app prompts for the PIN, instead of
      // every later request failing quietly in the background.
      onUnauthorized()
    }
    throw new ApiError(body?.detail || `Server error ${res.status}`, res.status, body)
  }
  return body
}

/** Requests that must not hang forever on a dead venue wifi connection. */
async function withTimeout(promise, ms, controller) {
  const timer = setTimeout(() => controller.abort(), ms)
  try {
    return await promise
  } finally {
    clearTimeout(timer)
  }
}

export async function postJson(path, payload, { timeoutMs = 15000 } = {}) {
  const controller = new AbortController()
  return withTimeout(
    fetch(`${BASE}${path}`, {
      method: 'POST',
      headers: headers({ 'Content-Type': 'application/json' }),
      body: JSON.stringify(payload),
      signal: controller.signal,
    }).then(parse),
    timeoutMs,
    controller,
  )
}

export async function getJson(path, { timeoutMs = 15000 } = {}) {
  const controller = new AbortController()
  return withTimeout(
    fetch(`${BASE}${path}`, { headers: headers(), signal: controller.signal }).then(parse),
    timeoutMs,
    controller,
  )
}

export async function postForm(path, formData, { timeoutMs = 60000 } = {}) {
  const controller = new AbortController()
  // Deliberately no Content-Type: the browser must set the multipart boundary.
  return withTimeout(
    fetch(`${BASE}${path}`, {
      method: 'POST',
      headers: headers(),
      body: formData,
      signal: controller.signal,
    }).then(parse),
    timeoutMs,
    controller,
  )
}

// ------------------------------------------------------------------ calls

export const resolveTap = (raw, { operator, deviceLabel }) =>
  postJson('/api/subject/resolve', {
    raw_value: raw,
    operator: operator || null,
    device_label: deviceLabel || null,
  }, { timeoutMs: 8000 })

export const saveCapture = (payload) =>
  postJson('/api/capture/save', payload, { timeoutMs: 20000 })

export const saveAdditional = (payload) =>
  postJson('/api/capture/additional', payload)

export const fetchHealth = () => getJson('/api/health', { timeoutMs: 6000 })
export const fetchStations = () => getJson('/api/stations')
export const fetchEventSessions = () => getJson('/api/event-sessions')
export const fetchAudit = (stationCode) =>
  getJson(`/api/station/audit${stationCode ? `?station_code=${encodeURIComponent(stationCode)}` : ''}`)

export function measure(blob, markerCm) {
  const fd = new FormData()
  fd.append('image', blob, blob.name || 'capture.jpg')
  fd.append('marker_cm', markerCm)
  return postForm('/api/measure', fd)
}

export function uploadPhoto({ blob, captureTrialId, captureSessionId, subjectToken, kind }) {
  const fd = new FormData()
  fd.append('image', blob, `${kind}.jpg`)
  fd.append('capture_trial_id', captureTrialId)
  fd.append('capture_session_id', captureSessionId)
  fd.append('subject_token', subjectToken)
  fd.append('kind', kind)
  return postForm('/api/capture/photo', fd)
}

// Public on purpose, and used as a plain href — it cannot carry a header.
export const markerPdfUrl = (cm) => `${BASE}/api/marker/${cm}/pdf`

/** Does this device still hold a usable session, as far as the server agrees? */
export const fetchMe = () => getJson('/api/me', { timeoutMs: 6000 })
