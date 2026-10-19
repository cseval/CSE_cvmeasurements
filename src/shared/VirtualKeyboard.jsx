import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import './VirtualKeyboard.css'

/* ===========================================================================
 * On-screen keyboard for stations that have a USB HID NFC reader attached.
 *
 * WHY THIS EXISTS
 *
 * The bracelet reader (PN532 + RP2040) enumerates as a USB keyboard. iOS and
 * iPadOS suppress the software keyboard whenever a hardware keyboard is
 * connected, so with the reader plugged in — which is always, in the field —
 * every text and number field in the app becomes impossible to fill. On the
 * CV station that blocks Station Setup outright, because the operator name is
 * a required field.
 *
 * SECOND, LESS OBVIOUS REASON
 *
 * The tap reader works by keeping a hidden input focused and listening for
 * the keystrokes the reader types. Any real <input> that takes focus steals
 * those keystrokes: the UID lands in a name or weight field and the tap is
 * lost entirely — no scan_event, no audit row, and the "another bracelet was
 * tapped" interrupt never fires because the tap handler is never called.
 *
 * Fields built with VKField are <div>s. They are never focused, so the tap
 * catcher keeps focus permanently and that whole class of failure goes away.
 * Every key below calls preventDefault on mousedown for the same reason: a
 * <button> that takes focus is a <button> that swallows the next tap.
 *
 * THIS FILE IS VENDORED
 *
 * The CV measurement app and the check-in app are separate repositories that
 * share the same hardware and the same problem. This module imports nothing
 * app-specific on purpose, so the two copies can stay byte-identical. If you
 * change one, change the other:
 *
 *   CSE_cvmeasurements  src/shared/VirtualKeyboard.{jsx,css}
 *   CSE_checkin         src/shared/VirtualKeyboard.{jsx,css}
 * ======================================================================== */

const ROW_DIGITS = ['1', '2', '3', '4', '5', '6', '7', '8', '9', '0']
const ROW_TOP    = ['q', 'w', 'e', 'r', 't', 'y', 'u', 'i', 'o', 'p']
const ROW_HOME   = ['a', 's', 'd', 'f', 'g', 'h', 'j', 'k', 'l']
const ROW_BOTTOM = ['z', 'x', 'c', 'v', 'b', 'n', 'm']

const NUMERIC_VARIANTS = new Set(['decimal', 'integer'])

/** Nearest ancestor that actually scrolls, or null if the page itself does. */
function scrollParent(el) {
  let p = el?.parentElement
  while (p) {
    const style = getComputedStyle(p)
    if (/(auto|scroll)/.test(style.overflowY) && p.scrollHeight > p.clientHeight) return p
    p = p.parentElement
  }
  return null
}

/**
 * Owns which field is being edited. Create one per screen and pass it to every
 * VKField on that screen plus the single <VirtualKeyboard> at the bottom.
 */
export function useVirtualKeyboard() {
  const [active, setActive] = useState(null)
  const registry = useRef(new Map())

  const register = useCallback((name, entry) => {
    registry.current.set(name, entry)
  }, [])

  const unregister = useCallback((name) => {
    registry.current.delete(name)
    setActive(cur => (cur?.name === name ? null : cur))
  }, [])

  const entryFor = useCallback((name) => (name ? registry.current.get(name) : undefined), [])

  const open = useCallback((name) => setActive({ name }), [])
  const close = useCallback(() => setActive(null), [])

  /**
   * Registered field names in document order. Computed on demand rather than
   * tracked at registration time, because mount order and visual order drift
   * apart as soon as a field is conditionally rendered.
   */
  const ordered = useCallback(() => {
    const live = [...registry.current.entries()]
      .filter(([, e]) => e.elRef?.current?.isConnected && !e.disabled)
    live.sort(([, a], [, b]) => {
      const pos = a.elRef.current.compareDocumentPosition(b.elRef.current)
      if (pos & Node.DOCUMENT_POSITION_FOLLOWING) return -1
      if (pos & Node.DOCUMENT_POSITION_PRECEDING) return 1
      return 0
    })
    return live.map(([name]) => name)
  }, [])

  /** Move to the next/previous field. Past the last field closes the keyboard. */
  const step = useCallback((delta) => {
    setActive(cur => {
      if (!cur) return cur
      const names = ordered()
      const i = names.indexOf(cur.name)
      if (i === -1) return null
      const next = names[i + delta]
      return next ? { name: next } : null
    })
  }, [ordered])

  const hasNext = useCallback(() => {
    if (!active) return false
    const names = ordered()
    const i = names.indexOf(active.name)
    // -1 means the active field has been filtered out (disabled, or unmounted
    // between renders). step() closes the keyboard in that case, so Next must
    // not advertise itself as a move to another field.
    if (i === -1) return false
    return i < names.length - 1
  }, [active, ordered])

  return useMemo(
    () => ({ active, open, close, register, unregister, entryFor, step, hasNext }),
    [active, open, close, register, unregister, entryFor, step, hasNext],
  )
}

/**
 * A field the on-screen keyboard can fill. Renders as a div, never an input,
 * so it cannot take focus away from the tap catcher.
 *
 * `value` is always a STRING. Parse it where you consume it, not here — a
 * controlled field whose value round-trips through parseFloat cannot accept a
 * decimal point, because "31." parses to 31 and the dot disappears as you
 * type it.
 */
export function VKField({
  kb,
  name,
  label,
  value = '',
  onChange,
  variant = 'text',
  placeholder,
  unit,
  maxLength,
  disabled = false,
  hint,
  className = '',
}) {
  // Pulled out individually because `kb` itself is a new object on every open
  // and close — it carries `active` — while these two are useCallback([]) and
  // never change identity. An effect that depends on `kb` re-runs constantly;
  // one that depends on these runs only when the field really comes or goes.
  const { register, unregister } = kb

  const elRef = useRef(null)
  const entryRef = useRef(null)
  entryRef.current = { name, label, value, onChange, variant, maxLength, disabled, elRef }

  // Registration happens in three places, and the split matters.
  //
  // 1. During render, so <VirtualKeyboard> — which sits later in the tree —
  //    reads the live value in the same pass rather than one keystroke stale.
  //
  // 2. In a dependency-less effect with NO cleanup, which re-registers after
  //    StrictMode's simulated unmount/remount. StrictMode tears a component
  //    down and builds it back up without re-rendering in between, so without
  //    this the field would be unregistered for good on the second mount —
  //    broken in dev, fine in prod, which is the worst way to be wrong.
  //
  // 3. The unmount cleanup lives in its OWN effect, keyed on the stable
  //    `unregister` and `name`. It must not share the dependency-less effect,
  //    whose cleanup runs after every render, and it must not depend on `kb`,
  //    whose identity changes on every open. Either mistake makes unregister()
  //    fire mid-session, and unregister() clears the active field — so the
  //    keyboard closes itself on the very render that opened it.
  register(name, entryRef.current)
  useEffect(() => { register(name, entryRef.current) })
  useEffect(() => () => unregister(name), [register, unregister, name])

  const isActive = kb.active?.name === name

  return (
    <div className={`vk-field-wrap ${className}`}>
      {label && (
        <span className="vk-field-label">
          {label}
          {unit && <span className="vk-field-unit"> {unit}</span>}
        </span>
      )}
      <div
        ref={elRef}
        className={
          'vk-field' +
          (isActive ? ' vk-field-active' : '') +
          (disabled ? ' vk-field-disabled' : '')
        }
        role="textbox"
        aria-readonly="true"
        aria-label={label || name}
        tabIndex={-1}
        onMouseDown={e => e.preventDefault()}
        onClick={() => { if (!disabled) kb.open(name) }}
      >
        {value !== '' && value != null
          ? <span className="vk-field-value">{value}</span>
          : <span className="vk-field-placeholder">{placeholder || '—'}</span>}
        {isActive && <span className="vk-caret" aria-hidden="true" />}
      </div>
      {hint && <span className="vk-field-hint">{hint}</span>}
    </div>
  )
}

function Key({ children, onPress, className = '', span, disabled }) {
  return (
    <button
      type="button"
      className={`vk-key ${className}`}
      style={span ? { gridColumn: `span ${span}` } : undefined}
      disabled={disabled}
      // Never take focus: a focused button is a button that eats the next tap.
      onMouseDown={e => e.preventDefault()}
      onClick={onPress}
    >
      {children}
    </button>
  )
}

/** Render once per screen, as the last child. Nothing shows until a field is open. */
export default function VirtualKeyboard({ kb }) {
  const [shift, setShift] = useState(false)
  const panelRef = useRef(null)
  const { entryFor } = kb               // stable; `kb` is not (see VKField)
  const activeName = kb.active?.name ?? null
  const entry = entryFor(activeName)

  // Lift the active field clear of the panel. Depends only on which field is
  // active — re-running on every keystroke would fight the operator's thumb.
  useEffect(() => {
    if (!activeName) return
    const id = requestAnimationFrame(() => {
      const el = entryFor(activeName)?.elRef?.current
      const panel = panelRef.current
      if (!el || !panel) return
      const overlap = el.getBoundingClientRect().bottom + 16 - panel.getBoundingClientRect().top
      if (overlap <= 0) return
      const sc = scrollParent(el)
      if (sc) sc.scrollTop += overlap
      else window.scrollBy(0, overlap)
    })
    return () => cancelAnimationFrame(id)
  }, [activeName, entryFor])

  useEffect(() => { if (!activeName) setShift(false) }, [activeName])

  // ordered() reads elRef.current, which is null until React commits. When a
  // screen mounts its fields and opens the keyboard in the same commit — as
  // Results does on "Enter Manually" — the first render computes hasNext()
  // from an empty list and greys out Next with nothing to un-grey it. One
  // forced re-render after commit is enough.
  const [, settle] = useState(0)
  useLayoutEffect(() => { settle(n => n + 1) }, [activeName])

  if (!entry) return null

  const numeric = NUMERIC_VARIANTS.has(entry.variant)
  const value = entry.value ?? ''

  function emit(ch) {
    if (entry.disabled) return
    const cur = String(value)
    if (entry.variant === 'decimal' && ch === '.') {
      if (cur.includes('.')) return
      const dotted = cur + '.'
      if (entry.maxLength && dotted.length > entry.maxLength) return
      // Deliberately NOT "0." for an empty field. A lone "0." parses to 0 and
      // would be saved as a measured zero, so a thumb that catches the decimal
      // key instead of a digit must leave something the parser throws away.
      // ".5" still parses to 0.5, so nothing is lost by starting with the dot.
      entry.onChange(dotted)
      return
    }
    const next = cur + ch
    if (entry.maxLength && next.length > entry.maxLength) return
    entry.onChange(next)
    if (shift) setShift(false)
  }

  const backspace = () => { if (!entry.disabled) entry.onChange(String(value).slice(0, -1)) }
  const clear = () => { if (!entry.disabled) entry.onChange('') }
  const letter = (c) => (shift ? c.toUpperCase() : c)

  return (
    <>
      {/* Keeps the last field reachable above the panel on short screens. */}
      <div className="vk-spacer" aria-hidden="true" />
      <div className="vk-panel" ref={panelRef} role="group" aria-label="On-screen keyboard">
        <div className="vk-bar">
          <span className="vk-bar-label">{entry.label || entry.name}</span>
          <span className="vk-bar-value">{value || '—'}</span>
          <button
            type="button"
            className="vk-bar-close"
            onMouseDown={e => e.preventDefault()}
            onClick={kb.close}
            aria-label="Close keyboard"
          >
            Done
          </button>
        </div>

        {numeric ? (
          <div className="vk-grid vk-grid-num">
            {['1', '2', '3'].map(d => <Key key={d} onPress={() => emit(d)}>{d}</Key>)}
            <Key className="vk-key-util" onPress={backspace}>⌫</Key>

            {['4', '5', '6'].map(d => <Key key={d} onPress={() => emit(d)}>{d}</Key>)}
            <Key className="vk-key-util" onPress={clear}>Clear</Key>

            {['7', '8', '9'].map(d => <Key key={d} onPress={() => emit(d)}>{d}</Key>)}
            <Key className="vk-key-util" onPress={() => kb.step(1)} disabled={!kb.hasNext()}>Next</Key>

            <Key span={2} onPress={() => emit('0')}>0</Key>
            <Key
              onPress={() => emit('.')}
              disabled={entry.variant !== 'decimal'}
            >
              .
            </Key>
            <Key className="vk-key-go" onPress={kb.close}>Done</Key>
          </div>
        ) : (
          <div className="vk-rows">
            <div className="vk-row">
              {ROW_DIGITS.map(d => <Key key={d} onPress={() => emit(d)}>{d}</Key>)}
            </div>
            <div className="vk-row">
              {ROW_TOP.map(c => <Key key={c} onPress={() => emit(letter(c))}>{letter(c)}</Key>)}
            </div>
            <div className="vk-row vk-row-inset">
              {ROW_HOME.map(c => <Key key={c} onPress={() => emit(letter(c))}>{letter(c)}</Key>)}
            </div>
            <div className="vk-row">
              <Key
                className={`vk-key-util${shift ? ' vk-key-on' : ''}`}
                onPress={() => setShift(s => !s)}
              >
                ⇧
              </Key>
              {ROW_BOTTOM.map(c => <Key key={c} onPress={() => emit(letter(c))}>{letter(c)}</Key>)}
              <Key className="vk-key-util" onPress={backspace}>⌫</Key>
            </div>
            <div className="vk-row">
              <Key onPress={() => emit('-')}>-</Key>
              <Key onPress={() => emit('_')}>_</Key>
              <Key onPress={() => emit('.')}>.</Key>
              {entry.variant === 'email' && <Key onPress={() => emit('@')}>@</Key>}
              <Key className="vk-key-space" onPress={() => emit(' ')}>space</Key>
              <Key className="vk-key-util" onPress={clear}>Clear</Key>
              <Key
                className="vk-key-util"
                onPress={() => kb.step(1)}
                disabled={!kb.hasNext()}
              >
                Next
              </Key>
              <Key className="vk-key-go" onPress={kb.close}>Done</Key>
            </div>
          </div>
        )}
      </div>
    </>
  )
}
