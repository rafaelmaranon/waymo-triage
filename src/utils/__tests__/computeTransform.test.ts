/**
 * Unit tests for computeTransform — the image→display coordinate transform
 * used by BBoxOverlayCanvas (OPT-005).
 *
 * This function matches SVG preserveAspectRatio="xMidYMid slice" behavior:
 * the image is scaled to COVER the display area (no letterboxing), then
 * centered — excess is clipped.
 */

import { describe, it, expect } from 'vitest'
import { computeTransform } from '../../components/CameraPanel/BBoxOverlayCanvas'

describe('computeTransform()', () => {
  it('exact fit: scale=1, no offset', () => {
    const t = computeTransform(1920, 1280, 1920, 1280)
    expect(t.scale).toBeCloseTo(1, 5)
    expect(t.offsetX).toBeCloseTo(0, 5)
    expect(t.offsetY).toBeCloseTo(0, 5)
  })

  it('display wider than image: crops top/bottom (landscape letterbox → slice)', () => {
    // Display: 400x100, Image: 1920x1280 (3:2)
    // scale = max(400/1920, 100/1280) = max(0.2083, 0.0781) = 0.2083
    const t = computeTransform(400, 100, 1920, 1280)
    expect(t.scale).toBeCloseTo(400 / 1920, 5)
    // Vertical: 1280 * scale = 266.67, display=100 → offset = (100-266.67)/2 = -83.33
    expect(t.offsetY).toBeLessThan(0) // cropped vertically
    expect(t.offsetX).toBeCloseTo(0, 5) // width fits exactly
  })

  it('display taller than image: crops left/right', () => {
    // Display: 100x400, Image: 1920x1280
    // scale = max(100/1920, 400/1280) = max(0.052, 0.3125) = 0.3125
    const t = computeTransform(100, 400, 1920, 1280)
    expect(t.scale).toBeCloseTo(400 / 1280, 5)
    // Horizontal: 1920 * 0.3125 = 600, display=100 → offset = (100-600)/2 = -250
    expect(t.offsetX).toBeLessThan(0) // cropped horizontally
    expect(t.offsetY).toBeCloseTo(0, 5) // height fits exactly
  })

  it('half-size display: scale=0.5', () => {
    const t = computeTransform(960, 640, 1920, 1280)
    expect(t.scale).toBeCloseTo(0.5, 5)
    expect(t.offsetX).toBeCloseTo(0, 5)
    expect(t.offsetY).toBeCloseTo(0, 5)
  })

  it('double-size display: scale=2', () => {
    const t = computeTransform(3840, 2560, 1920, 1280)
    expect(t.scale).toBeCloseTo(2, 5)
    expect(t.offsetX).toBeCloseTo(0, 5)
    expect(t.offsetY).toBeCloseTo(0, 5)
  })

  it('waymo side camera in 160px strip (typical CameraPanel)', () => {
    // Side camera: 1920x886, displayed in ~320x160 card
    const t = computeTransform(320, 160, 1920, 886)
    // scale = max(320/1920, 160/886) = max(0.1667, 0.1806) = 0.1806
    const expectedScale = 160 / 886
    expect(t.scale).toBeCloseTo(expectedScale, 4)
    // Width: 1920 * 0.1806 = 346.7, display=320 → offset = (320-346.7)/2 = -13.3
    expect(t.offsetX).toBeLessThan(0)
    // Height: 886 * 0.1806 = 160 → offset = 0
    expect(t.offsetY).toBeCloseTo(0, 1)
  })

  it('waymo front camera in 160px strip (typical CameraPanel)', () => {
    // Front camera: 1920x1280, displayed in ~400x160 card
    const t = computeTransform(400, 160, 1920, 1280)
    // scale = max(400/1920, 160/1280) = max(0.2083, 0.125) = 0.2083
    const expectedScale = 400 / 1920
    expect(t.scale).toBeCloseTo(expectedScale, 4)
    // Width: 1920 * 0.2083 = 400 → offset = 0
    expect(t.offsetX).toBeCloseTo(0, 1)
    // Height: 1280 * 0.2083 = 266.67, display=160 → offset = (160-266.67)/2 = -53.3
    expect(t.offsetY).toBeLessThan(0)
  })

  it('inverse transform recovers image coordinates', () => {
    // Verify round-trip: image → display → image
    const t = computeTransform(400, 160, 1920, 1280)
    const imgX = 960 // center of image
    const imgY = 640
    // Forward: display coords
    const dispX = imgX * t.scale + t.offsetX
    const dispY = imgY * t.scale + t.offsetY
    // Inverse: back to image coords
    const recoveredX = (dispX - t.offsetX) / t.scale
    const recoveredY = (dispY - t.offsetY) / t.scale
    expect(recoveredX).toBeCloseTo(imgX, 5)
    expect(recoveredY).toBeCloseTo(imgY, 5)
  })

  it('image center always maps to display center', () => {
    // For any aspect ratio, xMidYMid means image center = display center
    const cases = [
      { dw: 400, dh: 160, iw: 1920, ih: 1280 },
      { dw: 320, dh: 160, iw: 1920, ih: 886 },
      { dw: 800, dh: 600, iw: 1920, ih: 1280 },
    ]
    for (const { dw, dh, iw, ih } of cases) {
      const t = computeTransform(dw, dh, iw, ih)
      const cx = (iw / 2) * t.scale + t.offsetX
      const cy = (ih / 2) * t.scale + t.offsetY
      expect(cx).toBeCloseTo(dw / 2, 3)
      expect(cy).toBeCloseTo(dh / 2, 3)
    }
  })
})
