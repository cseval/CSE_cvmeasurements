// Background sync — handoff invariant 2: "write locally first, sync
// second. Never block a staffer on a network round trip."
//
// Saves land in IndexedDB first. This module flushes the pending queue to
// the station API with retry + backoff, in the background, and exposes a
// status subscription for the UI badge.

import { allRecords, loadStationConfig, patchRecord } from './storage.js'

export function apiBase() {
  const cfg = loadStationConfig()
  if (cfg?.apiUrl) return String(cfg.apiUrl).replace(/\/+$/, '')
  return import.meta.env.VITE_API_URL || ''
}

export function isOnline() {
  return typeof navigator === 'undefined' ? true : navigator.onLine
}

async function api(path, body) {
  const cfg = loadStationConfig()
  const res = await fetch(`${apiBase()}${path}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(cfg?.apiToken ? { 'X-Station-Token': cfg.apiToken } : {}),
    },
    body: JSON.stringify(body),
  })
  if (!res.ok) {
    const detail = await res
      .json()
      .catch(() => ({}))
      .then((t) => t.detail)
    const err = new Error(detail || `API ${res.status}`)
    err.status = res.status
    throw err
  }
  return res.json()
}

// ── payload shaping (schema-agnostic contract — the adapter maps it) ──
export function captureApiPayload(rec) {
  const cfg = loadStationConfig() || {}
  return {
    batch_id: rec.id,
    trial_ref: rec.server_trial_ref || null,
    raw_uid: rec.raw_uid || null,
    prefix: rec.station?.readerPrefix ?? cfg.readerPrefix ?? '',
    station: {
      source_device: rec.station?.stationId ?? cfg.stationId,
      lab_location: rec.station?.labLocation ?? cfg.labLocation ?? null,
      event_session_id: rec.station?.eventSessionId ? Number(rec.station.eventSessionId) : null,
      operator: rec.station?.operator ?? cfg.operator ?? null,
      device_id: null,
    },
    capture: {
      trial_type: 'movement_screen',
      captured_at: rec.captured_at,
      marker_cm: rec.marker_cm,
      height_cm: rec.height_cm ?? null,
      wingspan_cm: rec.wingspan_cm ?? null,
      hand_width_cm: rec.hand_width_cm ?? null,
      method: rec.method || 'cv',
      validity: rec.validity ?? 1,
      notes: rec.notes || null,
      assessment: rec.assessment || {},
    },
  }
}

export function scanApiPayload(s) {
  return {
    raw_scan_value: s.raw,
    uid: s.uid || null,
    prefix: s.prefix ?? '',
    resolved: !!s.resolved,
    enrolled: s.enrolled ?? null,
    subject_key: s.subject_key || null,
    station: s.station || {},
    operator: s.operator ?? null,
    device_id: s.device_id ?? null,
    scanned_at: s.scanned_at,
    capture_batch_id: s.capture_batch_id || null,
  }
}

export const apiResolve = (uid, prefix = '') => api('/api/subject/resolve', { uid, prefix })

export async function sendCapture(rec) {
  const res = await api('/api/capture/save', captureApiPayload(rec))
  await patchRecord('captures', rec.id, {
    sync_status: 'synced',
    synced_at: new Date().toISOString(),
    server_trial_ref: res.trial_ref ?? rec.server_trial_ref ?? null,
    server_session_ref: res.session_ref ?? rec.server_session_ref ?? null,
    server_enrolled: res.enrolled ?? null,
    last_error: null,
  })
  return res
}

export async function sendScan(s) {
  const res = await api('/api/scan/log', scanApiPayload(s))
  await patchRecord('scans', s.id, {
    sync_status: 'synced',
    synced_at: new Date().toISOString(),
    last_error: null,
  })
  return res
}

// ── queue flush ────────────────────────────────────────────────────────
let flushing = false
const listeners = new Set()

export function subscribeSync(fn) {
  listeners.add(fn)
  return () => listeners.delete(fn)
}

function emit(status) {
  for (const fn of [...listeners]) {
    try {
      fn(status)
    } catch {
      /* a broken listener must never break the queue */
    }
  }
}

function backoff(attempts) {
  const base = 15_000
  const cap = 15 * 60_000
  return Math.min(cap, base * 2 ** Math.min(attempts || 0, 6))
}

async function pendingLists() {
  const [caps, scans] = await Promise.all([allRecords('captures'), allRecords('scans')])
  const now = Date.now()
  const ready = (r) => r.sync_status !== 'synced' && !(r.next_retry_at && now < r.next_retry_at)
  return {
    captures: caps.filter(ready).sort((a, b) => String(a.captured_at).localeCompare(String(b.captured_at))),
    scans: scans.filter(ready).sort((a, b) => String(a.scanned_at).localeCompare(String(b.scanned_at))),
    pending: caps.filter((r) => r.sync_status !== 'synced').length +
      scans.filter((r) => r.sync_status !== 'synced').length,
  }
}

export async function flushQueue() {
  if (flushing) return
  flushing = true
  try {
    if (!isOnline()) {
      emit({ state: 'offline', pending: (await pendingLists()).pending })
      return
    }
    let q = await pendingLists()
    if (!q.captures.length && !q.scans.length) {
      emit({ state: 'idle', pending: 0 })
      return
    }
    emit({ state: 'syncing', pending: q.pending })

    // Audit log first (a station that scanned but produced no data must
    // still show up), oldest first.
    for (const s of q.scans) {
      try {
        await sendScan(s)
      } catch (e) {
        await patchRecord('scans', s.id, {
          sync_status: 'failed',
          last_error: String(e.message || e),
          sync_attempts: (s.sync_attempts || 0) + 1,
          next_retry_at: Date.now() + backoff(s.sync_attempts),
        }).catch(() => {})
      }
    }

    for (const rec of q.captures) {
      try {
        await sendCapture(rec)
      } catch (e) {
        if (e.status === 404 && rec.server_trial_ref) {
          // Trial vanished server-side (DB reset?) — drop the ref and
          // recreate as a fresh trial rather than failing forever.
          await patchRecord('captures', rec.id, { server_trial_ref: null }).catch(() => {})
          try {
            await sendCapture({ ...rec, server_trial_ref: null })
            continue
          } catch {
            /* fall through to failure bookkeeping */
          }
        }
        await patchRecord('captures', rec.id, {
          sync_status: 'failed',
          last_error: String(e.message || e),
          sync_attempts: (rec.sync_attempts || 0) + 1,
          next_retry_at: Date.now() + backoff(rec.sync_attempts),
        }).catch(() => {})
      }
    }

    q = await pendingLists()
    emit({ state: q.pending ? 'pending' : 'idle', pending: q.pending })
  } finally {
    flushing = false
  }
}

let started = false
export function startAutoSync() {
  if (started) return
  started = true
  const tick = () => flushQueue()
  window.addEventListener('online', tick)
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) tick()
  })
  setInterval(tick, 30_000)
  tick()
}
