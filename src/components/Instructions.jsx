import BrandBar from './BrandBar.jsx'

const FLOW_STEPS = [
  {
    title: 'Athlete taps',
    body: 'The athlete holds their bracelet to the reader. It types the tag code and presses Enter by itself — no name is ever entered here, and the operator never picks anyone off a roster.',
  },
  {
    title: 'Capture',
    body: 'Frame the T-pose and shoot. Measurements come back in centimeters with an annotated photo showing exactly which points were used. Drag to correct, or type values in if detection fails.',
  },
  {
    title: 'Save',
    body: 'The capture is stored on this device first, then synced in the background. Every save is a new trial — a repeat visit is never overwritten. A tag that isn’t enrolled yet still saves; flag it for check-in.',
  },
]

const PHOTO_STEPS = [
  {
    title: 'Print the marker',
    body: 'Print a 12x12, 16x16, or 20x20 marker at “Actual size”.',
  },
  {
    title: 'T-pose',
    body: 'Athlete stands with their back close to the wall, arms fully extended horizontally at shoulder height, marker taped beside them at wrist height.',
  },
  {
    title: 'Palms forward',
    body: 'Palms face the camera, fingers together and straight.',
  },
  {
    title: 'Frame the shot',
    body: 'Hold the camera at chest height. The full body — head to feet — must be in frame, with the marker fully visible.',
  },
  {
    title: 'Lighting',
    body: 'Use even light. Avoid strong shadows on the hands or feet — shadows reduce detection accuracy.',
  },
]

/**
 * Entry screen — rewritten for the tap flow (handoff §2.4), photo-setup
 * guidance carried over.
 */
export default function Instructions({ onStart }) {
  return (
    <div className="instructions-screen">
      <BrandBar />
      <div className="instructions-header">
        <div>
          <h1>How this station works</h1>
          <p className="instructions-sub">NFC tap → capture → save · no names, no roster</p>
        </div>
      </div>

      <div className="instructions-body">
        <p className="setup-step-label">The flow</p>
        {FLOW_STEPS.map((step, i) => (
          <div key={i} className="step-row">
            <div className="step-num">{i + 1}</div>
            <div className="step-text">
              <span className="step-title">{step.title}</span>
              <span className="step-body">{step.body}</span>
            </div>
          </div>
        ))}

        <div className="setup-divider" />
        <p className="setup-step-label">Photo setup</p>
        {PHOTO_STEPS.map((step, i) => (
          <div key={i} className="step-row">
            <div className="step-num">{i + 1}</div>
            <div className="step-text">
              <span className="step-title">{step.title}</span>
              <span className="step-body">{step.body}</span>
            </div>
          </div>
        ))}
      </div>

      <div className="instructions-footer">
        <button className="retry-btn" onClick={onStart}>Continue</button>
      </div>
    </div>
  )
}
