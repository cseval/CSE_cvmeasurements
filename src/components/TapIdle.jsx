import BrandBar from './BrandBar.jsx'

/**
 * The idle screen. This is where the station lives between athletes.
 *
 * What it shows about a resolved tap is deliberately NON-IDENTIFYING: the
 * opaque subject token and whether the bracelet has been enrolled yet. Not a
 * name, because the app does not have one and is not allowed to ask.
 *
 * The confirmation still has to be useful to an operator standing next to an
 * athlete, so it answers the two questions they actually have: did the tap
 * register, and is anything wrong with this bracelet.
 */
export default function TapIdle({
  status,          // 'waiting' | 'resolving' | 'resolved' | 'rejected' | 'error'
  subject,         // { subject_token, enrolled, first_capture }
  reason,          // rejection reason, operator-readable
  remedy,          // what to actually do about it
  markerCm,
  stationLabel,
  onContinue,
  onSetup,
  onShowAudit,
  auditCounts,
  testMode,
  onTestMode,
}) {
  const waiting = status === 'waiting'

  return (
    <div className="tap-screen">
      <BrandBar />

      <div className="tap-main">
        {waiting && (
          <>
            <div className="tap-pulse" aria-hidden="true" />
            <h1 className="tap-headline">Tap to Begin</h1>
            <p className="tap-sub">Hold the athlete's bracelet flat on the reader</p>
          </>
        )}

        {status === 'resolving' && (
          <>
            <div className="spinner" />
            <h1 className="tap-headline">Reading…</h1>
          </>
        )}

        {status === 'resolved' && subject && (
          <>
            <div className="tap-check" aria-hidden="true">✓</div>
            <h1 className="tap-headline">Bracelet Read</h1>
            <p className="tap-token">
              {subject.offline ? subject.raw_uid : subject.subject_token}
            </p>
            <div className="tap-flags">
              {subject.offline ? (
                // No server was reachable, so nothing is known about this
                // bracelet yet — not whether it is new, not whether it is
                // enrolled. Say that plainly rather than showing a guess.
                <span className="hint-chip missing">
                  Offline — the measurement saves on this device and the
                  bracelet resolves when the network returns
                </span>
              ) : (
                <>
                  {subject.first_capture && (
                    <span className="hint-chip">First capture for this bracelet</span>
                  )}
                  {/*
                    Unbound is NOT an error. An anonymously-issued band
                    measures perfectly well and gets claimed afterwards, so
                    this is a reconcile-before-they-leave nudge, never a gate.
                  */}
                  {subject.enrolled === false && (
                    <span className="hint-chip missing">
                      Not yet claimed — fine to measure, reconcile at the desk
                    </span>
                  )}
                  {subject.enrolled === true && (
                    <span className="hint-chip ok">Claimed</span>
                  )}
                </>
              )}
            </div>
            <button className="retry-btn tap-continue" onClick={onContinue}>
              Continue to Camera
            </button>
          </>
        )}

        {status === 'rejected' && (
          <>
            <div className="tap-x" aria-hidden="true">×</div>
            {/*
              Two different failures land here and they need different words.
              A bad read is fixed by tapping again. A band that was never
              provisioned will never resolve no matter how many times it is
              tapped, and telling the operator to retry just burns the time
              the athlete is standing there. The remedy string from the server
              is what separates them.
            */}
            <h1 className="tap-headline">
              {remedy ? 'Band Cannot Be Measured' : 'Tap Not Read'}
            </h1>
            <p className="tap-sub">{reason}</p>
            <p className="tap-sub-dim">
              {remedy || 'Tap again. The scan was logged.'}
            </p>
            <p className="tap-sub-dim">
              The tap was logged either way, so it shows in the station audit.
            </p>
          </>
        )}

        {status === 'error' && (
          <>
            <div className="tap-x" aria-hidden="true">!</div>
            <h1 className="tap-headline">Could Not Reach the Server</h1>
            <p className="tap-sub">{reason}</p>
            <p className="tap-sub-dim">
              A tap needs the server to resolve a subject, so this one has to
              be retried. Measurements you have already saved are queued on
              this device and are not lost.
            </p>
          </>
        )}
      </div>

      <div className="tap-footer">
        <div className="tap-station-info">
          <span className="tap-marker-badge">{markerCm} cm marker</span>
          {stationLabel && <span className="tap-station">{stationLabel}</span>}
        </div>

        {auditCounts && (auditCounts.no_data > 0 || auditCounts.unenrolled > 0 ||
          auditCounts.malformed > 0 || auditCounts.unprovisioned > 0) && (
          <button className="linkbtn" onClick={onShowAudit}>
            {/*
              Unprovisioned leads. It is the one of these that means an athlete
              walked away unmeasured, and it is fixable while they are still
              in the building.
            */}
            {[
              auditCounts.unprovisioned > 0 &&
                `${auditCounts.unprovisioned} unprovisioned band(s)`,
              auditCounts.no_data > 0 &&
                `${auditCounts.no_data} tap(s) with no data`,
              auditCounts.unenrolled > 0 &&
                `${auditCounts.unenrolled} unclaimed`,
            ].filter(Boolean).join(' · ')}
          </button>
        )}

        <div className="tap-footer-actions">
          <button className="adjust-btn" onClick={onTestMode}>
            {testMode ? 'Test mode on' : 'Test mode'}
          </button>
          <button className="adjust-btn" onClick={onSetup}>Setup</button>
        </div>
      </div>
    </div>
  )
}
