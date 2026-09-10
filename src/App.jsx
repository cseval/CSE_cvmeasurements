import { useCallback, useEffect, useState } from 'react'
import Camera from './components/Camera.jsx'
import Results from './components/Results.jsx'
import Instructions from './components/Instructions.jsx'
import AdditionalInfo from './components/AdditionalInfo.jsx'
import IdleScreen from './components/IdleScreen.jsx'
import StationSetup from './components/StationSetup.jsx'
import TapCatcher from './components/TapCatcher.jsx'
import { allRecords, loadStationConfig, putRecord, uuid } from './lib/storage.js'
import { apiResolve, flushQueue, isOnline, startAutoSync, subscribeSync } from './lib/sync.js'
import './App.css'
import './App.nfc.css'

/**
 * Screen state machine (handoff §3.2 target flow):
 *
 *   setup (once per shift)
 *     → idle "TAP TO BEGIN"  ← the reader is armed here; hidden input focused
 *        → camera            (athlete tapped / test mode)
 *           → results        (measure / adjust / manual / save-local-first)
 *              → additional  (same capture record, same server trial)
 *                 → idle     (ready for the next tap — there is no roster)
 *
 * The TapCatcher is mounted once, OUTSIDE this switch, so no screen
 * transition can ever take the tap listener off the reader (invariant 1).
 */
export default function App() {
  const [firstRun] = useState(() => !loadStationConfig())
  const [screen, setScreen] = useState(() => (loadStationConfig() ? 'idle' : 'setup'))
  const [cfg, setCfg] = useState(() => loadStationConfig())

  const [subject, setSubject] = useState(null)   // {uid, raw, subject_key, enrolled, test?}
  const [markerSize, setMarkerSize] = useState(20)
  const [processing, setProcessing] = useState(false)
  const [results, setResults] = useState(null)
  const [error, setError] = useState(null)
  const [activeRecordId, setActiveRecordId] = useState(null) // this visit's local record

  const [tapError, setTapError] = useState(null)
  const [lastResolve, setLastResolve] = useState(null)
  const [recentTaps, setRecentTaps] = useState([])
  const [sync, setSync] = useState({ state: 'idle', pending: 0 })
  const [toast, setToast] = useState(null)

  // ── background sync for the life of the app ─────────────────────────
  useEffect(() => {
    const unsub = subscribeSync(setSync)
    startAutoSync()
    return unsub
  }, [])

  const showToast = useCallback((msg) => {
    setToast(msg)
    setTimeout(() => setToast(null), 4000)
  }, [])

  const refreshRecent = useCallback(async () => {
    try {
      const scans = await allRecords('scans')
      scans.sort((a, b) => String(b.scanned_at).localeCompare(String(a.scanned_at)))
      setRecentTaps(scans.slice(0, 5))
    } catch {
      /* non-fatal */
    }
  }, [])

  // Local scan-log entry (audit trail) + best-effort immediate sync.
  // A station that scanned but produced no data must show up as a gap,
  // not disappear — so this runs even when everything else fails.
  const logScan = useCallback(
    async ({ raw, uid, resolved, enrolled, subject_key, capture_batch_id, note }) => {
      try {
        const c = loadStationConfig() || {}
        const s = {
          id: uuid(),
          raw,
          uid: uid || null,
          prefix: c.readerPrefix || '',
          resolved: !!resolved,
          enrolled: enrolled ?? null,
          subject_key: subject_key || null,
          station: {
            stationId: c.stationId,
            labLocation: c.labLocation,
            operator: c.operator,
          },
          operator: c.operator || null,
          device_id: null,
          scanned_at: new Date().toISOString(),
          capture_batch_id: capture_batch_id || null,
          note: note || null,
          sync_status: 'pending',
          sync_attempts: 0,
        }
        await putRecord('scans', s)
        refreshRecent()
        if (isOnline()) flushQueue()
      } catch {
        /* a local log failure must never block the station */
      }
    },
    [refreshRecent],
  )

  // ── tap handling ─────────────────────────────────────────────────────
  const handleValidTap = useCallback(
    async ({ uid, raw }) => {
      setTapError(null)
      if (screen !== 'idle') {
        // Mid-flow tap: acknowledge loudly, log it, do not fork a capture.
        showToast('Tap received — finish the current capture first')
        logScan({ raw, uid, resolved: false, enrolled: null, note: 'mid-capture' })
        return
      }
      // Resolve for the UI hint (enrolled?) only. The save payload carries
      // the raw UID and the server resolves authoritatively; offline means
      // "no hint", never "no capture".
      let res = null
      try {
        res = await apiResolve(uid)
      } catch {
        res = null
      }
      const sub = {
        uid,
        raw,
        subject_key: res?.subject_key ?? null,
        enrolled: res?.enrolled ?? null,
        first_seen: res?.first_seen ?? null,
        resolved_online: !!res,
      }
      setLastResolve(sub)
      setSubject(sub)
      setActiveRecordId(null) // a new tap starts a new visit/trial
      logScan({
        raw,
        uid,
        resolved: !!res,
        enrolled: res?.enrolled ?? null,
        subject_key: res?.subject_key ?? null,
      })
      setScreen('camera')
    },
    [screen, logScan, showToast],
  )

  const handleInvalidTap = useCallback(
    (raw, reason) => {
      setTapError({ raw, reason })
      logScan({ raw, uid: null, resolved: false, enrolled: null, note: reason })
    },
    [logScan],
  )

  // ── capture / measure (unchanged CV path) ────────────────────────────
  const handleCapture = useCallback(
    async (blob) => {
      setProcessing(true)
      setError(null)
      try {
        const c = loadStationConfig() || {}
        const base = c.apiUrl || import.meta.env.VITE_API_URL || ''
        const formData = new FormData()
        formData.append('image', blob, 'capture.jpg')
        formData.append('marker_cm', markerSize)
        const res = await fetch(`${base}/api/measure`, {
          method: 'POST',
          headers: c.apiToken ? { 'X-Station-Token': c.apiToken } : {},
          body: formData,
        })
        if (!res.ok) {
          const body = await res.json().catch(() => ({}))
          throw new Error(body.detail || `Server error ${res.status}`)
        }
        setResults(await res.json())
        setScreen('results')
      } catch (err) {
        setError(err.message)
        setResults(null)
        setScreen('results')
      } finally {
        setProcessing(false)
      }
    },
    [markerSize],
  )

  // ── navigation ───────────────────────────────────────────────────────
  const handleRetry = useCallback(() => {
    setResults(null)
    setError(null)
    setScreen('camera')
  }, [])

  const handleRecordSaved = useCallback((rec) => {
    if (rec?.id) setActiveRecordId(rec.id)
  }, [])

  const handleContinueToAdditional = useCallback((recId, finalValues) => {
    if (recId) setActiveRecordId(recId)
    setResults((prev) => (finalValues && prev ? { ...prev, ...finalValues } : prev))
    setScreen('additional')
  }, [])

  const handleBackToResults = useCallback(() => setScreen('results'), [])

  const goIdle = useCallback(() => {
    setResults(null)
    setError(null)
    setSubject(null)
    setActiveRecordId(null)
    setScreen('idle')
  }, [])

  const handleTestMode = useCallback(() => {
    setLastResolve(null)
    setActiveRecordId(null)
    setSubject({ test: true, uid: null, raw: null, enrolled: false, resolved_online: false })
    setScreen('camera')
  }, [])

  const handleSetup = useCallback(() => {
    setScreen('setup')
  }, [])

  // Marker size is station config — keep it pinned everywhere.
  useEffect(() => {
    const c = loadStationConfig()
    if (c?.markerCm) setMarkerSize(c.markerCm)
  }, [screen])

  return (
    <>
      {screen === 'setup' && (
        <StationSetup
          onSaved={(c) => {
            setCfg(c)
            if (c.markerCm) setMarkerSize(c.markerCm)
            setScreen(firstRun ? 'instructions' : 'idle')
          }}
        />
      )}

      {screen === 'instructions' && <Instructions onStart={() => setScreen('idle')} />}

      {screen === 'idle' && (
        <IdleScreen
          cfg={cfg}
          tapError={tapError}
          lastResolve={lastResolve}
          sync={sync}
          recentTaps={recentTaps}
          onTestMode={handleTestMode}
          onSetup={handleSetup}
          onHelp={() => setScreen('instructions')}
          onClearError={() => setTapError(null)}
        />
      )}

      {screen === 'camera' && (
        <Camera onCapture={handleCapture} onBack={goIdle} disabled={processing} />
      )}

      {screen === 'additional' && (
        <AdditionalInfo recordId={activeRecordId} subject={subject} onDone={goIdle} onBack={handleBackToResults} />
      )}

      {screen === 'results' && (
        <Results
          results={results}
          error={error}
          warnings={results?.warnings}
          subject={subject}
          markerSize={markerSize}
          activeRecordId={activeRecordId}
          onRetry={handleRetry}
          onContinue={handleContinueToAdditional}
          onIdle={goIdle}
          onRecordSaved={handleRecordSaved}
        />
      )}

      <TapCatcher
        enabled={screen === 'idle'}
        prefix={cfg?.readerPrefix || ''}
        onValidTap={handleValidTap}
        onInvalidTap={handleInvalidTap}
      />

      {toast && <div className="toast">{toast}</div>}
    </>
  )
}
