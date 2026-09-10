// CSV recovery export (handoff §4.2): if the backend is unreachable for
// the whole shift, the device still holds the full session and staff can
// pull it out as CSV. File names carry no identity (invariant 3).

import { allRecords } from './storage.js'

function esc(v) {
  if (v === null || v === undefined) return ''
  const s = String(v)
  return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s
}

export async function exportCsv() {
  const [captures, scans] = await Promise.all([allRecords('captures'), allRecords('scans')])
  const lines = []

  lines.push('# CV measurement station — capture export (every record, any sync status)')
  lines.push(
    [
      'capture_id', 'captured_at', 'raw_uid', 'subject_key', 'enrolled', 'test_mode',
      'marker_cm', 'height_cm', 'wingspan_cm', 'hand_width_cm', 'method', 'validity',
      'notes', 'sync_status', 'last_error', 'server_trial_ref',
      'station_id', 'lab_location', 'event_session_id', 'operator',
      'age', 'weight',
      'hips_r_hip_er', 'hips_r_hip_ir', 'hips_l_hip_er', 'hips_l_hip_ir',
      'tspine_tspine_rot_l', 'tspine_tspine_rot_r',
      'grip_grip_str_r', 'grip_grip_str_l',
    ].join(','),
  )
  for (const r of captures) {
    const a = r.assessment || {}
    lines.push(
      [
        r.id, r.captured_at, r.raw_uid, r.subject_key, r.enrolled, r.test_mode ? 1 : 0,
        r.marker_cm, r.height_cm, r.wingspan_cm, r.hand_width_cm, r.method, r.validity,
        r.notes, r.sync_status, r.last_error, r.server_trial_ref,
        r.station?.stationId, r.station?.labLocation, r.station?.eventSessionId, r.station?.operator,
        a.age, a.weight,
        a.hips_r_hip_er, a.hips_r_hip_ir, a.hips_l_hip_er, a.hips_l_hip_ir,
        a.tspine_tspine_rot_l, a.tspine_tspine_rot_r,
        a.grip_grip_str_r, a.grip_grip_str_l,
      ].map(esc).join(','),
    )
  }

  lines.push('')
  lines.push('# scan log (every tap, resolved or not)')
  lines.push(
    [
      'scan_id', 'scanned_at', 'raw_scan_value', 'uid', 'resolved', 'enrolled',
      'subject_key', 'station_id', 'operator', 'device_id', 'capture_batch_id',
      'sync_status', 'last_error',
    ].join(','),
  )
  for (const s of scans) {
    lines.push(
      [
        s.id, s.scanned_at, s.raw, s.uid, s.resolved ? 1 : 0, s.enrolled ?? '',
        s.subject_key, s.station?.stationId, s.operator, s.device_id,
        s.capture_batch_id, s.sync_status, s.last_error,
      ].map(esc).join(','),
    )
  }

  const blob = new Blob([lines.join('\n')], { type: 'text/csv;charset=utf-8' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  const d = new Date().toISOString().slice(0, 10)
  a.href = url
  a.download = `cvstation_${d}_export.csv` // no identity in the filename
  document.body.appendChild(a)
  a.click()
  a.remove()
  setTimeout(() => URL.revokeObjectURL(url), 1000)
  return { captures: captures.length, scans: scans.length }
}
