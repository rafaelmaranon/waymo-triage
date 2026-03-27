/**
 * CameraPanel — displays all 5 Waymo camera images in a horizontal strip.
 *
 * Layout: SIDE_LEFT | FRONT_LEFT | FRONT | FRONT_RIGHT | SIDE_RIGHT
 * The FRONT camera is slightly larger (primary view).
 *
 * Images are preloaded via new Image() before swapping src to prevent
 * broken-image icons during fast timeline scrubbing.
 *
 * Each camera has a POV button overlay that switches the 3D view
 * to that camera's perspective.
 */

import { useEffect, useRef, useState, useMemo } from 'react'
import { useSceneStore } from '../../stores/useSceneStore'
import type { ParquetRow } from '../../utils/merge'
import { colors, fonts, radius, shadows } from '../../theme'
import { getManifest } from '../../adapters/registry'
import BBoxOverlayCanvas from './BBoxOverlayCanvas'
import LidarProjectionOverlay from './LidarProjectionOverlay'
import BoxProjectionOverlay from './BoxProjectionOverlay'
import KeypointOverlay from './KeypointOverlay'
import CameraSegOverlay from './CameraSegOverlay'
import { trackKeyboardShortcut } from '../../utils/analytics'
import { getPreloadedUrl } from '../../utils/cameraPreload'

/** Height of the camera strip in pixels */
const STRIP_HEIGHT = 160
const STRIP_HEIGHT_MOBILE = 100
/** Height of the thumbnail row in the new triage layout */
const THUMBNAIL_STRIP_HEIGHT = 100

// ---------------------------------------------------------------------------
// Shared hook: blob URL with preload-before-swap
// ---------------------------------------------------------------------------

function useBlobUrl(imageBuffer: ArrayBuffer | null): string | null {
  const [displayUrl, setDisplayUrl] = useState<string | null>(null)
  const pendingUrlRef = useRef<string | null>(null)
  const activeUrlRef = useRef<string | null>(null)

  useEffect(() => {
    if (!imageBuffer) return

    // Fast path: pre-decoded URL is already available from the preload cache
    const preloaded = getPreloadedUrl(imageBuffer)
    if (preloaded) {
      if (activeUrlRef.current && activeUrlRef.current !== preloaded) {
        URL.revokeObjectURL(activeUrlRef.current)
      }
      activeUrlRef.current = preloaded
      pendingUrlRef.current = null
      setDisplayUrl(preloaded)
      return
    }

    // Slow path: decode now (first time we've seen this buffer)
    const blob = new Blob([imageBuffer], { type: 'image/jpeg' })
    const newUrl = URL.createObjectURL(blob)
    pendingUrlRef.current = newUrl
    const img = new Image()
    img.onload = () => {
      if (pendingUrlRef.current !== newUrl) { URL.revokeObjectURL(newUrl); return }
      if (activeUrlRef.current) URL.revokeObjectURL(activeUrlRef.current)
      activeUrlRef.current = newUrl
      setDisplayUrl(newUrl)
    }
    img.onerror = () => {
      URL.revokeObjectURL(newUrl)
      if (pendingUrlRef.current === newUrl) pendingUrlRef.current = null
    }
    img.src = newUrl
    return () => { if (pendingUrlRef.current === newUrl) pendingUrlRef.current = null }
  }, [imageBuffer])

  return displayUrl
}

function useIsMobile(breakpoint = 600) {
  const [m, setM] = useState(() => window.innerWidth < breakpoint)
  useEffect(() => {
    const mq = window.matchMedia(`(max-width: ${breakpoint - 1}px)`)
    const h = (e: MediaQueryListEvent) => setM(e.matches)
    mq.addEventListener('change', h)
    setM(mq.matches)
    return () => mq.removeEventListener('change', h)
  }, [breakpoint])
  return m
}

export default function CameraPanel() {
  const cameraImages = useSceneStore((s) => s.currentFrame?.cameraImages)
  const cameraBoxes = useSceneStore((s) => s.currentFrame?.cameraBoxes)
  const boxMode = useSceneStore((s) => s.boxMode)
  const showLidarOverlay = useSceneStore((s) => s.showLidarOverlay)
  const activeCam = useSceneStore((s) => s.activeCam)
  const toggleActiveCam = useSceneStore((s) => s.actions.toggleActiveCam)
  const setHoveredCam = useSceneStore((s) => s.actions.setHoveredCam)

  // Group camera boxes by camera name (only when boxMode is not 'off')
  const boxesByCamera = useMemo(() => {
    const map = new Map<number, ParquetRow[]>()
    if (boxMode === 'off' || !cameraBoxes) return map
    for (const row of cameraBoxes) {
      const camName = row['key.camera_name'] as number
      let arr = map.get(camName)
      if (!arr) {
        arr = []
        map.set(camName, arr)
      }
      arr.push(row)
    }
    return map
  }, [cameraBoxes, boxMode])

  const isMobile = useIsMobile()
  const cameras = getManifest().cameraSensors

  // Number key shortcuts: 1–9 toggle camera POV
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const tag = (e.target as HTMLElement)?.tagName
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return

      // Digit1..Digit9 → index 0..8
      const match = e.code.match(/^Digit([1-9])$/)
      if (!match) return
      const idx = parseInt(match[1], 10) - 1
      if (idx < cameras.length) {
        e.preventDefault()
        toggleActiveCam(cameras[idx].id)
        trackKeyboardShortcut(`${idx + 1}`)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [cameras, toggleActiveCam])

  // Mobile: two rows — FRONT-labeled cameras on top, everything else on bottom
  // Top row: only cameras with "FRONT" in the label (FL, F, FR)
  // Bottom row: SIDE + BACK/REAR cameras
  // Within each row: LEFT → center → RIGHT
  // If no bottom row cameras (shouldn't happen), fall back to single row
  if (isMobile) {
    const isFront = (l: string) => l.includes('FRONT')
    const sortLR = (a: typeof cameras[0], b: typeof cameras[0]) => {
      // BACK/REAR on outer edges, SIDE in middle: RL · SL · SR · RR
      const order = (l: string) => {
        if (l.includes('REAR L') || l.includes('BACK L')) return 0
        if (l.includes('LEFT')) return 1
        if (l.includes('REAR R') || l.includes('BACK R')) return 4
        if (l.includes('RIGHT')) return 3
        return 2
      }
      return order(a.label) - order(b.label)
    }
    const topRow = cameras.filter(c => isFront(c.label)).sort(sortLR)
    const bottomRow = cameras.filter(c => !isFront(c.label)).sort(sortLR)
    const twoRows = bottomRow.length > 0
    const rows = twoRows ? [topRow, bottomRow] : [topRow]
    const rowHeight = STRIP_HEIGHT_MOBILE

    return (
      <div style={{
        height: twoRows ? rowHeight * 2 + 4 : rowHeight + 6,
        flexShrink: 0,
        display: 'flex',
        flexDirection: 'column',
        gap: '3px',
        padding: '3px 4px',
        backgroundColor: '#0A0A0A',
        borderTop: `1px solid ${colors.borderSubtle}`,
        overflow: 'hidden',
      }}>
        {rows.map((row, ri) => (
          <div key={ri} style={{ display: 'flex', gap: '3px', flex: 1, minHeight: 0 }}>
            {row.map(({ id, label }) => (
              <CameraView
                key={id}
                cameraName={id}
                label={label}
                imageBuffer={cameraImages?.get(id) ?? null}
                boxes={boxesByCamera.get(id) ?? EMPTY_BOXES}
                boxMode={boxMode}
                showLidarOverlay={showLidarOverlay}
                active={activeCam === id}
                onTogglePov={toggleActiveCam}
                onHover={setHoveredCam}
                shortcutKey={cameras.findIndex(c => c.id === id) + 1}
              />
            ))}
          </div>
        ))}
      </div>
    )
  }

  return (
    <div style={{
      height: STRIP_HEIGHT,
      flexShrink: 0,
      display: 'flex',
      gap: '6px',
      padding: '6px 8px',
      backgroundColor: '#0A0A0A',
      borderTop: `1px solid ${colors.borderSubtle}`,
      overflow: 'hidden',
    }}>
      {cameras.map(({ id, label }, idx) => (
        <CameraView
          key={id}
          cameraName={id}
          label={label}
          imageBuffer={cameraImages?.get(id) ?? null}
          boxes={boxesByCamera.get(id) ?? EMPTY_BOXES}
          boxMode={boxMode}
          showLidarOverlay={showLidarOverlay}
          active={activeCam === id}
          onTogglePov={toggleActiveCam}
          onHover={setHoveredCam}
          shortcutKey={idx + 1}
        />
      ))}
    </div>
  )
}

const EMPTY_BOXES: ParquetRow[] = []

// ---------------------------------------------------------------------------
// Single camera view
// ---------------------------------------------------------------------------

interface CameraViewProps {
  cameraName: number
  label: string
  imageBuffer: ArrayBuffer | null
  boxes: ParquetRow[]
  boxMode: string
  showLidarOverlay: boolean
  active: boolean
  onTogglePov: (cameraName: number) => void
  onHover: (cameraName: number | null) => void
  /** Keyboard shortcut number (1-9) shown on label */
  shortcutKey?: number
}

function CameraView({ cameraName, label, imageBuffer, boxes, boxMode, showLidarOverlay, active, onTogglePov, onHover, shortcutKey }: CameraViewProps) {
  const showKeypoints2D = useSceneStore((s) => s.showKeypoints2D)
  const hasKeypoints = useSceneStore((s) => s.hasKeypoints)
  const showCameraSeg = useSceneStore((s) => s.showCameraSeg)
  const hasCameraSeg = useSceneStore((s) => s.hasCameraSegmentation)
  const displayUrl = useBlobUrl(imageBuffer)
  const [hovered, setHovered] = useState(false)

  // Derive flex and color from manifest
  const manifest = getManifest()
  const camDef = manifest.cameraSensors.find(c => c.id === cameraName)
  const flex = camDef?.flex ?? 1
  const accentColor = manifest.cameraColors[cameraName] ?? '#888'

  return (
    <div
      style={{
        flex,
        position: 'relative',
        backgroundColor: colors.bgBase,
        borderRadius: radius.md,
        overflow: 'hidden',
        minWidth: 0,
        cursor: 'pointer',
        border: active ? `2px solid ${accentColor}` : hovered ? '2px solid rgba(255,255,255,0.45)' : `2px solid ${colors.borderSubtle}`,
        boxShadow: active ? `0 0 12px ${accentColor}33` : shadows.card,
        transition: 'border-color 0.2s, box-shadow 0.2s',
      }}
      onClick={() => onTogglePov(cameraName)}
      onMouseEnter={() => { setHovered(true); onHover(cameraName) }}
      onMouseLeave={() => { setHovered(false); onHover(null) }}
    >
      {displayUrl ? (
        <img
          src={displayUrl}
          alt={label}
          style={{
            width: '100%',
            height: '100%',
            objectFit: 'cover',
            display: 'block',
          }}
        />
      ) : (
        <div style={{
          width: '100%',
          height: '100%',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          color: colors.textDim,
          fontSize: '11px',
          fontFamily: fonts.sans,
        }}>
          No image
        </div>
      )}

      {/* Camera segmentation overlay (below lidar/bbox overlays) */}
      {showCameraSeg && hasCameraSeg && (
        <CameraSegOverlay cameraName={cameraName} />
      )}

      {/* LiDAR point projection overlay (separate toggle) */}
      {showLidarOverlay && (
        <LidarProjectionOverlay cameraName={cameraName} />
      )}

      {/* 3D box → camera wireframe projection (only when no native 2D boxes — AV2/nuScenes) */}
      {boxMode !== 'off' && boxes.length === 0 && (
        <BoxProjectionOverlay cameraName={cameraName} />
      )}

      {/* Native 2D bounding box overlay (Waymo — has pre-associated camera_box data) */}
      {boxes.length > 0 && (
        <BBoxOverlayCanvas cameraName={cameraName} boxes={boxes} />
      )}

      {/* 2D keypoint skeleton overlay (Waymo camera_hkp) */}
      {showKeypoints2D && hasKeypoints && (
        <KeypointOverlay cameraName={cameraName} />
      )}

      {/* Label overlay — abbreviate on mobile to avoid two-line wrap */}
      <div style={{
        position: 'absolute',
        bottom: 4,
        left: 4,
        fontSize: '9px',
        fontFamily: fonts.sans,
        fontWeight: 500,
        color: colors.accent,
        backgroundColor: 'rgba(0, 0, 0, 0.6)',
        padding: '2px 5px',
        borderRadius: radius.sm,
        pointerEvents: 'none',
        letterSpacing: '0.5px',
        textTransform: 'uppercase',
        whiteSpace: 'nowrap',
      }}>
        {window.innerWidth < 600
          ? (label.includes(' ') ? label.split(' ').map(w => w[0]).join('') : label)
          : label}
        {shortcutKey != null && (
          <span style={{ opacity: 0.5, marginLeft: 4, fontSize: '8px' }}>{shortcutKey}</span>
        )}
      </div>

      {/* Active dot indicator */}
      {active && (
        <div style={{
          position: 'absolute',
          top: 8,
          right: 8,
          width: 8,
          height: 8,
          borderRadius: '50%',
          backgroundColor: accentColor,
          boxShadow: `0 0 8px ${accentColor}`,
        }} />
      )}
    </div>
  )
}

// ---------------------------------------------------------------------------
// CameraLargeView — fills its parent container, all overlays, POV button
// ---------------------------------------------------------------------------

export function CameraLargeView({ cameraId }: { cameraId: number }) {
  const cameraImages    = useSceneStore((s) => s.currentFrame?.cameraImages)
  const cameraBoxes     = useSceneStore((s) => s.currentFrame?.cameraBoxes)
  const boxMode         = useSceneStore((s) => s.boxMode)
  const showLidarOverlay = useSceneStore((s) => s.showLidarOverlay)
  const showKeypoints2D = useSceneStore((s) => s.showKeypoints2D)
  const hasKeypoints    = useSceneStore((s) => s.hasKeypoints)
  const showCameraSeg   = useSceneStore((s) => s.showCameraSeg)
  const hasCameraSeg    = useSceneStore((s) => s.hasCameraSegmentation)
  const activeCam       = useSceneStore((s) => s.activeCam)
  const toggleActiveCam = useSceneStore((s) => s.actions.toggleActiveCam)
  const setHoveredCam   = useSceneStore((s) => s.actions.setHoveredCam)

  const manifest   = getManifest()
  const camDef     = manifest.cameraSensors.find((c) => c.id === cameraId)
  const label      = camDef?.label ?? `CAM ${cameraId}`
  const accentColor = manifest.cameraColors[cameraId] ?? colors.accent

  const displayUrl = useBlobUrl(cameraImages?.get(cameraId) ?? null)
  const isActivePov = activeCam === cameraId

  const boxes = useMemo(() => {
    if (boxMode === 'off' || !cameraBoxes) return EMPTY_BOXES
    return (cameraBoxes as ParquetRow[]).filter((r) => (r['key.camera_name'] as number) === cameraId)
  }, [cameraBoxes, boxMode, cameraId])

  return (
    <div
      style={{ position: 'absolute', inset: 0, backgroundColor: colors.bgDeep, overflow: 'hidden' }}
      onMouseEnter={() => setHoveredCam(cameraId)}
      onMouseLeave={() => setHoveredCam(null)}
    >
      {displayUrl ? (
        <img
          src={displayUrl}
          alt={label}
          style={{ width: '100%', height: '100%', objectFit: 'cover', display: 'block' }}
        />
      ) : (
        <div style={{ width: '100%', height: '100%', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
          <svg width="36" height="36" viewBox="0 0 24 24" fill="none" stroke={colors.textDim} strokeWidth="1" strokeLinecap="round" strokeLinejoin="round" style={{ opacity: 0.25 }}>
            <path d="M23 19a2 2 0 0 1-2 2H3a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4l2-3h6l2 3h4a2 2 0 0 1 2 2z" />
            <circle cx="12" cy="13" r="4" />
          </svg>
        </div>
      )}

      {/* Overlays */}
      {showCameraSeg && hasCameraSeg && <CameraSegOverlay cameraName={cameraId} />}
      {showLidarOverlay && <LidarProjectionOverlay cameraName={cameraId} />}
      {boxMode !== 'off' && boxes.length === 0 && <BoxProjectionOverlay cameraName={cameraId} />}
      {boxes.length > 0 && <BBoxOverlayCanvas cameraName={cameraId} boxes={boxes} />}
      {showKeypoints2D && hasKeypoints && <KeypointOverlay cameraName={cameraId} />}

      {/* Camera label — bottom left */}
      <div style={{
        position: 'absolute', bottom: 10, left: 10,
        fontSize: 10, fontWeight: 700, fontFamily: fonts.sans,
        color: colors.accent,
        backgroundColor: 'rgba(0,0,0,0.65)',
        padding: '3px 10px',
        borderRadius: radius.sm,
        letterSpacing: '1.5px',
        textTransform: 'uppercase',
        pointerEvents: 'none',
        backdropFilter: 'blur(4px)',
        border: `1px solid ${colors.accentDim}`,
      }}>
        {label}
      </div>

      {/* POV toggle — top right */}
      <button
        onClick={() => toggleActiveCam(cameraId)}
        style={{
          position: 'absolute', top: 10, right: 10,
          display: 'flex', alignItems: 'center', gap: 5,
          padding: '5px 11px',
          fontSize: 9, fontFamily: fonts.sans, fontWeight: 700,
          letterSpacing: '0.07em', textTransform: 'uppercase',
          color: isActivePov ? colors.bgDeep : accentColor,
          backgroundColor: isActivePov ? accentColor : 'rgba(0,0,0,0.65)',
          border: `1px solid ${isActivePov ? accentColor : `${accentColor}55`}`,
          borderRadius: radius.pill,
          cursor: 'pointer',
          backdropFilter: 'blur(8px)',
          transition: 'color 0.15s, background-color 0.15s, border-color 0.15s',
        }}
      >
        {isActivePov && (
          <span style={{ width: 6, height: 6, borderRadius: '50%', backgroundColor: colors.bgDeep, display: 'inline-block', flexShrink: 0 }} />
        )}
        {isActivePov ? 'POV ON' : 'POV'}
      </button>
    </div>
  )
}

// ---------------------------------------------------------------------------
// ThumbnailCam — single clickable camera in the thumbnail strip
// ---------------------------------------------------------------------------

function ThumbnailCam({ cameraId, onSelect }: { cameraId: number; onSelect: () => void }) {
  const cameraImages  = useSceneStore((s) => s.currentFrame?.cameraImages)
  const activeCam     = useSceneStore((s) => s.activeCam)
  const setHoveredCam = useSceneStore((s) => s.actions.setHoveredCam)

  const manifest    = getManifest()
  const camDef      = manifest.cameraSensors.find((c) => c.id === cameraId)
  const label       = camDef?.label ?? `CAM ${cameraId}`
  const accentColor = manifest.cameraColors[cameraId] ?? colors.accent
  const isActivePov = activeCam === cameraId

  const displayUrl = useBlobUrl(cameraImages?.get(cameraId) ?? null)
  const [hovered, setHovered] = useState(false)

  return (
    <div
      onClick={onSelect}
      onMouseEnter={() => { setHovered(true); setHoveredCam(cameraId) }}
      onMouseLeave={() => { setHovered(false); setHoveredCam(null) }}
      style={{
        flex: 1,
        position: 'relative',
        backgroundColor: colors.bgBase,
        borderRadius: radius.sm,
        overflow: 'hidden',
        cursor: 'pointer',
        border: isActivePov
          ? `2px solid ${accentColor}`
          : hovered
            ? '2px solid rgba(255,255,255,0.35)'
            : `2px solid ${colors.borderSubtle}`,
        boxShadow: isActivePov ? `0 0 8px ${accentColor}55` : 'none',
        transition: 'border-color 0.15s, box-shadow 0.15s',
      }}
    >
      {displayUrl ? (
        <img src={displayUrl} alt={label} style={{ width: '100%', height: '100%', objectFit: 'cover', display: 'block' }} />
      ) : (
        <div style={{ width: '100%', height: '100%', display: 'flex', alignItems: 'center', justifyContent: 'center', color: colors.textDim }}>
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
            <path d="M23 19a2 2 0 0 1-2 2H3a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4l2-3h6l2 3h4a2 2 0 0 1 2 2z" />
            <circle cx="12" cy="13" r="4" />
          </svg>
        </div>
      )}

      {/* Hover overlay: expand-to-large affordance */}
      {hovered && (
        <div style={{ position: 'absolute', inset: 0, backgroundColor: 'rgba(0,0,0,0.42)', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="white" strokeWidth="2" strokeLinecap="round" style={{ opacity: 0.9 }}>
            <polyline points="15 3 21 3 21 9" />
            <polyline points="9 21 3 21 3 15" />
            <line x1="21" y1="3" x2="14" y2="10" />
            <line x1="3" y1="21" x2="10" y2="14" />
          </svg>
        </div>
      )}

      {/* Label */}
      <div style={{
        position: 'absolute', bottom: 3, left: 3,
        fontSize: 8, fontWeight: 600, fontFamily: fonts.sans,
        color: colors.accent,
        backgroundColor: 'rgba(0,0,0,0.6)',
        padding: '1px 5px',
        borderRadius: 2,
        letterSpacing: '0.05em',
        textTransform: 'uppercase',
        pointerEvents: 'none',
        lineHeight: 1.7,
      }}>
        {label}
      </div>

      {/* POV active dot */}
      {isActivePov && (
        <div style={{
          position: 'absolute', top: 4, right: 4,
          width: 6, height: 6, borderRadius: '50%',
          backgroundColor: accentColor,
          boxShadow: `0 0 6px ${accentColor}`,
        }} />
      )}
    </div>
  )
}

// ---------------------------------------------------------------------------
// CameraThumbnailStrip — horizontal strip of all cameras except primaryCamId
// ---------------------------------------------------------------------------

export function CameraThumbnailStrip({
  primaryCamId,
  onSelectCamera,
}: {
  primaryCamId: number
  onSelectCamera: (id: number) => void
}) {
  const cameras = getManifest().cameraSensors
  const thumbnailCams = cameras.filter((c) => c.id !== primaryCamId)

  if (thumbnailCams.length === 0) return null

  return (
    <div style={{
      height: THUMBNAIL_STRIP_HEIGHT + 8,
      flexShrink: 0,
      display: 'flex',
      gap: 4,
      padding: '4px 6px',
      backgroundColor: '#0A0A0A',
      borderTop: `1px solid ${colors.borderSubtle}`,
      overflow: 'hidden',
    }}>
      {thumbnailCams.map(({ id }) => (
        <ThumbnailCam
          key={id}
          cameraId={id}
          onSelect={() => onSelectCamera(id)}
        />
      ))}
    </div>
  )
}

// ---------------------------------------------------------------------------
// 2D Bounding Box SVG Overlay
