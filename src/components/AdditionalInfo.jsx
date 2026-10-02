import { useState } from 'react'
import BrandBar from './BrandBar.jsx'

/**
 * Manually-measured assessment fields, attached to the same trial as the CV
 * measurements.
 *
 * Same fields as before, with the column names the new schema uses. Two
 * differences worth noting:
 *
 *   - `weight` is now `weight_lb`. The production column was just "weight"
 *     with no unit anywhere, which is how a number ends up ambiguous three
 *     years later.
 *   - Values are decimals, not integers. A grip reading of 31.5 kgf and a hip
 *     ER of 42.5 degrees are both things the instruments actually produce, and
 *     the old integer-only inputs silently rounded them.
 *
 * Like Save on the previous screen, this writes to the local queue and returns
 * — the operator is not waiting on wifi.
 */
const GROUPS = [
  {
    label: 'General',
    fields: [
      { key: 'age_years', display: 'Age', step: 1, unit: 'yrs' },
      { key: 'weight_lb', display: 'Weight', step: 0.5, unit: 'lb' },
    ],
  },
  {
    label: 'Hips',
    fields: [
      { key: 'hip_er_r', display: 'R Hip ER', step: 0.5, unit: '°' },
      { key: 'hip_ir_r', display: 'R Hip IR', step: 0.5, unit: '°' },
      { key: 'hip_er_l', display: 'L Hip ER', step: 0.5, unit: '°' },
      { key: 'hip_ir_l', display: 'L Hip IR', step: 0.5, unit: '°' },
    ],
  },
  {
    label: 'T-Spine',
    fields: [
      { key: 'tspine_rot_l', display: 'Rot Left', step: 0.5, unit: '°' },
      { key: 'tspine_rot_r', display: 'Rot Right', step: 0.5, unit: '°' },
    ],
  },
  {
    label: 'Grip Strength',
    fields: [
      { key: 'grip_str_r', display: 'Right', step: 0.5, unit: 'kgf' },
      { key: 'grip_str_l', display: 'Left', step: 0.5, unit: 'kgf' },
    ],
  },
]

export default function AdditionalInfo({ subjectToken, onSave, onDone, onBack }) {
  const [values, setValues] = useState({})
  const [saveState, setSaveState] = useState('idle')
  const [saveError, setSaveError] = useState(null)

  function handleChange(key, raw) {
    setValues(prev => {
      const next = { ...prev }
      if (raw === '') {
        delete next[key]
        return next
      }
      const parsed = parseFloat(raw)
      if (!isNaN(parsed)) next[key] = key === 'age_years' ? Math.round(parsed) : parsed
      return next
    })
  }

  const hasValues = Object.keys(values).length > 0

  async function handleSubmit() {
    setSaveState('saving')
    setSaveError(null)
    try {
      await onSave(values)
      setSaveState('saved')
    } catch (err) {
      setSaveError(err.message)
      setSaveState('error')
    }
  }

  return (
    <div className="additional-screen">
      <BrandBar />
      <div className="results-header">
        <h1>Additional Info</h1>
      </div>

      <div className="results-body">
        {subjectToken && (
          <div className="subject-banner">
            <span className="subject-token">{subjectToken}</span>
          </div>
        )}

        {GROUPS.map(group => (
          <div key={group.label} className="form-section">
            <p className="form-section-label">{group.label}</p>
            <div className="form-grid">
              {group.fields.map(({ key, display, step, unit }) => (
                <div key={key} className="form-field">
                  <label className="form-field-label">
                    {display} <span className="form-field-unit">{unit}</span>
                  </label>
                  <input
                    className="form-input"
                    type="number"
                    inputMode="decimal"
                    step={step}
                    placeholder="—"
                    value={values[key] ?? ''}
                    onChange={e => handleChange(key, e.target.value)}
                    disabled={saveState === 'saving' || saveState === 'saved'}
                  />
                </div>
              ))}
            </div>
          </div>
        ))}

        {saveState === 'error' && (
          <div className="error-card">
            Could not save to this device{saveError ? `: ${saveError}` : ''}.
          </div>
        )}
      </div>

      <div className="results-footer">
        {saveState === 'saved' ? (
          <>
            <div className="save-success">Saved on this device</div>
            <button className="retry-btn" onClick={onDone}>Next Athlete</button>
          </>
        ) : (
          <>
            <button
              className="retry-btn"
              onClick={handleSubmit}
              disabled={saveState === 'saving' || !hasValues}
            >
              {saveState === 'saving' ? 'Saving…' : hasValues ? 'Save' : 'Nothing entered'}
            </button>
            <button className="adjust-btn" onClick={onDone} disabled={saveState === 'saving'}>
              Skip
            </button>
            {onBack && (
              <button className="adjust-btn" onClick={onBack} disabled={saveState === 'saving'}>
                Back to Results
              </button>
            )}
          </>
        )}
      </div>
    </div>
  )
}
