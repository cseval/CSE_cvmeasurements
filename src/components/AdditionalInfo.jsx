import { useEffect, useState } from 'react'
import BrandBar from './BrandBar.jsx'
import { tail } from '../lib/tapProtocol.js'
import { getRecord, patchRecord } from '../lib/storage.js'
import { sendCapture } from '../lib/sync.js'

const GROUPS = [
  {
    label: 'General',
    fields: [
      { key: 'age',    display: 'Age'    },
      { key: 'weight', display: 'Weight' },
    ],
  },
  {
    label: 'Hips',
    fields: [
      { key: 'hips_r_hip_er', display: 'R Hip ER' },
      { key: 'hips_r_hip_ir', display: 'R Hip IR' },
      { key: 'hips_l_hip_er', display: 'L Hip ER' },
      { key: 'hips_l_hip_ir', display: 'L Hip IR' },
    ],
  },
  {
    label: 'T-Spine',
    fields: [
      { key: 'tspine_tspine_rot_l', display: 'Rot Left'  },
      { key: 'tspine_tspine_rot_r', display: 'Rot Right' },
    ],
  },
  {
    label: 'Grip Strength',
    fields: [
      { key: 'grip_grip_str_r', display: 'Right' },
      { key: 'grip_grip_str_l', display: 'Left'  },
    ],
  },
]

/**
 * Second-screen assessment fields, attached to the SAME capture record
 * (same server trial) — not a second row for the same visit. Fields
 * carried over from the old build; save path is local-first now.
 */
export default function AdditionalInfo({ recordId, subject, onDone, onBack }) {
  const [values, setValues]     = useState({})
  const [saveState, setSaveState] = useState('idle') // idle | saving | saved | error
  const [rec, setRec]           = useState(null)

  useEffect(() => {
    getRecord('captures', recordId).then((r) => {
      setRec(r)
      setValues(r?.assessment || {})
    })
  }, [recordId])

  function handleChange(key, raw) {
    const val = raw === '' ? undefined : parseInt(raw, 10)
    setValues((prev) => ({ ...prev, [key]: isNaN(val) ? undefined : val }))
  }

  async function handleSubmit() {
    setSaveState('saving')
    try {
      const merged = { ...(rec?.assessment || {}), ...values }
      const updated = { ...(rec || { id: recordId }), assessment: merged, assessment_at: new Date().toISOString() }
      await patchRecord('captures', recordId, { assessment: merged, assessment_at: updated.assessment_at })
      setRec(updated)
      // Best effort: push now (updates the trial's result row if already
      // synced; full create if not). Failure = stays in the queue.
      try {
        await sendCapture(updated)
      } catch {
        /* background queue retries */
      }
      setSaveState('saved')
    } catch {
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
        {subject?.test && (
          <div className="subject-banner test">TEST MODE — no subject attached</div>
        )}
        {!subject?.test && subject?.uid && (
          <div className={`subject-banner ${subject.enrolled === false ? 'unenrolled' : 'enrolled'}`}>
            Tag {tail(subject.uid, 4)}
            {subject.enrolled === false && ' — NOT ENROLLED (reconcile later)'}
          </div>
        )}

        {GROUPS.map((group) => (
          <div key={group.label} className="form-section">
            <p className="form-section-label">{group.label}</p>
            <div className="form-grid">
              {group.fields.map(({ key, display }) => (
                <div key={key} className="form-field">
                  <label className="form-field-label">{display}</label>
                  <input
                    className="form-input"
                    type="number"
                    inputMode="numeric"
                    placeholder="—"
                    value={values[key] ?? ''}
                    onChange={(e) => handleChange(key, e.target.value)}
                    disabled={saveState === 'saving' || saveState === 'saved'}
                  />
                </div>
              ))}
            </div>
          </div>
        ))}

        {saveState === 'error' && (
          <div className="error-card">Save failed — check device storage and try again</div>
        )}
      </div>

      <div className="results-footer">
        {saveState === 'saved' ? (
          <>
            <div className="save-success">Additional info saved</div>
            <button className="retry-btn" onClick={onDone}>Done</button>
          </>
        ) : (
          <>
            <button
              className="retry-btn"
              onClick={handleSubmit}
              disabled={saveState === 'saving'}
            >
              {saveState === 'saving' ? 'Saving…' : 'Save'}
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
