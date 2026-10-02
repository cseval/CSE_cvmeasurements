import { useEffect, useState } from 'react'
import cseLogo from '../assets/CSE-logo-new.png'
import tcSymbol from '../assets/TC_Symbol_RedBlue.png'
import * as queue from '../lib/queue.js'

/**
 * Shared header, now carrying the sync indicator.
 *
 * The indicator is the visible half of invariant 2. Local-first saving is only
 * trustworthy if the operator can see that something has not reached the
 * database yet — otherwise "saved" is indistinguishable from "saved and
 * synced", and a shift can end with the iPad holding the only copy of thirty
 * measurements with nobody aware of it.
 */
export default function BrandBar() {
  const [stats, setStats] = useState(null)
  const [online, setOnline] = useState(() => navigator.onLine)

  useEffect(() => queue.subscribe(setStats), [])

  useEffect(() => {
    const on = () => setOnline(true)
    const off = () => setOnline(false)
    window.addEventListener('online', on)
    window.addEventListener('offline', off)
    return () => {
      window.removeEventListener('online', on)
      window.removeEventListener('offline', off)
    }
  }, [])

  const pending = stats?.pending ?? 0
  const stalled = stats?.stalled ?? 0

  let syncClass = 'sync-pill ok'
  let syncText = 'Synced'
  if (stalled > 0) {
    syncClass = 'sync-pill bad'
    syncText = `${stalled} stalled`
  } else if (pending > 0) {
    syncClass = 'sync-pill busy'
    syncText = `${pending} queued`
  } else if (!online) {
    syncClass = 'sync-pill busy'
    syncText = 'Offline'
  }

  return (
    <div className="brand-bar">
      <img src={cseLogo} alt="CSE" className="brand-bar-logo" />
      <div className={syncClass} title={
        stalled > 0
          ? 'Some captures hit an error that will not resolve on retry. Open the audit screen.'
          : pending > 0
            ? 'Captures are saved on this device and are retrying in the background.'
            : online ? 'Everything on this device has reached the database.'
              : 'No network. Captures are saved on this device and will sync when it returns.'
      }>
        {syncText}
      </div>
      <div className="tc-mark-badge">
        <img src={tcSymbol} alt="Triple Crown Sports" className="tc-mark" />
      </div>
    </div>
  )
}
