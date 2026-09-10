import { useEffect, useRef } from 'react'
import { validateUid } from '../lib/tapProtocol.js'

const isTypingTarget = (el) =>
  el &&
  (el.tagName === 'INPUT' ||
    el.tagName === 'TEXTAREA' ||
    el.tagName === 'SELECT' ||
    el.isContentEditable)

/**
 * Persistent tap listener (handoff §4.2 + invariant 1, the #1
 * integration bug across the whole NFC effort).
 *
 * The HID reader is indistinguishable from someone typing very fast into
 * a focused text field, so this component keeps a hidden, always-focused
 * input mounted for the life of the app. It is mounted ONCE in App,
 * outside the screen switch, so no navigation, modal, or re-render can
 * ever unmount it.
 *
 * Focus discipline:
 *  - re-focus after EVERY submit (Enter handler);
 *  - re-focus on window focus and on tab-visibility return;
 *  - re-focus after any blur that did not move focus to a real typing
 *    field (manual entry, station setup).
 * While a visible input is focused, taps legitimately land there — "a tap
 * is typing" — and this component steps aside.
 */
export default function TapCatcher({ enabled, prefix = '', onValidTap, onInvalidTap }) {
  const inputRef = useRef(null)
  const bufferRef = useRef('')
  const latest = useRef({})
  latest.current = { enabled, prefix, onValidTap, onInvalidTap }

  const takeFocus = () => {
    const el = inputRef.current
    if (!el) return
    const a = document.activeElement
    if (a && a !== el && isTypingTarget(a)) return // respect manual entry / setup forms
    if (a !== el) el.focus({ preventScroll: true })
  }

  useEffect(() => {
    const onWindowFocus = () => takeFocus()
    const onVisibility = () => {
      if (!document.hidden) takeFocus()
    }
    const onFocusOut = () => {
      const a = document.activeElement
      if (a && a !== inputRef.current && isTypingTarget(a)) return
      setTimeout(takeFocus, 0)
    }
    window.addEventListener('focus', onWindowFocus)
    document.addEventListener('visibilitychange', onVisibility)
    document.addEventListener('focusout', onFocusOut)
    takeFocus()
    return () => {
      window.removeEventListener('focus', onWindowFocus)
      document.removeEventListener('visibilitychange', onVisibility)
      document.removeEventListener('focusout', onFocusOut)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  function onKeyDown(e) {
    const { enabled, prefix, onValidTap, onInvalidTap } = latest.current

    if (e.key === 'Enter') {
      e.preventDefault()
      e.stopPropagation()
      const raw = bufferRef.current
      bufferRef.current = ''
      takeFocus() // invariant 1: re-focus after every submit, immediately
      if (!raw) return
      if (!enabled) {
        onInvalidTap?.(raw, 'not waiting for a tap — finish the current capture first')
        return
      }
      const v = validateUid(raw, prefix)
      if (v.ok) onValidTap?.({ uid: v.uid, raw })
      else onInvalidTap?.(raw, v.reason)
      return
    }
    if (e.key === 'Backspace' || e.key === 'Delete') {
      bufferRef.current = bufferRef.current.slice(0, -1)
      return
    }
    if (e.key === 'Escape') {
      bufferRef.current = ''
      return
    }
    if (e.key.length === 1 && !e.ctrlKey && !e.metaKey && !e.altKey) {
      // Accumulate whatever the reader typed; validate the whole thing on
      // Enter so a misconfigured PREFIX or a stray char fails loudly
      // instead of being silently dropped.
      if (bufferRef.current.length >= 64) bufferRef.current = ''
      bufferRef.current += e.key
    }
  }

  return (
    <input
      ref={inputRef}
      type="text"
      aria-hidden="true"
      tabIndex={-1}
      autoComplete="off"
      autoCorrect="off"
      autoCapitalize="off"
      spellCheck={false}
      inputMode="none"
      onKeyDown={onKeyDown}
      style={{
        position: 'fixed',
        left: -200,
        top: 0,
        width: 1,
        height: 1,
        opacity: 0,
        pointerEvents: 'none',
      }}
    />
  )
}
