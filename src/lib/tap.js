/**
 * Client-side tap validation.
 *
 * Deliberately mirrors nfc.py rather than replacing it. The server stays the
 * authority — it is what writes scan_event — but the station needs the same
 * answer without a network round trip, for two reasons:
 *
 *   1. A malformed scan should tell the operator immediately, while the
 *      athlete is still at the reader, not after a request completes.
 *   2. On the offline path there is no server to ask, and a capture must not
 *      be taken against a scan that will be rejected at sync time hours
 *      later, when the athlete has long since left.
 *
 * Keep the two in step. If the rule changes, it changes in both places.
 */

// Empty in the current firmware build. Must match NFC_PREFIX on the server
// and PREFIX in NEW Pipeline/hardware/code.py.
const PREFIX = import.meta.env.VITE_NFC_PREFIX ?? ''

const UID_RE = /^[0-9A-F]{8,20}$/
export const MIN_LEN = 8
export const MAX_LEN = 20

export function normalize(raw) {
  let value = (raw ?? '').trim().toUpperCase().replace(/^[\t\r\n]+|[\t\r\n]+$/g, '')
  const prefix = PREFIX.toUpperCase()
  if (prefix && value.startsWith(prefix)) value = value.slice(prefix.length)
  return value
}

/**
 * @returns {{ok: true, uid: string} | {ok: false, reason: string}}
 *
 * Reasons are written for an operator at a station, not for a log: "8
 * characters, odd length" tells them the read was truncated and to tap again,
 * while "not hex" tells them something typed into the field.
 */
export function validateUid(raw) {
  const uid = normalize(raw)

  if (!uid) return { ok: false, reason: 'Empty scan — the reader sent nothing' }

  if (uid.length % 2 !== 0) {
    return {
      ok: false,
      reason: `Odd length (${uid.length} characters) — the tag left the field `
        + 'mid-read. Tap again and hold it flat on the reader.',
    }
  }

  if (!UID_RE.test(uid)) {
    if (uid.length < MIN_LEN) {
      return { ok: false, reason: `Too short (${uid.length} characters, minimum ${MIN_LEN}) — partial read` }
    }
    if (uid.length > MAX_LEN) {
      return { ok: false, reason: `Too long (${uid.length} characters, maximum ${MAX_LEN}) — this looks like typing, not a tap` }
    }
    return { ok: false, reason: 'Contains characters that are not uppercase hex — this looks like typing, not a tap' }
  }

  return { ok: true, uid }
}

/**
 * Is this failure the network, rather than the server saying no?
 *
 * It decides whether a failed resolve falls back to the offline path or is
 * shown to the operator as an error. A 4xx means the server heard us and
 * refused — a bad station key, a bad payload — and retrying offline would
 * just defer the same rejection. Anything else (fetch threw, request aborted
 * on timeout, 5xx) means we could not get an answer, which is what the
 * offline path is for.
 */
export function isNetworkFailure(err) {
  if (!err) return false
  if (err.name === 'AbortError') return true
  if (typeof err.status === 'number') return err.status >= 500
  return true   // TypeError from fetch: DNS, refused, offline, CORS preflight
}
