import { useState } from 'react'
import BrandBar from './BrandBar.jsx'
import { loadStationConfig, saveStationConfig } from '../lib/storage.js'

const MARKER_SIZES = [12, 16, 20]

/**
 * One-time-per-shift station config (handoff §3.2 / §4.2).
 * Persisted on-device (localStorage) so a reload never loses it.
 * Carries no athlete identity — station, marker, reader, API only.
 */
export default function StationSetup({ onSaved }) {
  const cfg = loadStationConfig() || {}
  const [draft, setDraft] = useState({
    stationId: cfg.stationId || 'cv_app',
    labLocation: cfg.labLocation || '',
    eventSessionId: cfg.eventSessionId || '',
    operator: cfg.operator || '',
    markerCm: cfg.markerCm || 16,
    readerPrefix: cfg.readerPrefix || '',
    apiToken: cfg.apiToken || '',
    apiUrl: cfg.apiUrl || '',
  })
  const [pdfBusy, setPdfBusy] = useState(false)
  const [pdfError, setPdfError] = useState(null)

  const set = (k) => (e) => setDraft((d) => ({ ...d, [k]: e.target.value }))

  async function openMarkerPdf() {
    setPdfBusy(true)
    setPdfError(null)
    try {
      const base = draft.apiUrl || import.meta.env.VITE_API_URL || ''
      const res = await fetch(`${base}/api/marker/${draft.markerCm}/pdf`, {
        headers: draft.apiToken ? { 'X-Station-Token': draft.apiToken } : {},
      })
      if (!res.ok) {
        const detail = await res.json().catch(() => ({})).then((t) => t.detail)
        throw new Error(detail || `API ${res.status}`)
      }
      const blob = await res.blob()
      const url = URL.createObjectURL(blob)
      window.open(url, '_blank')
      setTimeout(() => URL.revokeObjectURL(url), 60_000)
    } catch (e) {
      setPdfError(`Could not open marker PDF: ${e.message}`)
    } finally {
      setPdfBusy(false)
    }
  }

  function handleSave(e) {
    e.preventDefault()
    const next = {
      ...draft,
      markerCm: Number(draft.markerCm),
      stationId: String(draft.stationId).trim() || 'cv_app',
      eventSessionId: String(draft.eventSessionId).trim(),
    }
    saveStationConfig(next)
    onSaved(next)
  }

  return (
    <div className="setup-screen">
      <BrandBar />
      <div className="setup-header">
        <h1>Station Setup</h1>
        <p className="setup-sub">Once per shift — saved on this device only</p>
      </div>

      <form className="setup-body" onSubmit={handleSave}>
        <div className="form-section">
          <p className="form-section-label">Station</p>
          <div className="form-grid">
            <div className="form-field">
              <label className="form-field-label">Station ID</label>
              <input
                className="form-input"
                value={draft.stationId}
                onChange={set('stationId')}
                placeholder="cv_app"
                required
              />
            </div>
            <div className="form-field">
              <label className="form-field-label">Lab location</label>
              <input
                className="form-input"
                value={draft.labLocation}
                onChange={set('labLocation')}
                placeholder="e.g. Lab 2"
              />
            </div>
            <div className="form-field">
              <label className="form-field-label">
                Event session ID <span className="opt">(optional)</span>
              </label>
              <input
                className="form-input"
                type="number"
                inputMode="numeric"
                value={draft.eventSessionId}
                onChange={set('eventSessionId')}
                placeholder="—"
              />
            </div>
            <div className="form-field">
              <label className="form-field-label">Operator</label>
              <input
                className="form-input"
                value={draft.operator}
                onChange={set('operator')}
                placeholder="staff initials"
              />
            </div>
          </div>
        </div>

        <div className="form-section">
          <p className="form-section-label">ArUco marker</p>
          <div className="marker-size-row">
            <div className="marker-size-options">
              {MARKER_SIZES.map((s) => (
                <button
                  type="button"
                  key={s}
                  className={`marker-size-btn${draft.markerCm === s ? ' active' : ''}`}
                  onClick={() => setDraft((d) => ({ ...d, markerCm: s }))}
                >
                  {s} cm
                </button>
              ))}
            </div>
            <button type="button" className="print-marker-btn" onClick={openMarkerPdf} disabled={pdfBusy}>
              {pdfBusy ? 'Opening…' : 'Open marker PDF'}
            </button>
          </div>
          {pdfError && <div className="error-card" style={{ fontSize: 13 }}>{pdfError}</div>}
          <p className="setup-hint">
            Print at “Actual size” (not “Fit to page”). Tape flat on the wall at wrist height,
            same plane as the athlete. The selected size stays pinned to the capture flow.
          </p>
        </div>

        <div className="form-section">
          <p className="form-section-label">Reader &amp; API</p>
          <div className="form-grid">
            <div className="form-field">
              <label className="form-field-label">
                Reader prefix <span className="opt">(firmware PREFIX)</span>
              </label>
              <input
                className="form-input"
                value={draft.readerPrefix}
                onChange={set('readerPrefix')}
                placeholder="empty = none"
              />
            </div>
            <div className="form-field">
              <label className="form-field-label">Station API token</label>
              <input
                className="form-input"
                type="password"
                value={draft.apiToken}
                onChange={set('apiToken')}
                placeholder="STATION_API_KEY"
                autoComplete="off"
              />
            </div>
            <div className="form-field" style={{ gridColumn: '1 / -1' }}>
              <label className="form-field-label">
                API URL <span className="opt">(optional override)</span>
              </label>
              <input
                className="form-input"
                value={draft.apiUrl}
                onChange={set('apiUrl')}
                placeholder="https://api.example.com"
              />
            </div>
          </div>
        </div>

        <button type="submit" className="retry-btn">Save &amp; continue</button>
      </form>
    </div>
  )
}
