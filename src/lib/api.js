/**
 * API client for the station.
 *
 * Every request carries the station key. VITE_STATION_KEY is a build-time
 * value baked into the bundle, which means it is not a secret from anyone who
 * can open the app — it is a gate against the open internet, not against a
 * determined person holding the iPad. That is a deliberate step up from the
 * previous build, which had no auth of any kind and CORS set to "*", so
 * anyone with the URL could read the roster of any event by name.
 *
 * Rotate the key by redeploying both sides. Give each physical station its own
 * key so one can be revoked without touching the others.
 */

const BASE = import.meta.env.VITE_API_URL ?? ''
const STATION_KEY = import.meta.env.VITE_STATION_KEY ?? ''

export class ApiError extends Error {
  constructor(message, status, body) {
    super(message)
    this.status = status
    this.body = body
  }
}

function headers(extra = {}) {
  const h = { ...extra }
  if (STATION_KEY) h['X-Station-Key'] = STATION_KEY
  return h
}

async function parse(res) {
  const body = await res.json().catch(() => null)
  if (!res.ok) {
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

export const markerPdfUrl = (cm) => `${BASE}/api/marker/${cm}/pdf`
