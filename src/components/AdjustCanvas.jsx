import { useRef, useEffect, forwardRef, useImperativeHandle } from 'react'

const DOT_R   = 5    // visual dot radius
const HIT_R   = 22   // touch hit radius (larger than visual for easy tapping)
const MAX_ZOOM = 10
const MIN_ZOOM = 0.5

const COLOR = {
  height:   '#60a5fa',
  wingspan: '#f97316',
  hand:     '#c084fc',
}

function buildPts(endpoints, baseScale) {
  const p = {}
  const { height, wingspan, hand } = endpoints
  if (height) {
    p.height_crown = [height.crown[0] * baseScale, height.crown[1] * baseScale]
    p.height_heel  = [height.heel[0]  * baseScale, height.heel[1]  * baseScale]
  }
  if (wingspan) {
    p.wingspan_left  = [wingspan.left[0]  * baseScale, wingspan.left[1]  * baseScale]
    p.wingspan_right = [wingspan.right[0] * baseScale, wingspan.right[1] * baseScale]
  }
  if (hand) {
    p.hand_thumb = [hand.thumb[0] * baseScale, hand.thumb[1] * baseScale]
    p.hand_pinky = [hand.pinky[0] * baseScale, hand.pinky[1] * baseScale]
  }
  return p
}

function recalc(pts, baseScale, pxPerCm) {
  const m  = {}
  const s  = baseScale
  const px = v => v / s  // base-canvas px → original-image px

  if (pts.height_crown && pts.height_heel)
    m.height_cm = Math.round(Math.abs(px(pts.height_heel[1]) - px(pts.height_crown[1])) / pxPerCm * 10) / 10

  if (pts.wingspan_left && pts.wingspan_right) {
    const dx = px(pts.wingspan_right[0] - pts.wingspan_left[0])
    const dy = px(pts.wingspan_right[1] - pts.wingspan_left[1])
    m.wingspan_cm = Math.round(Math.sqrt(dx * dx + dy * dy) / pxPerCm * 10) / 10
  }
  if (pts.hand_thumb && pts.hand_pinky) {
    const dx = px(pts.hand_pinky[0] - pts.hand_thumb[0])
    const dy = px(pts.hand_pinky[1] - pts.hand_thumb[1])
    m.hand_width_cm = Math.round(Math.sqrt(dx * dx + dy * dy) / pxPerCm * 10) / 10
  }
  return m
}

function drawScene(ctx, canvas, bg, pts, view, imgW, imgH, baseScale) {
  ctx.clearRect(0, 0, canvas.width, canvas.height)
  ctx.save()
  ctx.translate(view.x, view.y)
  ctx.scale(view.s, view.s)

  ctx.drawImage(bg, 0, 0, imgW * baseScale, imgH * baseScale)

  const pairs = [
    ['height_crown',  'height_heel',   COLOR.height],
    ['wingspan_left', 'wingspan_right', COLOR.wingspan],
    ['hand_thumb',    'hand_pinky',     COLOR.hand],
  ]

  for (const [k1, k2, color] of pairs) {
    if (!pts[k1] || !pts[k2]) continue
    ctx.beginPath()
    ctx.moveTo(pts[k1][0], pts[k1][1])
    ctx.lineTo(pts[k2][0], pts[k2][1])
    ctx.strokeStyle = color
    ctx.lineWidth = 2.5
    ctx.stroke()
    for (const pt of [pts[k1], pts[k2]]) {
      ctx.beginPath()
      ctx.arc(pt[0], pt[1], DOT_R, 0, Math.PI * 2)
      ctx.fillStyle = color
      ctx.fill()
      ctx.strokeStyle = '#fff'
      ctx.lineWidth = 1.5
      ctx.stroke()
    }
  }

  ctx.restore()
}

const AdjustCanvas = forwardRef(function AdjustCanvas({ rawImage, endpoints, pxPerCm, imgWidth, imgHeight, onChange }, ref) {
  const canvasRef = useRef(null)

  useImperativeHandle(ref, () => ({
    getState: () => ({ pts: r.current.pts, baseScale: r.current.baseScale }),
  }))

  const r = useRef({
    bg: null, pts: {}, baseScale: 1,
    view: { x: 0, y: 0, s: 1 },
    drag: null, pan: null, pinch: null,
  })

  function toWorld(cx, cy) {
    const { x, y, s } = r.current.view
    return [(cx - x) / s, (cy - y) / s]
  }

  function cPos(e, idx = 0) {
    const rect = canvasRef.current.getBoundingClientRect()
    const src  = e.touches ? e.touches[idx] : e
    return [src.clientX - rect.left, src.clientY - rect.top]
  }

  function findHit(world) {
    const hitR = HIT_R / r.current.view.s
    for (const [key, pt] of Object.entries(r.current.pts)) {
      if (Math.hypot(world[0] - pt[0], world[1] - pt[1]) < hitR) return key
    }
    return null
  }

  function redraw() {
    const { bg, pts, baseScale, view } = r.current
    if (!bg) return
    drawScene(canvasRef.current.getContext('2d'), canvasRef.current,
              bg, pts, view, imgWidth, imgHeight, baseScale)
  }

  function applyZoom(newS, anchorX, anchorY) {
    const clamped = Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, newS))
    const v = r.current.view
    r.current.view = {
      s: clamped,
      x: anchorX - (anchorX - v.x) * (clamped / v.s),
      y: anchorY - (anchorY - v.y) * (clamped / v.s),
    }
  }

  useEffect(() => {
    const canvas = canvasRef.current
    const dispW  = canvas.parentElement.offsetWidth
    const base   = dispW / imgWidth
    canvas.width  = dispW
    canvas.height = imgHeight * base
    r.current.baseScale = base
    r.current.pts = buildPts(endpoints, base)

    const img = new Image()
    img.onload = () => { r.current.bg = img; redraw() }
    img.src = `data:image/jpeg;base64,${rawImage}`

    // ── mouse ──
    function onMD(e) {
      const world = toWorld(...cPos(e))
      const hit   = findHit(world)
      if (hit) r.current.drag = hit
      else r.current.pan = { sx: cPos(e)[0], sy: cPos(e)[1], vx: r.current.view.x, vy: r.current.view.y }
    }
    function onMM(e) {
      if (r.current.drag) {
        r.current.pts = { ...r.current.pts, [r.current.drag]: toWorld(...cPos(e)) }
        redraw(); onChange(recalc(r.current.pts, r.current.baseScale, pxPerCm))
      } else if (r.current.pan) {
        const [cx, cy] = cPos(e)
        r.current.view = { ...r.current.view, x: r.current.pan.vx + cx - r.current.pan.sx, y: r.current.pan.vy + cy - r.current.pan.sy }
        redraw()
      }
    }
    function onMU() { r.current.drag = null; r.current.pan = null }

    // ── mouse wheel zoom ──
    function onWheel(e) {
      e.preventDefault()
      const [cx, cy] = cPos(e)
      applyZoom(r.current.view.s * (e.deltaY < 0 ? 1.1 : 0.9), cx, cy)
      redraw()
    }

    // ── touch ──
    function onTS(e) {
      e.preventDefault()
      if (e.touches.length === 2) {
        r.current.drag = null; r.current.pan = null
        const t0 = e.touches[0], t1 = e.touches[1]
        r.current.pinch = {
          dist: Math.hypot(t0.clientX - t1.clientX, t0.clientY - t1.clientY),
          mx: (cPos(e, 0)[0] + cPos(e, 1)[0]) / 2,
          my: (cPos(e, 0)[1] + cPos(e, 1)[1]) / 2,
          vs: r.current.view.s,
          vx: r.current.view.x,
          vy: r.current.view.y,
        }
      } else if (e.touches.length === 1) {
        const world = toWorld(...cPos(e))
        const hit   = findHit(world)
        if (hit) r.current.drag = hit
        else r.current.pan = { sx: cPos(e)[0], sy: cPos(e)[1], vx: r.current.view.x, vy: r.current.view.y }
      }
    }
    function onTM(e) {
      e.preventDefault()
      if (e.touches.length === 2 && r.current.pinch) {
        const p  = r.current.pinch
        const t0 = e.touches[0], t1 = e.touches[1]
        const d  = Math.hypot(t0.clientX - t1.clientX, t0.clientY - t1.clientY)
        applyZoom(p.vs * (d / p.dist), p.mx, p.my)
        redraw()
      } else if (e.touches.length === 1) {
        if (r.current.drag) {
          r.current.pts = { ...r.current.pts, [r.current.drag]: toWorld(...cPos(e)) }
          redraw(); onChange(recalc(r.current.pts, r.current.baseScale, pxPerCm))
        } else if (r.current.pan) {
          const [cx, cy] = cPos(e)
          r.current.view = { ...r.current.view, x: r.current.pan.vx + cx - r.current.pan.sx, y: r.current.pan.vy + cy - r.current.pan.sy }
          redraw()
        }
      }
    }
    function onTE(e) {
      if (e.touches.length < 2) r.current.pinch = null
      if (e.touches.length === 0) { r.current.drag = null; r.current.pan = null }
    }

    // ── double-tap / double-click to reset zoom ──
    function onDbl() { r.current.view = { x: 0, y: 0, s: 1 }; redraw() }

    canvas.addEventListener('mousedown',  onMD)
    canvas.addEventListener('mousemove',  onMM)
    canvas.addEventListener('mouseup',    onMU)
    canvas.addEventListener('wheel',      onWheel,  { passive: false })
    canvas.addEventListener('touchstart', onTS,     { passive: false })
    canvas.addEventListener('touchmove',  onTM,     { passive: false })
    canvas.addEventListener('touchend',   onTE)
    canvas.addEventListener('dblclick',   onDbl)

    return () => {
      canvas.removeEventListener('mousedown',  onMD)
      canvas.removeEventListener('mousemove',  onMM)
      canvas.removeEventListener('mouseup',    onMU)
      canvas.removeEventListener('wheel',      onWheel)
      canvas.removeEventListener('touchstart', onTS)
      canvas.removeEventListener('touchmove',  onTM)
      canvas.removeEventListener('touchend',   onTE)
      canvas.removeEventListener('dblclick',   onDbl)
    }
  }, [])

  return (
    <canvas
      ref={canvasRef}
      style={{ width: '100%', display: 'block', borderRadius: 8, touchAction: 'none' }}
    />
  )
})

export default AdjustCanvas
