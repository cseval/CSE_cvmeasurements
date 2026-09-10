import { useState, useRef } from 'react'
import AdjustCanvas from './AdjustCanvas.jsx'
import BrandBar from './BrandBar.jsx'
import { tail } from '../lib/tapProtocol.js'
import { getRecord, loadStationConfig, patchRecord, putRecord, uuid } from '../lib/storage.js'
import { sendCapture } from '../lib/sync.js'

function cmToFtIn(cm) {
  const totalInches = cm / 2.54
  const feet = Math.floor(totalInches / 12)
  const inches = Math.round((totalInches % 12) * 10) / 10
  return `${feet}' ${inches}"`
}

function cmToIn(cm) {
  return `${(cm / 2.54).toFixed(1)}"`
}

const LINE_COLORS = { height: '#60a5fa', wingspan: '#f97316', hand: '#c084fc' }
const ENDPOINT_PAIRS = [
  ['height_crown',  'height_heel',   'height'],
  ['wingspan_left', 'wingspan_right', 'wingspan'],
  ['hand_thumb',    'hand_pinky',     'hand'],
]

function compositeAdjusted(debugImageB64, pts, baseScale, imgW, imgH) {
  return new Promise((resolve) => {
    const canvas  = document.createElement('canvas')
    canvas.width  = Math.round(imgW * baseScale)
    canvas.height = Math.round(imgH * baseScale)
    const ctx = canvas.getContext('2d')
    const img = new Image()
    img.onload = () => {
      ctx.drawImage(img, 0, 0, canvas.width, canvas.height)
      for (const [k1, k2, type] of ENDPOINT_PAIRS) {
        if (!pts[k1] || !pts[k2]) continue
        const color = LINE_COLORS[type]
        ctx.beginPath()
        ctx.moveTo(pts[k1][0], pts[k1][1])
        ctx.lineTo(pts[k2][0], pts[k2][1])
        ctx.strokeStyle = color
        ctx.lineWidth = 4
        ctx.stroke()
        for (const pt of [pts[k1], pts[k2]]) {
          ctx.beginPath()
          ctx.arc(pt[0], pt[1], 5, 0, Math.PI * 2)
          ctx.fillStyle = color
          ctx.fill()
          ctx.strokeStyle = '#fff'
          ctx.lineWidth = 1.5
          ctx.stroke()
        }
      }
      resolve(canvas.toDataURL('image/jpeg', 0.92))
    }
    img.src = `data:image/jpeg;base64,${debugImageB64}`
  })
}

const MANUAL_KEYS = ['height_cm', 'wingspan_cm', 'hand_width_cm']

/**
 * Results screen — the CV half of the app, carried over from the old
 * build (annotated photo, Adjust Lines, Enter Manually). What changed:
 * the save path. Identity is gone (no athlete object, no row id from a
 * roster); saving writes a local capture record first (IndexedDB), then
 * syncs in the background. Every save is a NEW trial on the server; a
 * correction within the same visit updates the same local record.
 */
export default function Results({
  results,
  error,
  warnings,
  subject,
  markerSize,
  activeRecordId,
  onRetry,
  onContinue,
  onIdle,
  onRecordSaved,
}) {
  const [adjusting, setAdjusting]     = useState(false)
  const [adjustedVals, setAdjusted]   = useState({})
  const [adjustedImage, setAdjImage]  = useState(null)
  const [manualEntry, setManualEntry] = useState(false)
  const [manualDraft, setManualDraft] = useState({})
  const [manualVals, setManualVals]   = useState({})
  const [saveState, setSaveState]     = useState('idle') // idle | saving | saved | error
  const [record, setRecord]           = useState(null)
  const canvasRef                     = useRef(null)

  const canAdjust    = !!(results?.endpoints && results?.raw_image)
  const display      = { ...results, ...adjustedVals, ...manualVals }
  const hasManualVals = Object.keys(manualVals).length > 0
  const showFailure  = !!error && !manualEntry && !hasManualVals

  function handleAdjustChange(updated) {
    setAdjusted((prev) => ({ ...prev, ...updated }))
    // Dragging a line re-derives these measurements from the photo, so
    // that wins over any earlier manual entry for the same keys.
    setManualVals((prev) => {
      const next = { ...prev }
      for (const key of Object.keys(updated)) delete next[key]
      return next
    })
    setSaveState((prev) => (prev === 'saved' ? 'idle' : prev))
  }

  function openManualEntry() {
    setManualDraft({
      height_cm:     display.height_cm     ?? '',
      wingspan_cm:   display.wingspan_cm   ?? '',
      hand_width_cm: display.hand_width_cm ?? '',
    })
    setManualEntry(true)
  }

  function handleManualChange(key, raw) {
    setManualDraft((prev) => ({ ...prev, [key]: raw }))
  }

  function handleManualApply() {
    const next = {}
    for (const key of MANUAL_KEYS) {
      const parsed = parseFloat(manualDraft[key])
      if (!isNaN(parsed) && parsed > 0) next[key] = Math.round(parsed * 10) / 10
    }
    setManualVals(next)
    setManualEntry(false)
    setSaveState((prev) => (prev === 'saved' ? 'idle' : prev))
  }

  function handleManualCancel() {
    setManualEntry(false)
  }

  async function handleDone() {
    setAdjusting(false)
    const state = canvasRef.current?.getState()
    if (state && results?.debug_image) {
      const dataUrl = await compositeAdjusted(
        results.debug_image,
        state.pts,
        state.baseScale,
        results.img_width,
        results.img_height,
      )
      setAdjImage(dataUrl)
    }
  }

  async function handleSave() {
    if (!display.height_cm || !display.wingspan_cm || !display.hand_width_cm) return
    setSaveState('saving')
    try {
      const cfg = loadStationConfig() || {}
      const now = new Date().toISOString()
      const method = hasManualVals ? 'manual' : 'cv'

      let rec
      if (activeRecordId) {
        // Correction within the same visit -> same local record (same
        // server trial once synced). Never a second trial for a re-shot.
        const existing = await getRecord('captures', activeRecordId)
        rec = {
          ...(existing || { id: activeRecordId }),
          height_cm: display.height_cm,
          wingspan_cm: display.wingspan_cm,
          hand_width_cm: display.hand_width_cm,
          method,
          saved_at: now,
        }
        await patchRecord('captures', rec.id, {
          height_cm: rec.height_cm,
          wingspan_cm: rec.wingspan_cm,
          hand_width_cm: rec.hand_width_cm,
          method: rec.method,
          saved_at: now,
        })
      } else {
        rec = {
          id: uuid(),
          raw_uid: subject?.uid || null,
          subject_key: subject?.subject_key || null,
          enrolled: subject?.enrolled ?? null,
          test_mode: !!subject?.test,
          marker_cm: markerSize,
          height_cm: display.height_cm,
          wingspan_cm: display.wingspan_cm,
          hand_width_cm: display.hand_width_cm,
          method,
          validity: 1,
          notes: null,
          assessment: {},
          station: {
            stationId: cfg.stationId,
            labLocation: cfg.labLocation,
            eventSessionId: cfg.eventSessionId,
            operator: cfg.operator,
            readerPrefix: cfg.readerPrefix,
          },
          captured_at: now,
          saved_at: now,
          sync_status: 'pending',
          sync_attempts: 0,
          server_trial_ref: null,
          last_error: null,
        }
        await putRecord('captures', rec)
      }

      // Local-first: the record is durable now. Try the network, but a
      // failure only means "pending", never a lost capture.
      setRecord(rec)
      try {
        const res = await sendCapture(rec)
        setRecord({ ...rec, sync_status: 'synced', server_trial_ref: res.trial_ref ?? null })
      } catch {
        /* stays pending; the background queue retries with backoff */
      }
      setSaveState('saved')
      onRecordSaved(rec)
    } catch (err) {
      // The only failure that matters here: the local store itself.
      setSaveState('error')
    }
  }

  const measurements = [
    { key: 'height_cm',     label: 'Height',    cls: 'height',   imperial: (v) => cmToFtIn(v) },
    { key: 'wingspan_cm',   label: 'Wingspan',  cls: 'wingspan', imperial: (v) => cmToFtIn(v) },
    { key: 'hand_width_cm', label: 'Hand Span', cls: 'hand',     imperial: (v) => cmToIn(v) },
  ]

  const isAdjusted = (key) => key in adjustedVals || key in manualVals
  const synced = record?.sync_status === 'synced'

  return (
    <div className="results-screen">
      <BrandBar />
      <div className="results-header">
        <h1>
          {adjusting ? 'Adjust Lines' : manualEntry ? 'Enter Measurements' : showFailure ? 'Measurement Failed' : 'Measurements'}
        </h1>
        {adjusting && <button className="done-btn" onClick={handleDone}>Done</button>}
        {manualEntry && <button className="done-btn" onClick={handleManualApply}>Apply</button>}
      </div>

      <div className="results-body">
        {showFailure ? (
          <div className="error-card">{error}</div>
        ) : (
          <>
            {warnings?.map((w, i) => (
              <div key={i} className="error-card" style={{ fontSize: 13 }}>{w}</div>
            ))}

            {results?.debug_image && !adjusting && (
              <img
                src={adjustedImage || `data:image/jpeg;base64,${results.debug_image}`}
                alt="Annotated measurement"
                style={{ width: '100%', borderRadius: 8, marginBottom: 4 }}
              />
            )}

            {adjusting && (
              <div style={{ marginBottom: 8 }}>
                <p className="adjust-hint">Drag dots · Pinch or scroll to zoom · Double-tap to reset</p>
                <AdjustCanvas
                  ref={canvasRef}
                  rawImage={results.raw_image}
                  endpoints={results.endpoints}
                  pxPerCm={results.px_per_cm}
                  imgWidth={results.img_width}
                  imgHeight={results.img_height}
                  onChange={handleAdjustChange}
                />
              </div>
            )}

            {manualEntry && (
              <p className="manual-entry-hint">
                Enter measurements directly if the camera isn’t available or the detected values look wrong.
              </p>
            )}

            {measurements.map(({ key, label, cls, imperial }) => {
              if (manualEntry) {
                const draftVal = parseFloat(manualDraft[key])
                const liveImperial = !isNaN(draftVal) && draftVal > 0 ? imperial(draftVal) : 'cm'
                return (
                  <div key={key} className={`measurement-card ${cls}`}>
                    <span className="label">{label}</span>
                    <span className="value-group">
                      <input
                        className="measurement-input"
                        type="number"
                        inputMode="decimal"
                        step="0.1"
                        placeholder="—"
                        value={manualDraft[key]}
                        onChange={(e) => handleManualChange(key, e.target.value)}
                      />
                      <span className="value-imperial">{liveImperial}</span>
                    </span>
                  </div>
                )
              }
              const val = display?.[key]
              const adjusted = isAdjusted(key)
              return (
                <div key={key} className={`measurement-card ${val != null ? cls : 'missing'}`}>
                  <span className="label">
                    {label}
                    {adjusted && <span className="adjusted-dot" title="Manually adjusted" />}
                  </span>
                  <span className="value-group">
                    <span className="value">{val != null ? `${val} cm` : '—'}</span>
                    {val != null && <span className="value-imperial">{imperial(val)}</span>}
                  </span>
                </div>
              )
            })}

            {results?.px_per_cm && !manualEntry && (
              <p className="scale-note">Scale: {results.px_per_cm} px / cm · marker {markerSize} cm</p>
            )}
          </>
        )}
      </div>

      <div className="results-footer">
        {showFailure ? (
          <>
            <button className="retry-btn" onClick={onRetry}>Try Again</button>
            <button className="adjust-btn" onClick={openManualEntry}>Enter Manually</button>
          </>
        ) : manualEntry ? (
          <button className="adjust-btn" onClick={handleManualCancel}>Cancel</button>
        ) : (
          <>
            {subject?.test && (
              <div className="subject-banner test">TEST MODE — no subject attached</div>
            )}
            {!subject?.test && subject?.uid && (
              <div className={`subject-banner ${subject.enrolled === false ? 'unenrolled' : 'enrolled'}`}>
                Tag {tail(subject.uid, 4)}
                {subject.enrolled === false && ' — NOT ENROLLED (reconcile later)'}
                {subject.enrolled === true && ' — recognized'}
                {subject.enrolled == null && !subject.resolved_online && ' — status unknown (offline)'}
              </div>
            )}

            {saveState === 'idle' && (
              <button
                className="retry-btn"
                onClick={handleSave}
                disabled={!display.height_cm || !display.wingspan_cm || !display.hand_width_cm}
              >
                {activeRecordId ? 'Update Measurements (same trial)' : 'Save Measurements'}
              </button>
            )}

            {saveState === 'saving' && <button className="retry-btn" disabled>Saving…</button>}

            {saveState === 'saved' && (
              <>
                <div className="save-success">
                  {synced ? 'Measurements saved & synced' : 'Measurements saved locally — will sync'}
                </div>
                {onContinue && (
                  <button className="retry-btn" onClick={() => onContinue(record.id, display)}>
                    Add Additional Info
                  </button>
                )}
                <button className="adjust-btn" onClick={onIdle}>Finish — next athlete</button>
              </>
            )}

            {saveState === 'error' && (
              <div className="error-card" style={{ fontSize: 13 }}>
                Local save failed — check device storage and try again
              </div>
            )}

            {canAdjust && !adjusting && (
              <button className="adjust-btn" onClick={() => setAdjusting(true)}>
                Adjust Lines
              </button>
            )}
            {!adjusting && (
              <button className="adjust-btn" onClick={openManualEntry}>
                Enter Manually
              </button>
            )}
            <button
              className="retry-btn"
              style={{ background: 'var(--color-surface, var(--white))', border: '1px solid var(--border-strong)', color: 'var(--text-primary)' }}
              onClick={onRetry}
            >
              Measure Again
            </button>
          </>
        )}
      </div>
    </div>
  )
}
