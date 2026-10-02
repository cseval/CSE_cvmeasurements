import { useEffect, useState } from 'react'
import BrandBar from './BrandBar.jsx'
import { fetchAudit } from '../lib/api.js'
import * as queue from '../lib/queue.js'

/**
 * Today's data quality at this station.
 *
 * This screen is the point of the scan log. The old pipeline's documented gap
 * was "little ability to audit data quality", and the specific failure it
 * allowed was a station that scanned but produced no data disappearing
 * entirely. Here that shows up as a number an operator can act on while the
 * athlete is still in the building.
 *
 * Four things need a human, and they are different problems:
 *
 *   no data     a tap resolved and then nothing was saved. Usually the
 *               operator got interrupted. The athlete needs remeasuring.
 *   unenrolled  the bracelet works but is not linked to an athlete yet. The
 *               capture is fine and will resolve once check-in enrolls it.
 *   unresolved  a tap that could not be turned into a subject at all.
 *   malformed   the reader sent something that is not a UID. Hardware.
 *
 * No names, here or anywhere. Reconciling a row means taking the subject
 * token or raw scan value to check-in.
 */
export default function StationAudit({ stationCode, onBack }) {
  const [audit, setAudit] = useState(null)
  const [error, setError] = useState(null)
  const [stats, setStats] = useState(null)
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    fetchAudit(stationCode).then(setAudit).catch(err => setError(err.message))
    return queue.subscribe(setStats)
  }, [stationCode])

  const counts = audit?.counts

  async function handleExport() {
    setBusy(true)
    try { await queue.exportCsv() } finally { setBusy(false) }
  }

  async function handleRetry() {
    setBusy(true)
    try { await queue.retryStalled() } finally { setBusy(false) }
  }

  function describe(row) {
    if (!row.valid_shape) return 'Malformed scan — reader sent something that is not a UID'
    if (!row.resolved) return 'Could not resolve to a subject'
    if (row.capture_trial_id === null) return 'Tap produced no measurement'
    if (row.enrolled === 0) return 'Bracelet not enrolled to an athlete yet'
    return row.note || ''
  }

  return (
    <div className="audit-screen">
      <BrandBar />
      <div className="results-header">
        <h1>Station Audit</h1>
        <button className="done-btn" onClick={onBack}>Done</button>
      </div>

      <div className="results-body">
        {error && <div className="error-card">{error}</div>}

        {stats && (
          <div className="form-section">
            <p className="form-section-label">This device</p>
            <div className="audit-tiles">
              <div className="audit-tile">
                <span className="audit-num">{stats.pending}</span>
                <span className="audit-label">queued</span>
              </div>
              <div className={`audit-tile${stats.stalled ? ' bad' : ''}`}>
                <span className="audit-num">{stats.stalled}</span>
                <span className="audit-label">stalled</span>
              </div>
              <div className="audit-tile">
                <span className="audit-num">{stats.synced}</span>
                <span className="audit-label">synced</span>
              </div>
            </div>
            {stats.pending > 0 && (
              <p className="setup-hint">
                Queued captures are saved on this device and retry in the
                background. Do not clear the browser's site data until this
                reads zero.
              </p>
            )}
            {stats.stalled > 0 && (
              <p className="setup-hint">
                Stalled captures hit an error that will not fix itself on
                retry, usually a rejected station key or an unregistered
                station code. Fix the cause, then retry.
              </p>
            )}
          </div>
        )}

        {counts && (
          <div className="form-section">
            <p className="form-section-label">Taps today · {audit.date}</p>
            <div className="audit-tiles">
              <div className="audit-tile">
                <span className="audit-num">{counts.taps}</span>
                <span className="audit-label">taps</span>
              </div>
              <div className={`audit-tile${counts.no_data ? ' bad' : ''}`}>
                <span className="audit-num">{counts.no_data}</span>
                <span className="audit-label">no data</span>
              </div>
              <div className={`audit-tile${counts.unenrolled ? ' warn' : ''}`}>
                <span className="audit-num">{counts.unenrolled}</span>
                <span className="audit-label">unenrolled</span>
              </div>
              <div className={`audit-tile${counts.malformed ? ' warn' : ''}`}>
                <span className="audit-num">{counts.malformed}</span>
                <span className="audit-label">malformed</span>
              </div>
            </div>
          </div>
        )}

        {audit?.needs_review?.length > 0 && (
          <div className="form-section">
            <p className="form-section-label">Needs review</p>
            {audit.needs_review.map(row => (
              <div key={row.id} className="audit-row">
                <div className="audit-row-main">
                  <span className="audit-row-uid">{row.raw_scan_value}</span>
                  <span className="audit-row-time">
                    {new Date(row.scanned_at + 'Z').toLocaleTimeString()}
                  </span>
                </div>
                <div className="audit-row-why">{describe(row)}</div>
              </div>
            ))}
          </div>
        )}

        {audit && audit.needs_review.length === 0 && (
          <div className="save-success">Nothing needs review at this station today</div>
        )}
      </div>

      <div className="results-footer">
        <button className="adjust-btn" onClick={handleExport} disabled={busy}>
          Export session CSV
        </button>
        {stats?.stalled > 0 && (
          <button className="adjust-btn" onClick={handleRetry} disabled={busy}>
            Retry stalled
          </button>
        )}
        <button className="retry-btn" onClick={onBack}>Back to Taps</button>
      </div>
    </div>
  )
}
