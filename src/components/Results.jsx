import { useRef, useState } from 'react'
import AdjustCanvas from './AdjustCanvas.jsx'
import BrandBar from './BrandBar.jsx'

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
  ['height_crown', 'height_heel', 'height'],
  ['wingspan_left', 'wingspan_right', 'wingspan'],
  ['hand_thumb', 'hand_pinky', 'hand'],
]

const MANUAL_KEYS = ['height_cm', 'wingspan_cm', 'hand_width_cm']

/** Map a measurement key to the per-field method column the API expects. */
const METHOD_FIELD = {
  height_cm: 'height',
  wingspan_cm: 'wingspan',
  hand_width_cm: 'hand',
}

function b64ToBlob(b64, type = 'image/jpeg') {
  const bytes = atob(b64)
  const buf = new Uint8Array(bytes.length)
  for (let i = 0; i < bytes.length; i += 1) buf[i] = bytes.charCodeAt(i)
  return new Blob([buf], { type })
}

function dataUrlToBlob(dataUrl) {
  const [, b64] = dataUrl.split(',')
  return b64ToBlob(b64)
}

function compositeAdjusted(debugImageB64, pts, baseScale, imgW, imgH) {
  return new Promise(resolve => {
    const canvas = document.createElement('canvas')
    canvas.width = Math.round(imgW * baseScale)
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

/**
 * Measurement review and save.
 *
 * Carried over close to intact from the previous build — the annotated photo,
 * Adjust Lines, and Enter Manually are the station's real-world resilience and
 * losing any of them makes the station worse.
 *
 * Three things are different:
 *
 *   1. No name anywhere. The banner shows the opaque subject token.
 *   2. Save writes to the local queue and returns immediately (invariant 2),
 *      so the button reads "Saved on device" rather than pretending the
 *      database has it.
 *   3. Every save is a NEW trial. There is no "Update Measurements" label,
 *      because the previous build's upsert-onto-the-latest-row behaviour is
 *      exactly what destroyed longitudinal history when an athlete was
 *      measured twice in a season.
 */
export default function Results({
  results, error, warnings, subject, testMode, markerCm, queued,
  onSave, onRetry, onContinue, onDone,
}) {
  const [adjusting, setAdjusting] = useState(false)
  const [adjustedVals, setAdjusted] = useState({})
  const [adjustedImage, setAdjImage] = useState(null)
  const [manualEntry, setManualEntry] = useState(false)
  const [manualDraft, setManualDraft] = useState({})
  const [manualVals, setManualVals] = useState({})
  const [saveState, setSaveState] = useState('idle') // idle | saving | saved | error
  const [saveError, setSaveError] = useState(null)
  const canvasRef = useRef(null)

  const canAdjust = !!(results?.endpoints && results?.raw_image)
  const display = { ...results, ...adjustedVals, ...manualVals }
  const hasManualVals = Object.keys(manualVals).length > 0
  const showFailure = !!error && !manualEntry && !hasManualVals
  const hasAnyValue = MANUAL_KEYS.some(k => display[k] != null)

  function handleAdjustChange(updated) {
    setAdjusted(prev => ({ ...prev, ...updated }))
    // Dragging a line re-derives from the photo, so it wins over an earlier
    // manual entry for the same key.
    setManualVals(prev => {
      const next = { ...prev }
      for (const key of Object.keys(updated)) delete next[key]
      return next
    })
    if (saveState === 'saved') setSaveState('idle')
  }

  function openManualEntry() {
    setManualDraft({
      height_cm: display.height_cm ?? '',
      wingspan_cm: display.wingspan_cm ?? '',
      hand_width_cm: display.hand_width_cm ?? '',
    })
    setManualEntry(true)
  }

  function handleManualApply() {
    const next = {}
    for (const key of MANUAL_KEYS) {
      const parsed = parseFloat(manualDraft[key])
      if (!isNaN(parsed) && parsed > 0) next[key] = Math.round(parsed * 10) / 10
    }
    setManualVals(next)
    setManualEntry(false)
    if (saveState === 'saved') setSaveState('idle')
  }

  async function handleDone() {
    setAdjusting(false)
    const state = canvasRef.current?.getState()
    if (state && results?.debug_image) {
      const dataUrl = await compositeAdjusted(
        results.debug_image, state.pts, state.baseScale,
        results.img_width, results.img_height,
      )
      setAdjImage(dataUrl)
    }
  }

  /**
   * Per-field provenance. Without this a hand-typed value and a CV-derived one
   * are indistinguishable downstream, and the whole point of storing px_per_cm
   * and marker_cm is being able to tell later which numbers can be rescaled
   * and which were measured with a tape.
   */
  function methods() {
    const per = {}
    for (const key of MANUAL_KEYS) {
      if (display[key] == null) continue
      if (key in manualVals) per[METHOD_FIELD[key]] = 'manual'
      else if (key in adjustedVals) per[METHOD_FIELD[key]] = 'cv_adjusted'
      else per[METHOD_FIELD[key]] = 'cv'
    }
    const distinct = new Set(Object.values(per))
    const overall = distinct.size === 1 ? [...distinct][0] : 'mixed'
    return { ...per, overall }
  }

  async function handleSave() {
    if (testMode || !subject || !hasAnyValue) return
    setSaveState('saving')
    setSaveError(null)
    try {
      const annotatedBlob = adjustedImage
        ? dataUrlToBlob(adjustedImage)
        : results?.debug_image ? b64ToBlob(results.debug_image) : null
      const rawBlob = results?.raw_image ? b64ToBlob(results.raw_image) : null

      await onSave({ display, methods: methods(), annotatedBlob, rawBlob })
      setSaveState('saved')
    } catch (err) {
      // Reaching here means the LOCAL write failed, which is the one failure
      // this design cannot absorb — a network failure is normal and handled
      // by the queue. Usually it is a full or blocked origin storage quota.
      setSaveError(err.message)
      setSaveState('error')
    }
  }

  const measurements = [
    { key: 'height_cm', label: 'Height', cls: 'height', imperial: cmToFtIn },
    { key: 'wingspan_cm', label: 'Wingspan', cls: 'wingspan', imperial: cmToFtIn },
    { key: 'hand_width_cm', label: 'Hand Span', cls: 'hand', imperial: cmToIn },
  ]

  const isAdjusted = key => key in adjustedVals || key in manualVals
  const scaleWarning = queued?.result?.scale_warning

  return (
    <div className="results-screen">
      <BrandBar />
      <div className="results-header">
        <h1>
          {adjusting ? 'Adjust Lines'
            : manualEntry ? 'Enter Measurements'
            : showFailure ? 'Measurement Failed' : 'Measurements'}
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
              <div key={i} className="warn-card">{w}</div>
            ))}

            {scaleWarning && <div className="error-card">{scaleWarning}</div>}

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
                Enter measurements directly if the camera isn't available or the
                detected values look wrong.
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
                        onChange={e => setManualDraft(p => ({ ...p, [key]: e.target.value }))}
                      />
                      <span className="value-imperial">{liveImperial}</span>
                    </span>
                  </div>
                )
              }
              const val = display?.[key]
              return (
                <div key={key} className={`measurement-card ${val != null ? cls : 'missing'}`}>
                  <span className="label">
                    {label}
                    {isAdjusted(key) && <span className="adjusted-dot" title="Manually adjusted" />}
                  </span>
                  <span className="value-group">
                    <span className="value">{val != null ? `${val} cm` : '—'}</span>
                    {val != null && <span className="value-imperial">{imperial(val)}</span>}
                  </span>
                </div>
              )
            })}

            {results?.px_per_cm && !manualEntry && (
              <p className="scale-note">
                Scale: {results.px_per_cm} px / cm · {markerCm} cm marker
              </p>
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
          <button className="adjust-btn" onClick={() => setManualEntry(false)}>Cancel</button>
        ) : (
          <>
            {!adjusting && (testMode ? (
              <div className="subject-banner test">
                Test mode — nothing will be saved
              </div>
            ) : subject && (
              <div className="subject-banner">
                <span className="subject-token">
                  {subject.offline ? subject.raw_uid : subject.subject_token}
                </span>
                {subject.offline && (
                  <span className="hint-chip missing">Offline — resolves on sync</span>
                )}
                {!subject.offline && subject.enrolled === false && (
                  <span className="hint-chip missing">Not enrolled</span>
                )}
              </div>
            ))}

            {!testMode && !adjusting && saveState === 'idle' && (
              <button className="retry-btn" onClick={handleSave} disabled={!hasAnyValue}>
                {hasAnyValue ? 'Save Measurements' : 'No measurements to save'}
              </button>
            )}

            {saveState === 'saving' && <button className="retry-btn" disabled>Saving…</button>}

            {saveState === 'saved' && (
              <>
                <div className="save-success">
                  Saved on this device
                  {queued?.result?.trial_number
                    ? ` · trial ${queued.result.trial_number}`
                    : ' · syncing in the background'}
                </div>
                <button className="retry-btn" onClick={onContinue}>Add Additional Info</button>
                <button className="adjust-btn" onClick={onDone}>Next Athlete</button>
              </>
            )}

            {saveState === 'error' && (
              <div className="error-card">
                Could not save to this device{saveError ? `: ${saveError}` : ''}.
                Storage may be full or blocked. Export the session CSV from the
                audit screen before continuing.
              </div>
            )}

            {canAdjust && !adjusting && (
              <button className="adjust-btn" onClick={() => setAdjusting(true)}>Adjust Lines</button>
            )}
            {!adjusting && (
              <button className="adjust-btn" onClick={openManualEntry}>Enter Manually</button>
            )}
            <button className="adjust-btn" onClick={onRetry}>Measure Again</button>
            {testMode && (
              <button className="retry-btn" onClick={onDone}>Done</button>
            )}
          </>
        )}
      </div>
    </div>
  )
}
