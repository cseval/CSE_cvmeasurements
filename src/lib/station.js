/**
 * Station configuration — set once per shift, persisted so a reload or an
 * iPad sleep/wake does not cost the operator the setup.
 *
 * Deliberately localStorage, not IndexedDB: it is a handful of small values
 * read synchronously on first render, and the queue's IndexedDB store is for
 * the thing that must not be lost.
 *
 * Nothing here identifies an athlete. `operator` is staff — a person running
 * the station, not a subject of capture — which is the same distinction
 * capture_session.operator makes.
 */

const KEY = 'cv-station-config.v2'

export const MARKER_SIZES = [12, 16, 20]

export const DEFAULT_CONFIG = {
  markerCm: 20,
  stationCode: 'cv_app',
  deviceLabel: '',
  operator: '',
  labLocation: '',
  sessionType: 'movement_screen',
  sport: 'softball',
  eventSessionId: null,
  keepPhotos: true,
}

export function loadConfig() {
  try {
    const raw = localStorage.getItem(KEY)
    if (!raw) return { ...DEFAULT_CONFIG }
    const parsed = JSON.parse(raw)
    const merged = { ...DEFAULT_CONFIG, ...parsed }
    // A marker size that is not one we publish a printable PDF for would make
    // every measurement in the shift wrong by a constant factor, so refuse to
    // load a stale or hand-edited value.
    if (!MARKER_SIZES.includes(Number(merged.markerCm))) {
      merged.markerCm = DEFAULT_CONFIG.markerCm
    }
    return merged
  } catch {
    return { ...DEFAULT_CONFIG }
  }
}

export function saveConfig(config) {
  try {
    localStorage.setItem(KEY, JSON.stringify(config))
  } catch {
    // Private browsing, or storage full. The app still works for this
    // session; the operator just re-enters setup after a reload.
  }
  return config
}

export function clearConfig() {
  try { localStorage.removeItem(KEY) } catch { /* nothing to do */ }
}

/** Setup is complete enough to start taking taps. */
export function isConfigured(config) {
  return Boolean(
    config &&
    MARKER_SIZES.includes(Number(config.markerCm)) &&
    config.stationCode &&
    config.operator?.trim()
  )
}
