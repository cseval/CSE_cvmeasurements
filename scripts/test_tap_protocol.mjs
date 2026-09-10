// Node test for the tap protocol (pure functions, no DOM).
// Run: node scripts/test_tap_protocol.mjs
import { validateUid, normalizeUid, tail } from '../src/lib/tapProtocol.js'

let failures = 0
function check(name, cond) {
  if (cond) {
    console.log(`  ok  ${name}`)
  } else {
    failures++
    console.log(`FAIL  ${name}`)
  }
}

// NTAG21x: 7 bytes -> 14 hex chars
check('14-char NTAG21x accepted', validateUid('04A1B2C3D4E5F6').ok === true)
check('14-char returns normalized uid', validateUid('04a1b2c3d4e5f6').uid === '04A1B2C3D4E5F6')

// Mifare Classic: 4 bytes -> 8 hex chars (length must NOT be hard-coded to 14)
check('8-char Mifare accepted', validateUid('04A1B2C3').ok === true)

// Prefix handling (firmware PREFIX, e.g. "BR-")
check('prefix stripped + accepted', validateUid('BR-04A1B2C3D4E5F6', 'BR-').ok === true)
check('prefix not required when empty', validateUid('BR-04A1B2C3D4E5F6', '').ok === false)

// 20 chars (10 bytes) IS valid per spec — only >20 rejected
check('20-char (10-byte) accepted', validateUid('04A1B2C3D4E5F67890').ok === true)
check('odd length rejected', validateUid('04A1B2C3D4E5F').ok === false)
check('too short rejected', validateUid('GHIJ').ok === false)
check('too long (24) rejected', validateUid('04A1B2C3D4E5F67890ABCD').ok === false)
check('non-hex rejected', validateUid('04A1B2C3D4E5F6G').ok === false)
check('empty rejected', validateUid('').ok === false)
check('garbage rejected with reason', typeof validateUid('xyz').reason === 'string')

// Tail display: never a full UID, stable shape
check('tail hides the front', tail('04A1B2C3D4E5F6') === '…E5F6')
check('tail short input unchanged', tail('AB12') === 'AB12')
check('normalize strips prefix', normalizeUid('br-04a1b2c3', 'br-') === '04A1B2C3')

// The invariant-1 scenario, simulated: ten consecutive taps, same buffer
// discipline — each Enter flush must leave the buffer empty so the next
// tap starts clean.
{
  let buffer = ''
  let accepted = 0
  for (let i = 0; i < 10; i++) {
    const typed = '04A1B2C3D4E5F6'
    buffer += typed
    const v = validateUid(buffer, '')
    if (v.ok) {
      accepted++
      buffer = '' // what TapCatcher does on Enter
    } else {
      buffer = '' // what TapCatcher does on invalid Enter
    }
  }
  check('10 rapid taps all register', accepted === 10)
}

if (failures) {
  console.error(`\n${failures} failure(s)`)
  process.exit(1)
}
console.log('\nJS TAP PROTOCOL OK')
