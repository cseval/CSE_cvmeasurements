// Stub standing in for src/lib/api.js. The queue under test is the real file.
export class ApiError extends Error {
  constructor(message, status, body) { super(message); this.status = status; this.body = body }
}
export function isAuthError(err) {
  return err instanceof ApiError && (err.status === 401 || err.status === 403)
}
export const calls = { saveCapture: [], uploadPhoto: [], saveAdditional: [] }
export const behaviour = { saveCapture: null, uploadPhoto: null, saveAdditional: null }
function run(name, args) {
  calls[name].push(args)
  const b = behaviour[name]
  if (typeof b === 'function') return b(args)
  return Promise.resolve(b ?? { ok: true })
}
export const saveCapture = (p) => run('saveCapture', p)
export const uploadPhoto = (p) => run('uploadPhoto', p)
export const saveAdditional = (p) => run('saveAdditional', p)
