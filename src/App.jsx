import { useCallback, useEffect, useRef, useState } from 'react'
import AdditionalInfo from './components/AdditionalInfo.jsx'
import Camera from './components/Camera.jsx'
import Instructions from './components/Instructions.jsx'
import Results from './components/Results.jsx'
import StationAudit from './components/StationAudit.jsx'
import StationSetup from './components/StationSetup.jsx'
import TapIdle from './components/TapIdle.jsx'
import useTapReader from './hooks/useTapReader.jsx'
import { fetchAudit, measure, resolveTap } from './lib/api.js'
import * as queue from './lib/queue.js'
import { isConfigured, loadConfig, saveConfig } from './lib/station.js'
import { isNetworkFailure, validateUid } from './lib/tap.js'
import './App.css'

/**
 * Station state machine.
 *
 *   setup ──▶ instructions ──▶ idle ◀────────────────────┐
 *                               │  tap resolved          │
 *                               ▼                        │
 *                            camera ──▶ results ──▶ additional
 *
 * There is no athlete-select screen and no roster. The event/roster picker is
 * gone: an athlete arrives, taps, and the app knows a subject token. It never
 * knows a name.
 */
export default function App() {
  const [config, setConfig] = useState(loadConfig)
  const [screen, setScreen] = useState(() =>
    isConfigured(loadConfig()) ? 'idle' : 'setup')

  const [tapStatus, setTapStatus] = useState('waiting')
  const [subject, setSubject] = useState(null)
  const [tapReason, setTapReason] = useState(null)
  const [tapRemedy, setTapRemedy] = useState(null)
  const [pendingTap, setPendingTap] = useState(null)

  const [processing, setProcessing] = useState(false)
  const [results, setResults] = useState(null)
  const [error, setError] = useState(null)

  const [clientRef, setClientRef] = useState(null)
  const [queued, setQueued] = useState(null)
  const [testMode, setTestMode] = useState(false)
  const [auditCounts, setAuditCounts] = useState(null)

  const screenRef = useRef(screen)
  useEffect(() => { screenRef.current = screen }, [screen])

  // ---------------------------------------------------------------- sync

  useEffect(() => queue.startSync(), [])

  const refreshAudit = useCallback(() => {
    fetchAudit(config.stationCode)
      .then(a => setAuditCounts(a.counts))
      .catch(() => { /* audit is a nudge, never a blocker */ })
  }, [config.stationCode])

  useEffect(() => {
    if (screen !== 'idle') return
    refreshAudit()
  }, [screen, refreshAudit])

  // ------------------------------------------------------------ tap input

  const handleTap = useCallback(async (raw) => {
    const current = screenRef.current

    // Setup and the audit view are the only screens where a tap is meaningless.
    if (current === 'setup' || current === 'audit') return

    // A tap arriving mid-flow is held, not acted on. Invariant 5: a trial must
    // never be attributed to the previous athlete, and switching subjects
    // silently under an operator who is mid-measurement is exactly how that
    // happens. It is also NOT resolved yet — resolving would write a
    // scan_event that produced no data, and the station audit would fill with
    // phantom gaps from bracelets brushing the reader.
    if (current !== 'idle') {
      setPendingTap(raw)
      return
    }

    // Check the shape locally first. The server is still the authority — it
    // writes scan_event — but a malformed scan should tell the operator now,
    // while the athlete is still at the reader, and on the offline path
    // below there is no server to ask.
    const shape = validateUid(raw)
    if (!shape.ok) {
      setSubject(null)
      setTapReason(shape.reason)
      setTapRemedy('Tap again, holding the band flat on the reader.')
      setTapStatus('rejected')
      // Still send it, so the malformed scan reaches scan_event and shows up
      // in the audit as evidence about the reader. Failure here is fine: the
      // operator already has the answer.
      resolveTap(raw, { operator: config.operator, deviceLabel: config.deviceLabel })
        .catch(() => {})
      return
    }

    setTapStatus('resolving')
    setTapReason(null)
    setTapRemedy(null)
    try {
      const result = await resolveTap(raw, {
        operator: config.operator,
        deviceLabel: config.deviceLabel,
      })
      if (!result.ok) {
        // Read-only resolution: an unknown band is a provisioning gap, not a
        // bad read. Carry the remedy through so the operator is told what to
        // do rather than invited to tap a band that will never resolve.
        setSubject(null)
        setTapReason(result.reason)
        setTapRemedy(result.remedy || null)
        setTapStatus('rejected')
        return
      }
      setSubject(result)
      setTapStatus('resolved')
      setTestMode(false)
      refreshAudit()
    } catch (err) {
      if (!isNetworkFailure(err)) {
        // The server heard us and refused — a rejected station key, a bad
        // payload. Retrying offline would only defer the same rejection.
        setSubject(null)
        setTapReason(err.message)
        setTapStatus('error')
        return
      }
      // No network. The measurement still happens: the station holds the raw
      // scan and the server resolves it at sync time, in the same transaction
      // that writes the trial. This is the whole point of write-locally-first
      // — venue wifi fails during the opening rush, which is exactly when a
      // line of athletes is waiting.
      setSubject({
        offline: true,
        raw_uid: shape.uid,
        subject_id: null,
        subject_token: null,
        enrolled: null,
        first_capture: null,
        scan_event_id: null,
      })
      setTapReason(null)
      setTapRemedy(null)
      setTapStatus('resolved')
      setTestMode(false)
    }
  }, [config.operator, config.deviceLabel, refreshAudit])

  const { TapCatcher } = useTapReader(handleTap, { enabled: true })

  // -------------------------------------------------------------- capture

  const handleCapture = useCallback(async (blob) => {
    setProcessing(true)
    setError(null)
    try {
      const data = await measure(blob, config.markerCm)
      setResults(data)
      setClientRef(queue.newClientRef())
      setScreen('results')
    } catch (err) {
      setError(err.message)
      setClientRef(queue.newClientRef())
      setScreen('results')
    } finally {
      setProcessing(false)
    }
  }, [config.markerCm])

  /**
   * Save. Writes to the local queue and returns — never awaits the network.
   * Invariant 2: a staffer with a line of athletes in front of them does not
   * wait on venue wifi.
   */
  const handleSave = useCallback(async ({ display, methods, annotatedBlob, rawBlob }) => {
    if (testMode || !subject) return null

    const photos = []
    if (config.keepPhotos) {
      if (annotatedBlob) photos.push({ kind: 'tpose_annotated', blob: annotatedBlob })
      if (rawBlob) photos.push({ kind: 'tpose_raw', blob: rawBlob })
    }

    const payload = {
      // Exactly one of these. Offline captures carry the raw scan and the
      // server resolves the subject when the queue drains.
      ...(subject.offline
        ? { raw_uid: subject.raw_uid, device_label: config.deviceLabel || null }
        : { subject_id: subject.subject_id }),
      client_ref: clientRef,
      height_cm: display.height_cm ?? null,
      wingspan_cm: display.wingspan_cm ?? null,
      hand_span_cm: display.hand_width_cm ?? null,
      measurement_method: methods.overall,
      height_method: methods.height ?? null,
      wingspan_method: methods.wingspan ?? null,
      hand_span_method: methods.hand ?? null,
      marker_cm: config.markerCm,
      px_per_cm: results?.px_per_cm ?? null,
      cv_warnings: results?.warnings ?? null,
      event_session_id: config.eventSessionId ?? null,
      lab_location: config.labLocation || null,
      session_type: config.sessionType || null,
      sport: config.sport || null,
      operator: config.operator || null,
      scan_event_id: subject.scan_event_id ?? null,
      station_code: config.stationCode,
    }

    const record = await queue.enqueue({
      payload,
      subjectToken: subject.subject_token,
      photos,
      display,
    })
    setQueued(record)
    return record
  }, [testMode, subject, clientRef, config, results])

  const handleAdditionalSave = useCallback(async (fields) => {
    if (!clientRef) return
    await queue.attachAdditional(clientRef, fields)
  }, [clientRef])

  // -------------------------------------------------------------- resets

  const resetAthlete = useCallback(() => {
    setResults(null)
    setError(null)
    setSubject(null)
    setClientRef(null)
    setQueued(null)
    setTapStatus('waiting')
    setTapReason(null)
    setTapRemedy(null)
    setTestMode(false)
    setScreen('idle')
  }, [])

  const acceptPendingTap = useCallback(() => {
    const raw = pendingTap
    setPendingTap(null)
    resetAthlete()
    // resetAthlete lands on idle, where handleTap will resolve normally.
    setTimeout(() => handleTap(raw), 0)
  }, [pendingTap, resetAthlete, handleTap])

  // ---------------------------------------------------------------- render

  const pendingBanner = pendingTap && (
    <div className="tap-interrupt">
      <div className="tap-interrupt-text">
        Another bracelet was tapped while this athlete is still in progress.
        Nothing has been switched.
      </div>
      <div className="tap-interrupt-actions">
        <button className="adjust-btn" onClick={() => setPendingTap(null)}>
          Finish this athlete
        </button>
        <button className="retry-btn" onClick={acceptPendingTap}>
          Discard and start the new tap
        </button>
      </div>
    </div>
  )

  let body
  if (screen === 'setup') {
    body = (
      <StationSetup
        config={config}
        canSkip={isConfigured(config)}
        onChange={next => { setConfig(next); saveConfig(next) }}
        onDone={() => setScreen(isConfigured(config) ? 'idle' : 'instructions')}
      />
    )
  } else if (screen === 'instructions') {
    body = <Instructions onStart={() => setScreen('idle')} markerCm={config.markerCm} />
  } else if (screen === 'audit') {
    body = (
      <StationAudit
        stationCode={config.stationCode}
        onBack={() => setScreen('idle')}
      />
    )
  } else if (screen === 'idle') {
    body = (
      <TapIdle
        status={testMode ? 'waiting' : tapStatus}
        subject={subject}
        reason={tapReason}
        remedy={tapRemedy}
        markerCm={config.markerCm}
        stationLabel={config.deviceLabel || config.stationCode}
        auditCounts={auditCounts}
        testMode={testMode}
        onShowAudit={() => setScreen('audit')}
        onSetup={() => setScreen('setup')}
        onContinue={() => setScreen('camera')}
        onTestMode={() => {
          // Test mode measures with no subject attached, so a marker print or
          // a camera position can be sanity-checked without polluting data.
          setTestMode(true)
          setSubject(null)
          setScreen('camera')
        }}
      />
    )
  } else if (screen === 'camera') {
    body = (
      <Camera
        onCapture={handleCapture}
        onBack={resetAthlete}
        disabled={processing}
        markerCm={config.markerCm}
        subjectToken={testMode ? null : subject?.subject_token}
        testMode={testMode}
      />
    )
  } else if (screen === 'additional') {
    body = (
      <AdditionalInfo
        subjectToken={subject?.subject_token}
        onSave={handleAdditionalSave}
        onDone={resetAthlete}
        onBack={() => setScreen('results')}
      />
    )
  } else {
    body = (
      <Results
        results={results}
        error={error}
        warnings={results?.warnings}
        subject={subject}
        testMode={testMode}
        markerCm={config.markerCm}
        queued={queued}
        onSave={handleSave}
        onRetry={() => { setResults(null); setError(null); setScreen('camera') }}
        onContinue={() => setScreen('additional')}
        onDone={resetAthlete}
      />
    )
  }

  return (
    <>
      {/* Mounted at the root, on every screen, always. Invariant 1: if this
          unmounts or loses focus, the next tap goes nowhere and looks like a
          hardware failure to staff. */}
      <TapCatcher />
      {pendingBanner}
      {body}
    </>
  )
}
