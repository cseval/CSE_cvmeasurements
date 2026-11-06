import { useCallback, useEffect, useRef, useState } from 'react'
import VirtualKeyboard, { useVirtualKeyboard, VKField } from '../shared/VirtualKeyboard.jsx'
import { login } from '../lib/auth.js'
import { fetchHealth } from '../lib/api.js'

/**
 * The PIN screen.
 *
 * Built on the shared on-screen keypad rather than an <input>, for the same
 * reason every other field in this app is: the NFC reader is a USB keyboard,
 * and iOS hides the software keyboard whenever one is attached. An <input>
 * here would be a box the operator cannot type into.
 *
 * Taps are ignored while this is up. The reader is still live — TapCatcher
 * stays mounted at the root on every screen, invariant 1 — but App routes a
 * tap arriving here to nothing. A bracelet brushing the reader at the login
 * screen must not write a scan_event that produced no data, which is exactly
 * the phantom gap the station audit exists to surface.
 *
 * Nothing identifying is held here. The PIN is posted once and dropped; it is
 * never stored, never logged, and never put in the URL.
 */
export default function PinLogin({ onLoggedIn }) {
  const kb = useVirtualKeyboard()
  const [pin, setPin] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState(null)
  const [setupProblem, setSetupProblem] = useState(null)

  // Guards the auto-submit: without it, a render between "6th digit typed"
  // and "request sent" fires a second attempt, and a second attempt is now a
  // second strike against the lockout.
  const submittingRef = useRef(false)

  // Tell the operator the difference between "you typed it wrong" and "this
  // station was never given a PIN to check against". The second is not
  // something tapping harder will fix.
  useEffect(() => {
    let alive = true
    fetchHealth()
      .then(h => {
        if (!alive) return
        if (h && h.pin_login_ready === false) {
          setSetupProblem(
            (h.pin_login_problems || []).join('; ') ||
            'The server has no PINs configured.')
        }
      })
      .catch(() => { /* offline: let the attempt produce the real error */ })
    return () => { alive = false }
  }, [])

  const submit = useCallback(async (value) => {
    if (submittingRef.current) return
    submittingRef.current = true
    setBusy(true)
    setError(null)
    try {
      const session = await login(value)
      kb.close()
      onLoggedIn(session)
    } catch (err) {
      setError(
        err.status === 429
          ? err.message
          : err.status === 503
            ? err.message
            : 'That PIN was not recognised.')
      setPin('')
    } finally {
      submittingRef.current = false
      setBusy(false)
    }
  }, [kb, onLoggedIn])

  // Six digits is the whole PIN, so there is nothing left to confirm. The
  // button stays for anyone who would rather press it.
  const handleChange = useCallback((next) => {
    const digits = next.replace(/\D/g, '').slice(0, 6)
    setPin(digits)
    setError(null)
    if (digits.length === 6) submit(digits)
  }, [submit])

  const open = kb.active?.name === 'pin'

  return (
    <div className="pin-screen">
      <div className="pin-card">
        <h1 className="pin-title">CV Lab</h1>
        <p className="pin-sub">Enter the station PIN to start measuring.</p>

        {setupProblem && (
          <div className="error-card" style={{ fontSize: 13 }}>
            Login is not set up on the server: {setupProblem}
          </div>
        )}

        <VKField
          kb={kb}
          name="pin"
          label="PIN"
          value={pin}
          onChange={handleChange}
          variant="integer"
          maxLength={6}
          mask
          placeholder="——————"
          disabled={busy}
          hint={open ? null : 'Tap to enter'}
        />

        {error && <div className="error-card" style={{ fontSize: 13 }}>{error}</div>}

        <button
          className="retry-btn pin-submit"
          disabled={busy || pin.length !== 6}
          onMouseDown={e => e.preventDefault()}
          onClick={() => submit(pin)}
        >
          {busy ? 'Checking…' : 'Sign in'}
        </button>

        <p className="pin-foot">
          Same PIN as the check-in desk. It signs you out at the end of the day.
        </p>
      </div>

      <VirtualKeyboard kb={kb} />
    </div>
  )
}
