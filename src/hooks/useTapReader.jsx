import { useCallback, useEffect, useRef } from 'react'

/**
 * Captures bracelet taps from the USB HID reader.
 *
 * The reader is a keyboard. There is no NFC API to call. On tag detection the
 * firmware types the UID as uppercase hex and presses Enter, so a tap is
 * indistinguishable from someone typing very fast into a focused text field.
 *
 * INVARIANT 1, the one that matters most:
 *
 *     Re-focus the input after every submit, every screen transition and
 *     every modal dismiss. If focus is lost, the next tap goes nowhere and
 *     presents to staff as a hardware failure.
 *
 * This is documented as the #1 integration bug across the whole NFC effort,
 * and the check-in station learned it the expensive way. The belt-and-braces
 * approach below is lifted from that build, which is field-tested:
 *
 *   - a polling re-focus every 400ms, which recovers from anything
 *   - a re-focus on any click or touch anywhere in the document
 *   - a re-focus when the tab or window regains focus, and on
 *     visibilitychange, which is what fires when an iPad is unlocked
 *
 * The poll is the load-bearing one. Every other mechanism is an optimisation
 * that makes recovery instant instead of within 400ms; the poll is what makes
 * recovery certain.
 *
 * iPad note: iOS suppresses the on-screen keyboard whenever a hardware
 * keyboard is connected, so focusing this input with the reader plugged in
 * shows nothing. With the reader UNPLUGGED — which is how you will test on a
 * desk — the software keyboard does appear and covers half the screen.
 * inputMode="none" asks iOS not to, but treat a keyboard popping up as a sign
 * the reader is not connected rather than as a UI bug.
 *
 * @param {(raw: string) => void} onTap  called with the raw scan, verbatim.
 *        Not normalized and not validated here: scan_event records exactly
 *        what the reader typed, and cleaning it up client-side would destroy
 *        the evidence of a truncated or noisy read.
 * @param {object} opts
 * @param {boolean} opts.enabled  false parks the reader without unmounting it,
 *        so focus handling keeps running and a tap is never silently dropped
 *        because the listener had been torn down.
 */
export default function useTapReader(onTap, { enabled = true } = {}) {
  const inputRef = useRef(null)
  const bufferRef = useRef('')
  const onTapRef = useRef(onTap)

  useEffect(() => { onTapRef.current = onTap }, [onTap])

  const focusInput = useCallback(() => {
    const el = inputRef.current
    if (!el) return
    // Don't steal focus from a field the operator is actually typing in
    // (station setup, manual measurement entry, the assessment form).
    const active = document.activeElement
    if (active && active !== el && active !== document.body) {
      const tag = active.tagName
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' ||
          active.isContentEditable) {
        return
      }
    }
    if (active !== el) {
      try { el.focus({ preventScroll: true }) } catch { el.focus() }
    }
  }, [])

  useEffect(() => {
    focusInput()
    const poll = setInterval(focusInput, 400)
    const events = ['click', 'touchend', 'focus', 'visibilitychange']
    events.forEach(e => document.addEventListener(e, focusInput, true))
    window.addEventListener('focus', focusInput)
    return () => {
      clearInterval(poll)
      events.forEach(e => document.removeEventListener(e, focusInput, true))
      window.removeEventListener('focus', focusInput)
    }
  }, [focusInput])

  // A UID is at most 20 characters plus a prefix. Anything longer than this
  // is a stuck key or a human leaning on the keyboard, and letting the buffer
  // grow without bound means the next real tap is appended to garbage and
  // rejected. Reset rather than truncate: a partial buffer is not salvageable.
  const MAX_BUFFER = 64

  const handleKeyDown = useCallback((e) => {
    if (e.key === 'Enter') {
      e.preventDefault()
      const raw = bufferRef.current
      bufferRef.current = ''
      if (inputRef.current) inputRef.current.value = ''
      // Re-focus immediately rather than waiting for the poll. This is the
      // exact moment focus is most likely to be lost, because a submit often
      // triggers a re-render that replaces the input's parent.
      setTimeout(focusInput, 0)
      if (raw && enabled) onTapRef.current?.(raw)
      return
    }

    // Escape clears a half-typed buffer, so an operator who notices the
    // reader misfired can reset without submitting garbage.
    if (e.key === 'Escape') {
      bufferRef.current = ''
      if (inputRef.current) inputRef.current.value = ''
      return
    }

    if (e.key === 'Backspace' || e.key === 'Delete') {
      bufferRef.current = bufferRef.current.slice(0, -1)
      return
    }

    // Ignore modifier combinations and navigation keys; the reader never
    // sends them, so anything here came from a human or a stray keyboard.
    if (e.key.length === 1 && !e.ctrlKey && !e.metaKey && !e.altKey) {
      if (bufferRef.current.length >= MAX_BUFFER) bufferRef.current = ''
      bufferRef.current += e.key
    }
  }, [enabled, focusInput])

  const handleChange = useCallback((e) => {
    // Keep the buffer authoritative even if the browser autofills or an IME
    // commits a whole string at once instead of key by key.
    bufferRef.current = e.target.value
  }, [])

  /**
   * Render this wherever taps should be received. It is visually absent but
   * NOT display:none and NOT disabled — a hidden-by-display or disabled input
   * cannot hold focus, which is precisely the failure this whole hook exists
   * to prevent.
   */
  const TapCatcher = useCallback(() => (
    <input
      ref={inputRef}
      className="tap-catcher"
      onKeyDown={handleKeyDown}
      onChange={handleChange}
      onBlur={() => setTimeout(focusInput, 0)}
      inputMode="none"
      autoComplete="off"
      autoCorrect="off"
      autoCapitalize="off"
      spellCheck="false"
      aria-hidden="true"
      tabIndex={-1}
    />
  ), [handleKeyDown, handleChange, focusInput])

  return { TapCatcher, focusInput }
}
