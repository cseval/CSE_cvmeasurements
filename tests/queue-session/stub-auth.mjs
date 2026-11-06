// Stub standing in for src/lib/auth.js.
let logged = true
const subs = new Set()
export function isLoggedIn() { return logged }
export function subscribe(fn) { subs.add(fn); fn(logged ? { token: 't' } : null); return () => subs.delete(fn) }
export function setLoggedIn(v) { logged = v; subs.forEach(f => f(v ? { token: 't' } : null)) }
