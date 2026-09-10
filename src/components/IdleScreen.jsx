import BrandBar from './BrandBar.jsx'
import { tail } from '../lib/tapProtocol.js'
import { exportCsv } from '../lib/csv.js'

/**
 * Idle "TAP TO BEGIN" screen (handoff §3.2). The operator never sees or
 * selects a name — there is no roster here. Surfaces: station config,
 * sync state, the last tag's enrollment status (reconcile-later flag),
 * and the recent tap audit trail.
 */
export default function IdleScreen({
  cfg,
  tapError,
  lastResolve,
  sync,
  recentTaps,
  onTestMode,
  onSetup,
  onHelp,
  onClearError,
}) {
  const unenrolled = lastResolve && lastResolve.enrolled === false
  const enrolledOk = lastResolve && lastResolve.enrolled === true

  return (
    <div className="idle-screen">
      <BrandBar />

      <div className="idle-main">
        <div className="tap-prompt">
          <div className="tap-ring" aria-hidden="true" />
          <h1>TAP TO BEGIN</h1>
          <p className="tap-sub">Bring the athlete’s bracelet to the reader</p>
        </div>

        {tapError && (
          <div className="error-card" role="alert">
            <button className="dismiss-tap-error" onClick={onClearError}>dismiss</button>
            <strong>Tap rejected:</strong> <span className="mono">{tapError.raw}</span> — {tapError.reason}
          </div>
        )}

        {unenrolled && (
          <div className="warn-banner" role="status">
            Tag {tail(lastResolve.uid)} is <strong>not enrolled</strong> — capture will proceed.
            Reconcile at check-in before the athlete leaves the building.
          </div>
        )}

        {enrolledOk && (
          <div className="ok-banner" role="status">
            Tag {tail(lastResolve.uid)} recognized — ready for capture.
          </div>
        )}

        <div className="station-chips">
          <span className="chip">{cfg.stationId}</span>
          {cfg.operator && <span className="chip">{cfg.operator}</span>}
          <span className="chip">marker {cfg.markerCm} cm</span>
          {cfg.eventSessionId && <span className="chip">session #{cfg.eventSessionId}</span>}
          {cfg.readerPrefix && <span className="chip">prefix {cfg.readerPrefix}</span>}
        </div>

        <div className="idle-status-row">
          <span className={`sync-badge sync-${sync.state}`}>
            {sync.state === 'syncing'
              ? 'Syncing…'
              : sync.state === 'offline'
                ? `Offline — ${sync.pending ?? 0} queued`
                : sync.state === 'pending'
                  ? `${sync.pending ?? 0} queued`
                  : 'All synced'}
          </span>
          <button className="link-btn" onClick={() => exportCsv()}>Export CSV</button>
          <button className="link-btn" onClick={onHelp}>How it works</button>
          <button className="link-btn" onClick={onSetup}>Station settings</button>
        </div>
      </div>

      {recentTaps?.length > 0 && (
        <div className="recent-taps">
          <p className="recent-taps-label">Recent taps</p>
          {recentTaps.map((t) => (
            <div key={t.id} className="recent-tap-row">
              <span className="recent-time">
                {new Date(t.scanned_at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
              </span>
              <span className="recent-uid mono">{t.uid ? tail(t.uid, 4) : (t.raw || '—')}</span>
              <span className={`recent-status ${t.resolved ? 'ok' : 'bad'}`}>
                {t.resolved ? 'resolved' : 'no subject'}
              </span>
              <span className={`recent-sync ${t.sync_status}`}>{t.sync_status}</span>
            </div>
          ))}
        </div>
      )}

      <div className="idle-footer">
        <button className="test-mode-btn" onClick={onTestMode}>
          TEST MODE — measure without a subject
        </button>
      </div>
    </div>
  )
}
