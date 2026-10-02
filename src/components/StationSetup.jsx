import { useEffect, useState } from 'react'
import BrandBar from './BrandBar.jsx'
import { MARKER_SIZES } from '../lib/station.js'
import { fetchEventSessions, fetchHealth, fetchStations, markerPdfUrl } from '../lib/api.js'

/**
 * Once-per-shift station setup. Replaces the event/roster picker entirely —
 * there is no roster here, and the operator never sees a name.
 *
 * Marker size lives here rather than being asked per athlete, because it is a
 * property of the printout taped to the wall, not of the person standing in
 * front of it. It is also shown persistently on the capture screen: an
 * operator who picks 20cm while holding a 12cm print gets values wrong by a
 * factor of 1.67 with no error anywhere, so the defence is making the choice
 * impossible to forget rather than impossible to make.
 */
export default function StationSetup({ config, onChange, onDone, canSkip }) {
  const [draft, setDraft] = useState(config)
  const [stations, setStations] = useState([])
  const [sessions, setSessions] = useState([])
  const [health, setHealth] = useState(null)
  const [loadError, setLoadError] = useState(null)

  useEffect(() => {
    let cancelled = false
    Promise.allSettled([fetchHealth(), fetchStations(), fetchEventSessions()])
      .then(([h, s, e]) => {
        if (cancelled) return
        if (h.status === 'fulfilled') setHealth(h.value)
        if (s.status === 'fulfilled') setStations(s.value)
        if (e.status === 'fulfilled') setSessions(e.value)
        const failed = [h, s, e].filter(r => r.status === 'rejected')
        if (failed.length) {
          // Setup must still be completable offline — the queue exists exactly
          // so a shift can run with no backend.
          setLoadError(
            'Could not reach the API. You can still set up and measure; ' +
            'captures will queue on this device and sync when it is back.'
          )
        }
      })
    return () => { cancelled = true }
  }, [])

  function set(key, value) {
    setDraft(prev => ({ ...prev, [key]: value }))
  }

  const ready = MARKER_SIZES.includes(Number(draft.markerCm)) &&
    draft.stationCode && draft.operator?.trim()

  function handleStart() {
    onChange(draft)
    onDone()
  }

  return (
    <div className="setup-screen">
      <BrandBar />
      <div className="instructions-header">
        <div>
          <h1>Station Setup</h1>
          <p className="instructions-sub">Set once per shift</p>
        </div>
      </div>

      <div className="instructions-body">
        {loadError && <div className="error-card" style={{ fontSize: 13 }}>{loadError}</div>}

        {health && !health.ok && (
          <div className="error-card" style={{ fontSize: 13 }}>
            API is up but the database is not reachable
            {health.database_error ? `: ${health.database_error}` : ''}.
          </div>
        )}
        {health?.ok && !health.auth_enabled && (
          <div className="warn-card">
            This API is running without a station key. Set STATION_API_KEYS on
            the server before it is reachable from outside the lab.
          </div>
        )}

        <div className="form-section">
          <p className="form-section-label">Marker</p>
          <div className="marker-size-options">
            {MARKER_SIZES.map(size => (
              <button
                key={size}
                className={`marker-size-btn${Number(draft.markerCm) === size ? ' active' : ''}`}
                onClick={() => set('markerCm', size)}
              >
                {size} cm
              </button>
            ))}
          </div>
          <a
            className="print-marker-btn"
            href={markerPdfUrl(draft.markerCm)}
            target="_blank"
            rel="noreferrer"
          >
            Print {draft.markerCm} cm marker
          </a>
          <p className="setup-hint">
            Print at Actual size, not Fit to page. Tape it flat on the wall at
            wrist height, in the same plane as the athlete.
          </p>
        </div>

        <div className="form-section">
          <p className="form-section-label">Station</p>
          <div className="form-grid">
            <div className="form-field">
              <label className="form-field-label">Station</label>
              {stations.length ? (
                <select
                  className="form-input"
                  value={draft.stationCode}
                  onChange={e => set('stationCode', e.target.value)}
                >
                  {stations.filter(s => !s.is_closed_system).map(s => (
                    <option key={s.code} value={s.code}>{s.label}</option>
                  ))}
                </select>
              ) : (
                <input
                  className="form-input"
                  value={draft.stationCode}
                  onChange={e => set('stationCode', e.target.value)}
                  placeholder="cv_app"
                />
              )}
            </div>
            <div className="form-field">
              <label className="form-field-label">Device label</label>
              <input
                className="form-input"
                value={draft.deviceLabel}
                onChange={e => set('deviceLabel', e.target.value)}
                placeholder="ipad-lab-01"
              />
            </div>
            <div className="form-field">
              <label className="form-field-label">Operator *</label>
              <input
                className="form-input"
                value={draft.operator}
                onChange={e => set('operator', e.target.value)}
                placeholder="Staff name or initials"
              />
            </div>
            <div className="form-field">
              <label className="form-field-label">Lab location</label>
              <input
                className="form-input"
                value={draft.labLocation}
                onChange={e => set('labLocation', e.target.value)}
                placeholder="CSE Lab"
              />
            </div>
          </div>
        </div>

        <div className="form-section">
          <p className="form-section-label">Event session</p>
          {sessions.length ? (
            <select
              className="form-input"
              value={draft.eventSessionId ?? ''}
              onChange={e => set('eventSessionId', e.target.value ? Number(e.target.value) : null)}
            >
              <option value="">Not tied to an event</option>
              {sessions.map(s => (
                <option key={s.id} value={s.id}>
                  {[s.session_date, s.event_name || s.location || s.lab]
                    .filter(Boolean).join(' — ')}
                </option>
              ))}
            </select>
          ) : (
            <p className="setup-hint">
              No event sessions available. Captures will be recorded without an
              event link, which is valid — event_session_id is nullable.
            </p>
          )}
        </div>

        <div className="form-section">
          <p className="form-section-label">Photos</p>
          <label className="toggle-row">
            <input
              type="checkbox"
              checked={draft.keepPhotos}
              onChange={e => set('keepPhotos', e.target.checked)}
            />
            <span>
              Keep the capture photo with each trial
            </span>
          </label>
          <p className="setup-hint">
            Photos are stored against the trial in file_artifact with a purge
            date. These are full-body images of minor athletes, so turn this
            off for any session where you do not need them.
          </p>
        </div>
      </div>

      <div className="instructions-footer">
        <button className="retry-btn" onClick={handleStart} disabled={!ready}>
          {ready ? 'Start Taking Taps' : 'Operator name required'}
        </button>
        {canSkip && (
          <button className="adjust-btn" onClick={onDone}>Cancel</button>
        )}
      </div>
    </div>
  )
}
