// Local-first persistence (handoff invariants: write locally first, sync
// second; no identity in a localStorage key or a filename).
//
//   localStorage — small station config (never identity, never measurements)
//   IndexedDB    — captures + scan log: the recoverable session data

const CONFIG_KEY = 'cvstation.config.v1'
const DB_NAME = 'cvstation'
const DB_VERSION = 1

export function loadStationConfig() {
  try {
    const raw = localStorage.getItem(CONFIG_KEY)
    if (!raw) return null
    const cfg = JSON.parse(raw)
    return {
      stationId: cfg.stationId ?? 'cv_app',
      labLocation: cfg.labLocation ?? '',
      eventSessionId: cfg.eventSessionId ?? '',
      operator: cfg.operator ?? '',
      markerCm: Number(cfg.markerCm) || 16,
      readerPrefix: cfg.readerPrefix ?? '',
      apiToken: cfg.apiToken ?? '',
      apiUrl: cfg.apiUrl ?? '',
      ...cfg,
    }
  } catch {
    return null
  }
}

export function saveStationConfig(cfg) {
  localStorage.setItem(CONFIG_KEY, JSON.stringify(cfg))
  return cfg
}

export function uuid() {
  if (globalThis.crypto?.randomUUID) return crypto.randomUUID()
  return 'id-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 10)
}

function openDb() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION)
    req.onupgradeneeded = () => {
      const db = req.result
      if (!db.objectStoreNames.contains('captures')) {
        db.createObjectStore('captures', { keyPath: 'id' })
      }
      if (!db.objectStoreNames.contains('scans')) {
        db.createObjectStore('scans', { keyPath: 'id' })
      }
    }
    req.onsuccess = () => resolve(req.result)
    req.onerror = () => reject(req.error)
  })
}

function reqToPromise(r) {
  return new Promise((resolve, reject) => {
    r.onsuccess = () => resolve(r.result)
    r.onerror = () => reject(r.error)
  })
}

export async function putRecord(store, value) {
  const db = await openDb()
  return reqToPromise(db.transaction(store, 'readwrite').objectStore(store).put(value))
}

export async function getRecord(store, key) {
  const db = await openDb()
  return reqToPromise(db.transaction(store, 'readonly').objectStore(store).get(key))
}

export async function patchRecord(store, key, patch) {
  const current = await getRecord(store, key)
  const next = { ...(current || { id: key }), ...patch }
  return putRecord(store, next)
}

export async function allRecords(store) {
  const db = await openDb()
  return reqToPromise(db.transaction(store, 'readonly').objectStore(store).getAll())
}
