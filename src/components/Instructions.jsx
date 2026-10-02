import BrandBar from './BrandBar.jsx'

/**
 * Photo-setup guidance, rewritten for the tap flow.
 *
 * The setup guidance itself is carried over — it is what produces good
 * measurements and none of it changed. What changed is step 1: there is no
 * roster to search and no athlete to pick, so the flow starts with a tap.
 */
const STEPS = [
  {
    title: 'Athlete taps in',
    body: 'The athlete holds their bracelet flat on the reader until it beeps once. '
      + 'Two short beeps means the same bracelet is still cooling down; three means the read failed.',
  },
  {
    title: 'T-pose against the wall',
    body: 'Back near the wall, arms fully extended horizontally at shoulder height, '
      + 'in the same plane as the marker.',
  },
  {
    title: 'Palms forward',
    body: 'Palms face the camera, fingers together and straight.',
  },
  {
    title: 'Frame the shot',
    body: 'Camera at chest height, far enough back that head to feet is in frame '
      + 'with the marker fully visible.',
  },
  {
    title: 'Lighting',
    body: 'Even light. Shadows on the hands are the main cause of hand-span detection failure.',
  },
]

export default function Instructions({ onStart, markerCm }) {
  return (
    <div className="instructions-screen">
      <BrandBar />
      <div className="instructions-header">
        <div>
          <h1>Before You Start</h1>
          <p className="instructions-sub">
            {markerCm} cm marker taped flat on the wall at wrist height
          </p>
        </div>
      </div>

      <div className="instructions-body">
        {STEPS.map((step, i) => (
          <div key={i} className="step-row">
            <div className="step-num">{i + 1}</div>
            <div className="step-text">
              <span className="step-title">{step.title}</span>
              <span className="step-body">{step.body}</span>
            </div>
          </div>
        ))}

        <div className="warn-card">
          Print the marker at Actual size, not Fit to page, and check that the
          size you selected in setup matches the print taped to the wall. The
          app cannot tell the difference, and a mismatch scales every
          measurement in the shift by a constant factor.
        </div>
      </div>

      <div className="instructions-footer">
        <button className="retry-btn" onClick={onStart}>Ready for Taps</button>
      </div>
    </div>
  )
}
