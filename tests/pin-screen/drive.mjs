/**
 * Drives the built station app in a real browser.
 *
 * This exists because the on-screen keyboard has twice compiled, passed
 * review and still been broken at runtime — once because an effect's cleanup
 * ran on every render and closed the keyboard on the render that opened it.
 * The only thing that caught it was pressing the keys.
 */

// Playwright is test-only and deliberately not a devDependency: its install
// downloads browsers, and this package is built on Vercel. Resolve it from
// wherever it happens to be — a global install, npx, or a local one.
const { chromium } = await (async () => {
  for (const spec of ['playwright', 'playwright-core']) {
    try { const m = await import(spec); return m.default ?? m } catch { /* next */ }
  }
  // ESM resolution ignores NODE_PATH, so a globally installed playwright is
  // invisible to import(). require() does honour it.
  try {
    const { createRequire } = await import('node:module')
    return createRequire(import.meta.url)('playwright')
  } catch { /* fall through */ }
  console.error('playwright not found. Try:  npm i -D playwright && npx playwright install chromium')
  process.exit(2)
})()

const BASE = process.env.STUB_URL ?? 'http://localhost:8099'
const DESK = '314159'

let failures = 0
const check = (name, ok, detail = '') => {
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${name}${ok || !detail ? '' : `\n       ${detail}`}`)
  if (!ok) failures += 1
}

const browser = await chromium.launch()
const page = await browser.newPage({ viewport: { width: 820, height: 1180 } })
// Uncaught exceptions only. Console "errors" here include the 401 on
// /api/me before anyone has logged in, which is the design, not a fault.
const pageErrors = []
page.on('pageerror', e => pageErrors.push(e.message))

async function apiSeen() {
  return page.evaluate(async () => (await fetch('/api/__seen')).json())
}
async function apiReset() {
  await page.evaluate(async () => { await fetch('/api/__reset') })
}

/** What the NFC reader does: types the UID, then Enter. */
async function tapBracelet(uid = '04A1B2C3D4E5F6') {
  for (const ch of uid) await page.keyboard.press(ch.match(/\d/) ? `Digit${ch}` : `Key${ch}`)
  await page.keyboard.press('Enter')
  await page.waitForTimeout(300)
}

async function pressPin(pin) {
  for (const d of pin) {
    await page.getByRole('button', { name: d, exact: true }).click()
  }
}

await page.goto(BASE)
await page.waitForTimeout(600)

// --------------------------------------------------------------- the screen

check('the app opens on the PIN screen',
  await page.getByText('Enter the station PIN').isVisible())

check('the tap catcher is still mounted while signed out',
  await page.locator('input').count() > 0,
  'the reader must stay attached, or the first tap after login goes nowhere')

// -------------------------------------------------- taps are ignored here

await apiReset()
await tapBracelet()
const duringLogin = await apiSeen()
check('a bracelet tapped at the PIN screen resolves nothing',
  !duringLogin.some(r => r.path === '/api/subject/resolve'),
  `called: ${duringLogin.map(r => r.path).join(', ') || 'nothing'}`)

// ------------------------------------------------------------ the keypad

await page.locator('.vk-field').first().click()
await page.waitForTimeout(250)
check('tapping the field opens the on-screen keypad',
  await page.locator('.vk-key').first().isVisible())

await page.getByRole('button', { name: '3', exact: true }).click()
await page.waitForTimeout(150)
const afterOne = await page.locator('.vk-key').first().isVisible()
check('the keypad stays open after a keypress',
  afterOne,
  'this is the exact regression that shipped twice: it closes on the render that opened it')

const shown = (await page.locator('.vk-field-value').first().innerText()).trim()
check('the PIN is masked in the field', shown === '•' && !shown.includes('3'),
  `showed ${JSON.stringify(shown)}`)

// Caught by looking at a screenshot, not by any assertion: the keypad panel
// echoes the active field, and it was printing the PIN in plain text right
// under the operator's thumb while the field above showed dots.
const barred = (await page.locator('.vk-bar-value').innerText()).trim()
check('the PIN is masked in the keypad panel too',
  barred === '•' && !/\d/.test(barred),
  `the panel showed ${JSON.stringify(barred)}`)

// -------------------------------------------------------------- wrong PIN

await page.getByRole('button', { name: '2', exact: true }).click()
for (const d of '0000') await page.getByRole('button', { name: d, exact: true }).click()
await page.waitForTimeout(500)
check('a wrong PIN is refused', await page.getByText(/not recognised/i).isVisible())
check('and the field is cleared to retry',
  (await page.locator('.vk-field-value').count()) === 0 ||
  (await page.locator('.vk-field-value').first().innerText()).trim() === '')

// ---------------------------------------------------------- the right PIN

await page.locator('.vk-field').first().click()
await page.waitForTimeout(200)
await pressPin(DESK)
await page.waitForTimeout(800)

check('the right PIN gets in',
  !(await page.getByText('Enter the station PIN').isVisible().catch(() => false)))

check('the session is stored',
  await page.evaluate(() => !!localStorage.getItem('cv-station-session')))

check('the stored session holds no PIN',
  await page.evaluate((pin) =>
    !(localStorage.getItem('cv-station-session') || '').includes(pin), DESK))

// ---------------------------------------------------- taps work after login

// The tap guard only lets a tap through on the idle screen, so the station
// has to be set up first. Seeding the config is the same thing a second shift
// on an already-configured iPad would find.
await page.evaluate(() => localStorage.setItem('cv-station-config.v2', JSON.stringify({
  markerCm: 20, stationCode: 'cv_app', deviceLabel: 'bench',
  operator: 'Tester', labLocation: 'FC', sessionType: 'movement_screen',
  sport: 'softball', eventSessionId: null, keepPhotos: false,
})))
await page.reload()
await page.waitForTimeout(700)
check('a configured station lands on idle, still signed in',
  !(await page.getByText('Enter the station PIN').isVisible().catch(() => false)))

await apiReset()
await tapBracelet()
await page.waitForTimeout(400)
const afterLogin = await apiSeen()
check('a tap after login does resolve',
  afterLogin.some(r => r.path === '/api/subject/resolve'),
  `called: ${afterLogin.map(r => r.path).join(', ') || 'nothing'}`)
check('and every request carried the session',
  afterLogin.filter(r => !r.path.startsWith('/api/__')).every(r => r.auth),
  JSON.stringify(afterLogin))

// -------------------------------------------------------------- expiry

await page.evaluate(async () => { await fetch('/api/__expire') })
await page.evaluate(async () => {
  // Force a call so the 401 lands and clears the session.
  try { await fetch('/api/stations', { headers: { Authorization: 'Bearer stale' } }) } catch {}
})
await page.evaluate(() => {
  const s = JSON.parse(localStorage.getItem('cv-station-session') || '{}')
  s.expires_at = new Date(Date.now() - 1000).toISOString()
  localStorage.setItem('cv-station-session', JSON.stringify(s))
})
await page.reload()
await page.waitForTimeout(700)
check('an expired session lands back on the PIN screen',
  await page.getByText('Enter the station PIN').isVisible())

check('no uncaught errors anywhere in that run',
  pageErrors.length === 0,
  pageErrors.slice(0, 4).join('\n       '))

await browser.close()

console.log(`\n${failures === 0 ? 'all checks passed' : `${failures} check(s) failed`}`)
process.exit(failures ? 1 : 0)
