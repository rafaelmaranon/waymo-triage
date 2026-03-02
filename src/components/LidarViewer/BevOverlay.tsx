/**
 * BevOverlay — Circular HTML container for the BEV minimap.
 *
 * Holds the raw <canvas> element that BevMinimapRenderer draws into.
 * Provides radar ring decorations, zoom label, and click-to-zoom toggle.
 * Styled to match the frosted glass panels used elsewhere in the UI.
 */

import { colors, fonts } from '../../theme'
import { BEV_SIZE, BEV_ZOOM_LABELS } from './BevMinimap'

const MARGIN_TOP = 12
const MARGIN_RIGHT = 12

export default function BevOverlay({
  canvasRef,
  zoomIndex,
  onToggleZoom,
}: {
  canvasRef: React.RefObject<HTMLCanvasElement | null>
  zoomIndex: number
  onToggleZoom: () => void
}) {
  return (
    <div
      onClick={onToggleZoom}
      style={{
        position: 'absolute',
        top: MARGIN_TOP,
        right: MARGIN_RIGHT,
        width: BEV_SIZE,
        height: BEV_SIZE,
        borderRadius: '50%',
        overflow: 'hidden',
        pointerEvents: 'auto',
        cursor: 'pointer',
        border: `1px solid ${colors.border}`,
        boxShadow: '0 2px 8px rgba(0, 0, 0, 0.3)',
      }}
    >
      {/* The actual WebGL canvas */}
      <canvas
        ref={canvasRef}
        width={BEV_SIZE * Math.min(window.devicePixelRatio, 2)}
        height={BEV_SIZE * Math.min(window.devicePixelRatio, 2)}
        style={{ width: BEV_SIZE, height: BEV_SIZE, display: 'block' }}
      />

      {/* Radar rings */}
      {[0.33, 0.66].map((scale) => (
        <div
          key={scale}
          style={{
            position: 'absolute',
            top: `${50 - scale * 50}%`,
            left: `${50 - scale * 50}%`,
            width: `${scale * 100}%`,
            height: `${scale * 100}%`,
            borderRadius: '50%',
            border: `1px solid ${colors.borderSubtle}`,
            pointerEvents: 'none',
          }}
        />
      ))}

      {/* Crosshair lines */}
      <div style={{
        position: 'absolute', top: 0, left: '50%',
        width: '1px', height: '100%',
        background: colors.borderSubtle, pointerEvents: 'none',
      }} />
      <div style={{
        position: 'absolute', top: '50%', left: 0,
        width: '100%', height: '1px',
        background: colors.borderSubtle, pointerEvents: 'none',
      }} />

      {/* Zoom level label */}
      <div style={{
        position: 'absolute', bottom: 12, left: '50%',
        transform: 'translateX(-50%)', pointerEvents: 'none',
      }}>
        <span style={{
          fontSize: '9px', fontFamily: fonts.mono, fontWeight: 500,
          color: colors.textDim,
        }}>
          {BEV_ZOOM_LABELS[zoomIndex]}
        </span>
      </div>
    </div>
  )
}
