/**
 * Lets queue.test.mjs exercise the real src/lib/queue.js.
 *
 * queue.js imports './api.js' and './auth.js', and both of those read
 * import.meta.env, which only exists inside Vite. Rather than test a copy of
 * the queue that would drift from the real one, this redirects just those two
 * specifiers — and only when queue.js is the importer — to the stubs next to
 * the test. The file under test is the shipped file, byte for byte.
 */

const STUBS = new Map([
  ['./api.js', new URL('./stub-api.mjs', import.meta.url).href],
  ['./auth.js', new URL('./stub-auth.mjs', import.meta.url).href],
])

export function resolve(specifier, context, nextResolve) {
  if (STUBS.has(specifier) && context.parentURL?.endsWith('/src/lib/queue.js')) {
    return { url: STUBS.get(specifier), shortCircuit: true }
  }
  return nextResolve(specifier, context)
}
