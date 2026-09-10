// Tap protocol — shared by the TapCatcher UI and the sync engine.
//
// The reader is a USB HID keyboard (NEW Pipeline/firmware/code.py):
// it types the UID as uppercase hex, no separators, then presses Enter.
// UID length is NOT fixed — NTAG21x is 7 bytes -> 14 chars, Mifare
// Classic is 4 bytes -> 8 chars — so validate 8-20 hex chars with even
// length, plus the firmware's optional PREFIX (handoff §3.3). Never
// hard-code 14.

export const UID_MIN = 8
export const UID_MAX = 20

export function normalizeUid(raw, prefix = '') {
  let s = String(raw ?? '').trim().toUpperCase()
  const p = String(prefix ?? '').trim().toUpperCase()
  if (p && s.startsWith(p)) s = s.slice(p.length)
  return s
}

/**
 * @returns {{ok: true, uid: string} | {ok: false, reason: string}}
 */
export function validateUid(raw, prefix = '') {
  const s = normalizeUid(raw, prefix)
  if (!/^[0-9A-F]+$/.test(s)) return { ok: false, reason: 'not plain hex' }
  if (s.length < UID_MIN || s.length > UID_MAX) {
    return { ok: false, reason: `length ${s.length} (expected ${UID_MIN}–${UID_MAX})` }
  }
  if (s.length % 2 !== 0) {
    return { ok: false, reason: `odd length ${s.length} (UIDs are byte pairs)` }
  }
  return { ok: true, uid: s }
}

/** Short non-identifying display form ("…4F2A"). Never a full UID. */
export function tail(uid, n = 4) {
  const s = String(uid ?? '')
  return s.length > n ? `…${s.slice(-n)}` : s
}
