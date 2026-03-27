/**
 * Camera image preload cache.
 *
 * Stores pre-decoded blob URLs keyed by ArrayBuffer identity so that
 * when playback advances to the next frame the blob URL is ready
 * immediately (no decode delay).
 *
 * Importable by both the store (to trigger preloading) and
 * CameraPanel (to consume pre-decoded URLs).
 */

/** ArrayBuffer identity → pre-decoded blob URL */
const preloadCache = new Map<ArrayBuffer, string>()

/** Return a pre-decoded URL for a buffer, or undefined if not ready. */
export function getPreloadedUrl(buffer: ArrayBuffer): string | undefined {
  return preloadCache.get(buffer)
}

/**
 * Start pre-decoding blob URLs for a list of camera ArrayBuffers.
 * No-ops for buffers already in cache.
 */
export function preloadCameraImages(buffers: ArrayBuffer[]): void {
  for (const buf of buffers) {
    if (preloadCache.has(buf)) continue
    const blob = new Blob([buf], { type: 'image/jpeg' })
    const url = URL.createObjectURL(blob)
    const img = new Image()
    img.onload = () => { preloadCache.set(buf, url) }
    img.onerror = () => { URL.revokeObjectURL(url) }
    img.src = url
  }
}
