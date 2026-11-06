/**
 * The offline queue against an expiring PIN session.
 *
 * Runs the real src/lib/queue.js — not a copy, so it cannot drift from what
 * ships. stub-loader.mjs redirects the two modules it imports; IndexedDB is
 * fake-indexeddb. Every assertion here is about the queue's own logic.
 *
 *     npm run test:queue
 *     node --import ./tests/queue-session/stub-loader-register.mjs \
 *          tests/queue-session/queue.test.mjs
 *
 * The thing being guarded: a measurement that reached IndexedDB must reach
 * the database eventually, and a session running out overnight must not be
 * able to turn it into something a human has to notice and rescue by hand.
 */

import 'fake-indexeddb/auto'
import assert from 'node:assert/strict'

// A plain sequential runner rather than node:test. The queue keeps a repeating
// background timer alive by design, which the test runner's completion
// handling does not get along with; this exits on its own and reports the
// same way. Run it with: node tests/queue_session.test.mjs
const CASES = []
const test = (name, fn) => CASES.push([name, fn])

const api = await import('./stub-api.mjs')
const auth = await import('./stub-auth.mjs')
const queue = await import('../../src/lib/queue.js')

const Api = api.ApiError

async function reset() {
  for (const k of Object.keys(api.calls)) api.calls[k] = []
  for (const k of Object.keys(api.behaviour)) api.behaviour[k] = null
  auth.setLoggedIn(true)
  await settle()     // let any flush kicked by the previous case finish
  await wipe()
}

/**
 * Empty the store between cases.
 *
 * flush() drains every due record, not just the one a case just made, so
 * without this a leftover from the previous case gets swept into the next
 * one's call counts and status assertions. Opened as its own connection so
 * the queue's cached handle is untouched.
 */
async function wipe() {
  // Let the queue create the database first: it owns the upgrade handler
  // that defines the object store, and opening it here beforehand would make
  // an empty one with no store in it.
  await queue.getAll()
  return new Promise((resolve, reject) => {
    const open = indexedDB.open('cv-station', 1)
    open.onsuccess = () => {
      const db = open.result
      const t = db.transaction('captures', 'readwrite')
      t.objectStore('captures').clear()
      t.oncomplete = () => { db.close(); resolve() }
      t.onerror = () => { db.close(); reject(t.error) }
    }
    open.onerror = () => reject(open.error)
  })
}

let n = 0
function payload() {
  n += 1
  return { client_ref: `cv-test-${n}`, height_cm: 180, operator: 'tester' }
}

function blob(name) {
  return { kind: name, blob: { fake: true, size: 1234 } }
}

const rec = async (ref) => (await queue.getAll()).find(r => r.client_ref === ref)

/**
 * enqueue() kicks off flush() without awaiting it, and a concurrent flush()
 * is a deliberate no-op. So a test that enqueues and immediately flushes is
 * really asserting against the first, still-running pass. Wait it out, then
 * flush for real.
 */
async function settle() {
  for (let i = 0; i < 4; i += 1) await new Promise(r => setTimeout(r, 5))
}

async function drain() {
  await settle()
  await queue.flush()
  await settle()
}

// --------------------------------------------------------------- enqueue

test('a capture is stored locally even with no session', async () => {
  await reset()
  auth.setLoggedIn(false)
  const p = payload()
  await queue.enqueue({ payload: p, subjectToken: 'TC-0000-0001' })
  const r = await rec(p.client_ref)
  assert.equal(r.status, 'pending')
  assert.equal(api.calls.saveCapture.length, 0, 'must not have tried the network')
})

test('flush sends nothing while logged out', async () => {
  await reset()
  auth.setLoggedIn(false)
  await settle()
  await queue.flush()
  assert.equal(api.calls.saveCapture.length, 0)
})

test('logging back in drains what was held', async () => {
  await reset()
  auth.setLoggedIn(false)
  const p = payload()
  await queue.enqueue({ payload: p })
  assert.equal(api.calls.saveCapture.length, 0)

  api.behaviour.saveCapture = () => Promise.resolve({ capture_trial_id: 7, capture_session_id: 3 })
  auth.setLoggedIn(true)
  await drain()

  const r = await rec(p.client_ref)
  assert.equal(r.status, 'synced')
  assert.equal(r.result.capture_trial_id, 7)
})

// ------------------------------------------------------------- the 401

test('a 401 on the capture does not stall the record', async () => {
  await reset()
  const p = payload()
  api.behaviour.saveCapture = () => Promise.reject(new Api('Session expired', 401, null))
  await queue.enqueue({ payload: p })
  await drain()

  const r = await rec(p.client_ref)
  assert.equal(r.status, 'pending', 'an expired session is not a bad record')
  assert.equal(r.auth_blocked, true)
  assert.equal(r.attempts, 0, 'a 401 must not consume the retry budget')
  assert.equal(r.next_attempt_at, 0, 'must be ready the instant a session returns')
})

test('a 401 held record syncs after the next login, unchanged', async () => {
  await reset()
  const p = payload()
  api.behaviour.saveCapture = () => Promise.reject(new Api('Session expired', 401, null))
  await queue.enqueue({ payload: p })
  await drain()
  assert.equal((await rec(p.client_ref)).status, 'pending')

  api.behaviour.saveCapture = (sent) => {
    assert.equal(sent.height_cm, 180, 'the payload must survive the expiry intact')
    return Promise.resolve({ capture_trial_id: 9, capture_session_id: 4 })
  }
  await drain()
  assert.equal((await rec(p.client_ref)).status, 'synced')
})

test('a 403 is treated the same as a 401', async () => {
  await reset()
  const p = payload()
  api.behaviour.saveCapture = () => Promise.reject(new Api('Needs admin', 403, null))
  await queue.enqueue({ payload: p })
  await drain()
  const r = await rec(p.client_ref)
  assert.equal(r.status, 'pending')
  assert.equal(r.auth_blocked, true)
})

test('repeated expiries never accumulate toward stalling', async () => {
  await reset()
  const p = payload()
  api.behaviour.saveCapture = () => Promise.reject(new Api('Session expired', 401, null))
  await queue.enqueue({ payload: p })
  for (let i = 0; i < 25; i += 1) await queue.flush()
  const r = await rec(p.client_ref)
  assert.equal(r.attempts, 0)
  assert.equal(r.status, 'pending', 'a whole night of expiry must not park it')
})

// ----------------------------------------------- real failures still park

test('a 400 still stalls for a human', async () => {
  await reset()
  const p = payload()
  api.behaviour.saveCapture = () => Promise.reject(new Api('marker_cm must be one of', 400, null))
  await queue.enqueue({ payload: p })
  await drain()
  const r = await rec(p.client_ref)
  assert.equal(r.status, 'stalled')
  assert.equal(r.auth_blocked, false)
})

test('a 500 retries rather than stalling', async () => {
  await reset()
  const p = payload()
  api.behaviour.saveCapture = () => Promise.reject(new Api('boom', 500, null))
  await queue.enqueue({ payload: p })
  await drain()
  const r = await rec(p.client_ref)
  assert.equal(r.status, 'pending')
  assert.equal(r.attempts, 1, 'a real failure does consume an attempt')
  assert.ok(r.next_attempt_at > Date.now(), 'and backs off')
})

// ------------------------------------------------------------- photos

test('a 401 during photo upload does not destroy the photo', async () => {
  await reset()
  const p = payload()
  api.behaviour.saveCapture = () => Promise.resolve({ capture_trial_id: 1, capture_session_id: 1 })
  api.behaviour.uploadPhoto = () => Promise.reject(new Api('Session expired', 401, null))
  await queue.enqueue({ payload: p, subjectToken: 'TC-1', photos: [blob('tpose_raw')] })
  await drain()

  const r = await rec(p.client_ref)
  assert.equal(r.photos.length, 1, 'the blob is the only copy — it must survive')
  assert.notEqual(r.status, 'synced', 'and the record must not claim it is done')
  assert.equal(r.auth_blocked, true)
})

test('the held photo uploads on the next pass, and the trial is not re-sent', async () => {
  await reset()
  const p = payload()
  api.behaviour.saveCapture = () => Promise.resolve({ capture_trial_id: 1, capture_session_id: 1 })
  api.behaviour.uploadPhoto = () => Promise.reject(new Api('Session expired', 401, null))
  await queue.enqueue({ payload: p, subjectToken: 'TC-1', photos: [blob('tpose_raw')] })
  await drain()
  assert.equal(api.calls.saveCapture.length, 1)

  api.behaviour.uploadPhoto = () => Promise.resolve({ ok: true })
  await drain()

  const r = await rec(p.client_ref)
  assert.equal(r.status, 'synced')
  assert.equal(r.photos.length, 0, 'now it is safe to drop the blob')
  assert.equal(api.calls.saveCapture.length, 1, 'the trial must never be written twice')
  assert.ok(api.calls.uploadPhoto.length >= 2, 'the photo was retried, not abandoned')
})

test('a 413 photo is given up on, and does not hold the record', async () => {
  await reset()
  const p = payload()
  api.behaviour.saveCapture = () => Promise.resolve({ capture_trial_id: 1, capture_session_id: 1 })
  api.behaviour.uploadPhoto = () => Promise.reject(new Api('Photo exceeds 12MB', 413, null))
  await queue.enqueue({ payload: p, subjectToken: 'TC-1', photos: [blob('tpose_raw')] })
  await drain()

  const r = await rec(p.client_ref)
  assert.equal(r.status, 'synced', 'a photo that can never upload must not block forever')
  assert.equal(r.photos.length, 0)
  assert.ok(r.photo_errors.some(e => e.includes('12MB')))
})

test('a photo endpoint that fails forever advances toward parking', async () => {
  // The bug this guards: an incomplete photo phase that did not increment
  // attempts would retry until the device was rebooted, because nothing ever
  // reached MAX_ATTEMPTS.
  await reset()
  const p = payload()
  api.behaviour.saveCapture = () => Promise.resolve({ capture_trial_id: 1, capture_session_id: 1 })
  api.behaviour.uploadPhoto = () => Promise.reject(new Api('storage down', 502, null))
  await queue.enqueue({ payload: p, subjectToken: 'TC-1', photos: [blob('tpose_raw')] })

  const seen = []
  for (let i = 0; i < 3; i += 1) {
    await queue.attachAdditional(p.client_ref, {})   // clears the backoff
    await drain()
    seen.push((await rec(p.client_ref)).attempts)
  }
  assert.deepEqual(seen, [1, 2, 3], `attempts did not advance: ${seen}`)

  const r = await rec(p.client_ref)
  assert.equal(r.photos.length, 1, 'and the blob is still there meanwhile')
  assert.equal(r.status, 'pending')
})

// --------------------------------------------------------------- stats

test('stats separate waiting-for-login from genuinely stalled', async () => {
  await reset()
  const held = payload()
  const broken = payload()
  // Per-record, because flush() drains everything due: a blanket behaviour
  // would re-attempt the held record under the broken one's rules and turn
  // it stalled, which is the very distinction being tested.
  api.behaviour.saveCapture = (sent) => Promise.reject(
    sent.client_ref === held.client_ref
      ? new Api('Session expired', 401, null)
      : new Api('bad payload', 400, null))
  await queue.enqueue({ payload: held })
  await queue.enqueue({ payload: broken })
  await drain()

  const s = await queue.getStats()
  assert.ok(s.authBlocked >= 1, 'the held one is waiting for a login, not failed')
  assert.ok(s.stalled >= 1, 'the broken one is genuinely parked')
})

test('retryStalled clears the auth flag too', async () => {
  await reset()
  const p = payload()
  api.behaviour.saveCapture = () => Promise.reject(new Api('bad', 400, null))
  await queue.enqueue({ payload: p })
  await drain()
  assert.equal((await rec(p.client_ref)).status, 'stalled')

  api.behaviour.saveCapture = () => Promise.resolve({ capture_trial_id: 2, capture_session_id: 2 })
  await queue.retryStalled()
  await settle()
  const r = await rec(p.client_ref)
  assert.equal(r.status, 'synced')
  assert.equal(r.auth_blocked, false)
})


// ------------------------------------------------------------------- run

let failed = 0
for (const [name, fn] of CASES) {
  try {
    await fn()
    console.log(`  ok   ${name}`)
  } catch (err) {
    failed += 1
    console.log(`  FAIL ${name}`)
    console.log(`       ${err.message.split('\n').join('\n       ')}`)
  }
}
console.log(`\n${CASES.length - failed}/${CASES.length} passed`)
process.exit(failed ? 1 : 0)
