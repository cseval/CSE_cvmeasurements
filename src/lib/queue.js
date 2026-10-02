/**
 * Local-first capture queue.
 *
 * INVARIANT 2:
 *
 *     Write locally first, sync second. Never block a staffer on a network
 *     round trip with a line of athletes in front of them. Lab and venue wifi
 *     fails during the opening rush, reliably.
 *
 * So Save writes to IndexedDB and returns. A background worker drains the
 * queue to the API with backoff, and the header shows a pending count. If the
 * backend is unreachable for the entire shift, exportCsv() recovers every
 * measurement from the device.
 *
 * Idempotency is the whole reason this is safe: every record carries a
 * client_ref minted here, before the first send attempt, and
 * capture_trial.client_ref is UNIQUE. A request that times out after the
 * server committed gets retried, and the retry returns the original trial
 * instead of creating a duplicate. Without that, "write locally and retry"
 * would double-record an athlete every time wifi dropped mid-request.
 *
 * On identity (invariant 3): nothing here holds a name, a cse_player_id or a
 * raw tag UID. Records key off client_ref and carry the opaque subject_token,
 * which is exactly what the whole schema is arranged to allow.
 */

import { ApiError, saveAdditional, saveCapture, uploadPhoto } from './api.js'

const DB_NAME = 'cv-station'
const DB_VERSION = 1
const STORE = 'captures'

const RETRY_BASE_MS = 4000
const RETRY_MAX_MS = 5 * 60 * 1000
const MAX_ATTEMPTS = 200   // ~a full shift of retries, then it waits for a human

let dbPromise = null
const listeners = new Set()

function openDb() {
  if (dbPromise) return dbPromise
  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION)
    req.onupgradeneeded = () => {
      const db = req.result
      if (!db.objectStoreNames.contains(STORE)) {
        const store = db.createObjectStore(STORE, { keyPath: 'client_ref' })
        store.createIndex('status', 'status')
        store.createIndex('created_at', 'created_at')
      }
    }
    req.onsuccess = () => resolve(req.result)
    req.onerror = () => reject(req.error)
  })
  return dbPromise
}

function tx(mode, fn) {
  return openDb().then(db => new Promise((resolve, reject) => {
    const t = db.transaction(STORE, mode)
    const store = t.objectStore(STORE)
    let result
    try { result = fn(store) } catch (err) { reject(err); return }
    t.oncomplete = () => resolve(result)
    t.onerror = () => reject(t.error)
    t.onabort = () => reject(t.error)
  }))
}

function req(request) {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error)
  })
}

export function newClientRef() {
  // crypto.randomUUID is unavailable on http origins in some older WebKit
  // builds, and the station runs behind a self-signed cert in dev.
  if (globalThis.crypto?.randomUUID) return `cv-${crypto.randomUUID()}`
  const rand = Array.from({ length: 4 },
    () => Math.random().toString(36).slice(2, 10)).join('')
  return `cv-${Date.now().toString(36)}-${rand}`
}

function notify() {
  getStats().then(stats => listeners.forEach(fn => {
    try { fn(stats) } catch { /* a broken listener must not stall the queue */ }
  }))
}

export function subscribe(fn) {
  listeners.add(fn)
  notify()
  return () => listeners.delete(fn)
}

// ------------------------------------------------------------------ enqueue

/**
 * Persist one capture locally and kick the sync worker. Resolves as soon as
 * the local write lands — never awaits the network.
 *
 * @param {object} capture
 * @param {object} capture.payload      the /api/capture/save body
 * @param {string} capture.subjectToken opaque, for photo naming
 * @param {Array<{kind: string, blob: Blob}>} capture.photos
 * @param {object} capture.display      measurement values, for CSV recovery
 */
export async function enqueue({ payload, subjectToken, photos = [], display = {} }) {
  const record = {
    client_ref: payload.client_ref,
    status: 'pending',
    payload,
    subject_token: subjectToken,
    photos,
    display,
    created_at: new Date().toISOString(),
    attempts: 0,
    last_error: null,
    result: null,
    next_attempt_at: 0,
  }
  await tx('readwrite', store => store.put(record))
  notify()
  flush()
  return record
}

/**
 * Attach the manually-measured assessment fields to a queued record.
 *
 * These arrive on a later screen, so by now the capture may already have
 * synced. Re-arming the record to 'pending' is what makes the second phase
 * get sent: syncOne skips a capture it has already written and posts only the
 * outstanding part.
 */
export async function attachAdditional(clientRef, fields) {
  const existing = await tx('readonly', store => req(store.get(clientRef)))
  if (!existing) return
  await tx('readwrite', store => store.put({
    ...existing,
    additional: { ...(existing.additional || {}), ...fields },
    additional_synced: false,
    status: existing.status === 'stalled' ? 'stalled' : 'pending',
    next_attempt_at: 0,
  }))
  notify()
  flush()
}

export async function getStats() {
  const all = await tx('readonly', store => req(store.getAll()))
  return {
    total: all.length,
    pending: all.filter(r => r.status === 'pending').length,
    synced: all.filter(r => r.status === 'synced').length,
    stalled: all.filter(r => r.status === 'stalled').length,
    oldestPending: all
      .filter(r => r.status === 'pending')
      .map(r => r.created_at)
      .sort()[0] ?? null,
  }
}

export async function getAll() {
  return tx('readonly', store => req(store.getAll()))
}

// --------------------------------------------------------------------- sync

let flushing = false
let timer = null

function backoff(attempts) {
  return Math.min(RETRY_BASE_MS * 2 ** Math.min(attempts, 7), RETRY_MAX_MS)
}

/**
 * Drain pending records. Safe to call at any time and from anywhere; a second
 * concurrent call is a no-op.
 */
export async function flush() {
  if (flushing) return
  flushing = true
  try {
    const all = await tx('readonly', store => req(store.getAll()))
    const now = Date.now()
    const due = all.filter(r =>
      r.status === 'pending' && (r.next_attempt_at ?? 0) <= now)

    for (const record of due) {
      await syncOne(record)
    }
  } catch {
    // An IndexedDB failure here must not take the app down — the operator is
    // mid-measurement. The next tick tries again.
  } finally {
    flushing = false
    notify()
    schedule()
  }
}

/**
 * Send whatever part of a record has not landed yet.
 *
 * Three phases, each independently skippable, because they arrive at
 * different times and fail for different reasons:
 *
 *   1. the capture itself      — required; nothing else can proceed without it
 *   2. the photos              — best-effort
 *   3. the assessment fields   — attached later, from the next screen
 *
 * A record that has already written its trial never writes it again, even
 * across a browser restart, because `result` is persisted.
 */
async function syncOne(record) {
  const attempts = (record.attempts ?? 0) + 1
  // Declared out here so the catch below can persist partial progress. If the
  // trial was written and only the assessment fields failed, forgetting the
  // result would make the next retry write the trial a second time — the
  // client_ref uniqueness check would catch it, but the record would lose the
  // ids it needs.
  let result = record.result ?? null
  try {
    // --- phase 1: the trial
    if (!result) result = await saveCapture(record.payload)

    // --- phase 2: photos. Deliberately after the measurement — a photo that
    // will not upload must not keep the measurement in the queue.
    //
    // A capture taken offline has no subject token yet: the server minted one
    // while resolving the held raw UID, and hands it back on the save. Photo
    // filenames are built from that token, so take the server's answer when
    // the local record has none.
    const subjectToken = record.subject_token ?? result.subject_token ?? null
    const photoErrors = [...(record.photo_errors ?? [])]
    for (const photo of record.photos ?? []) {
      try {
        await uploadPhoto({
          blob: photo.blob,
          captureTrialId: result.capture_trial_id,
          captureSessionId: result.capture_session_id,
          subjectToken,
          kind: photo.kind,
        })
      } catch (err) {
        photoErrors.push(`${photo.kind}: ${err.message}`)
      }
    }

    // --- phase 3: the assessment fields, if the operator entered any
    let additionalSynced = record.additional_synced ?? null
    if (record.additional && !additionalSynced) {
      if (!result.movement_screen_id) {
        throw new ApiError(
          'Capture has no movement_screen_id to attach assessment fields to',
          500, null,
        )
      }
      await saveAdditional({
        movement_screen_id: result.movement_screen_id,
        ...record.additional,
      })
      additionalSynced = true
    }

    await tx('readwrite', store => store.put({
      ...record,
      status: 'synced',
      attempts,
      result,
      subject_token: subjectToken,
      additional_synced: additionalSynced,
      // Drop the blobs once uploaded. A shift of full-resolution photos will
      // fill the origin's storage quota and start failing local writes, which
      // would break the one guarantee this queue makes.
      photos: [],
      photo_errors: photoErrors.length ? photoErrors : null,
      last_error: null,
    }))
    return true
  } catch (err) {
    // A 4xx other than 408/429 will never succeed on retry — a malformed
    // payload or a rejected station key. Park it for a human instead of
    // hammering the API for the rest of the shift.
    const permanent = err instanceof ApiError &&
      err.status >= 400 && err.status < 500 &&
      err.status !== 408 && err.status !== 429

    const stalled = permanent || attempts >= MAX_ATTEMPTS
    await tx('readwrite', store => store.put({
      ...record,
      result,                       // keep whatever phase 1 achieved
      status: stalled ? 'stalled' : 'pending',
      attempts,
      last_error: err.message,
      next_attempt_at: Date.now() + backoff(attempts),
    }))
    return false
  }
}

function schedule() {
  if (timer) clearTimeout(timer)
  timer = setTimeout(flush, RETRY_BASE_MS)
}

export function startSync() {
  flush()
  window.addEventListener('online', flush)
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) flush()
  })
  return () => {
    window.removeEventListener('online', flush)
    if (timer) clearTimeout(timer)
  }
}

/** Force a retry of everything parked, after a human has fixed the cause. */
export async function retryStalled() {
  const all = await tx('readonly', store => req(store.getAll()))
  for (const record of all.filter(r => r.status === 'stalled')) {
    await tx('readwrite', store => store.put({
      ...record, status: 'pending', attempts: 0, next_attempt_at: 0,
    }))
  }
  notify()
  return flush()
}

// ------------------------------------------------------------------- export

const CSV_COLUMNS = [
  'client_ref', 'status', 'created_at', 'subject_token', 'trial_number',
  'capture_trial_id', 'height_cm', 'wingspan_cm', 'hand_span_cm',
  'measurement_method', 'marker_cm', 'px_per_cm', 'operator', 'lab_location',
  'age_years', 'weight_lb', 'hip_er_r', 'hip_ir_r', 'hip_er_l', 'hip_ir_l',
  'tspine_rot_l', 'tspine_rot_r', 'grip_str_r', 'grip_str_l',
  'scale_warning', 'last_error',
]

function csvCell(value) {
  if (value === null || value === undefined) return ''
  return `"${String(value).replace(/"/g, '""')}"`
}

/**
 * Recover a whole shift from the device.
 *
 * This is the last line of defence: if the backend was unreachable all day,
 * this file is the measurements. It carries subject_token, not a name — so
 * reconciling it to athletes means joining through nfc_tag_assignment, exactly
 * like everything else.
 */
export async function exportCsv() {
  const all = (await getAll()).sort((a, b) => a.created_at.localeCompare(b.created_at))
  const rows = [CSV_COLUMNS.join(',')]

  for (const r of all) {
    const flat = {
      client_ref: r.client_ref,
      status: r.status,
      created_at: r.created_at,
      subject_token: r.subject_token,
      trial_number: r.result?.trial_number,
      capture_trial_id: r.result?.capture_trial_id,
      ...r.payload,
      ...(r.additional || {}),
      scale_warning: r.result?.scale_warning,
      last_error: r.last_error,
    }
    rows.push(CSV_COLUMNS.map(c => csvCell(flat[c])).join(','))
  }

  const csv = rows.join('\n')
  const blob = new Blob([csv], { type: 'text/csv;charset=utf-8' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = `cv-station-${new Date().toISOString().slice(0, 10)}.csv`
  document.body.appendChild(a)
  a.click()
  a.remove()
  setTimeout(() => URL.revokeObjectURL(url), 5000)
  return all.length
}

/**
 * Clear synced records. Never clears pending or stalled ones — those are the
 * only copy of a measurement that has not reached the database.
 */
export async function clearSynced() {
  const all = await tx('readonly', store => req(store.getAll()))
  const synced = all.filter(r => r.status === 'synced')
  await tx('readwrite', store => {
    synced.forEach(r => store.delete(r.client_ref))
  })
  notify()
  return synced.length
}
