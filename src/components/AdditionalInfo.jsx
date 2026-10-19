import { useState } from 'react'
import BrandBar from './BrandBar.jsx'
import VirtualKeyboard, { VKField, useVirtualKeyboard } from '../shared/VirtualKeyboard.jsx'

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
 * Entry is through the on-screen keyboard, because the NFC reader is a USB
 * keyboard and iOS hides the software one whenever it is plugged in.
 *
 * Draft values are held as STRINGS and parsed once, on save. The previous
 * version parsed on every keystroke and fed the number back in as the field's
 * value, which meant a decimal point could never survive being typed: "31."
 * parses to 31, re-renders as "31", and the dot the operator just pressed
 * disappears. Decimals are the entire point of these fields.
 *
 * Like Save on the previous screen, this writes to the local queue and returns
 * — the operator is not waiting on wifi.
 */
const GROUPS = [
  {
    label: 'General',
    fields: [
      { key: 'age_years', display: 'Age', unit: 'yrs', variant: 'integer', max: 3 },
      { key: 'weight_lb', display: 'Weight', unit: 'lb', variant: 'decimal', max: 6 },
    ],
  },
  {
    label: 'Hips',
    fields: [
      { key: 'hip_er_r', display: 'R Hip ER', unit: '°', variant: 'decimal', max: 5 },
      { key: 'hip_ir_r', display: 'R Hip IR', unit: '°', variant: 'decimal', max: 5 },
      { key: 'hip_er_l', display: 'L Hip ER', unit: '°', variant: 'decimal', max: 5 },
      { key: 'hip_ir_l', display: 'L Hip IR', unit: '°', variant: 'decimal', max: 5 },
    ],
  },
  {
    label: 'T-Spine',
    fields: [
      { key: 'tspine_rot_l', display: 'Rot Left', unit: '°', variant: 'decimal', max: 5 },
      { key: 'tspine_rot_r', display: 'Rot Right', unit: '°', variant: 'decimal', max: 5 },
    ],
  },
  {
    label: 'Grip Strength',
    fields: [
      { key: 'grip_str_r', display: 'Right', unit: 'kgf', variant: 'decimal', max: 5 },
      { key: 'grip_str_l', display: 'Left', unit: 'kgf', variant: 'decimal', max: 5 },
    ],
  },
]

/**
 * Strings in, numbers out. Anything that is blank, or a lone decimal point
 * left behind by a backspace, is simply not submitted — a field the operator
 * did not fill must stay absent rather than arrive as 0.
 */
function parseDraft(draft) {
  const out = {}
  for (const [key, raw] of Object.entries(draft)) {
    if (raw == null || raw === '' || raw === '.') continue
    const parsed = parseFloat(raw)
    if (Number.isNaN(parsed)) continue
    out[key] = key === 'age_years' ? Math.round(parsed) : parsed
  }
  return out
}

export default function AdditionalInfo({ subjectToken, onSave, onDone, onBack }) {
  const [draft, setDraft] = useState({})
  const [saveState, setSaveState] = useState('idle')
  const [saveError, setSaveError] = useState(null)
  const kb = useVirtualKeyboard()

  const locked = saveState === 'saving' || saveState === 'saved'
  const values = parseDraft(draft)
  const hasValues = Object.keys(values).length > 0

  function setField(key, raw) {
    setDraft(prev => ({ ...prev, [key]: raw }))
  }

  async function handleSubmit() {
    kb.close()
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
              {group.fields.map(({ key, display, unit, variant, max }) => (
                <VKField
                  key={key}
                  kb={kb}
                  name={key}
                  label={display}
                  unit={unit}
                  variant={variant}
                  maxLength={max}
                  value={draft[key] ?? ''}
                  onChange={raw => setField(key, raw)}
                  disabled={locked}
                />
              ))}
            </div>
          </div>
        ))}

        {saveState === 'error' && (
          <div className="error-card">
            Could not save to this device{saveError ? `: ${saveError}` : ''}.
          </div>
        )}

        <VirtualKeyboard kb={kb} />
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
