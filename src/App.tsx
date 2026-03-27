import { useState, useEffect, useCallback, useRef } from 'react'
import { useSceneStore } from './stores/useSceneStore'
import LidarViewer from './components/LidarViewer/LidarViewer'
import { CameraLargeView, CameraThumbnailStrip } from './components/CameraPanel/CameraPanel'
import Timeline from './components/Timeline/Timeline'
import { colors, fonts, radius, gradients } from './theme'
import { getManifest } from './adapters/registry'
import { scanDataTransfer } from './utils/folderScan'
import { normalizeBaseUrl } from './utils/urlValidation'
import { parseViewParams, getInitialSearch, clearUrlSource } from './utils/urlState'
import { setPendingCameraPose } from './components/LidarViewer/LidarViewer'
import { trackDatasetLoad, trackKeyboardShortcut } from './utils/analytics'
import { getEmbedParams, type EmbedParams } from './utils/embedParams'
import { initEmbedApi } from './utils/embedApi'
import MemoryOverlay from './components/MemoryOverlay'
import { ScenarioPanel } from './components/ScenarioPanel/ScenarioPanel'
import { useFilterStore } from './stores/useFilterStore'
import scenarioIndex from './data/scenario_index.json'


// ---------------------------------------------------------------------------
// Segment discovery: fetch available segments from Vite API, auto-load if 1
// ---------------------------------------------------------------------------

/** Guard against double-invocation from React StrictMode */
let discoveryStarted = false

function useSegmentDiscovery() {
  const availableSegments = useSceneStore((s) => s.availableSegments)
  const actions = useSceneStore((s) => s.actions)

  useEffect(() => {
    if (!import.meta.env.DEV) return
    if (availableSegments.length > 0) return // already discovered
    if (discoveryStarted) return
    discoveryStarted = true

    fetch('/api/segments')
      .then((r) => r.json())
      .then(({ segments }: { segments: string[] }) => {
        if (segments.length === 0) return
        actions.setAvailableSegments(segments)

        // Auto-load first segment
        actions.selectSegment(segments[0])
      })
      .catch(() => {
        discoveryStarted = false
      })
  }, [availableSegments.length, actions])
}

// ---------------------------------------------------------------------------
// URL parameter auto-load: ?dataset=argoverse2&data=https://...
// Also handles embed mode: ?embed=true&dataset=...&data=...
// ---------------------------------------------------------------------------

const SUPPORTED_URL_DATASETS = ['argoverse2', 'nuscenes', 'waymo'] as const
type UrlDataset = typeof SUPPORTED_URL_DATASETS[number]

/** Guard against double-invocation from React StrictMode */
let urlAutoLoadStarted = false

function useUrlAutoLoad() {
  const status = useSceneStore((s) => s.status)
  const loadFromUrl = useSceneStore((s) => s.actions.loadFromUrl)

  useEffect(() => {
    if (urlAutoLoadStarted) return
    if (status !== 'idle') return

    const params = new URLSearchParams(window.location.search)
    const dataset = params.get('dataset')
    const dataUrl = params.get('data')
    const scene = params.get('scene') || undefined

    if (!dataset || !dataUrl) return
    if (!SUPPORTED_URL_DATASETS.includes(dataset as UrlDataset)) return

    urlAutoLoadStarted = true

    try {
      const baseUrl = normalizeBaseUrl(dataUrl)
      const hasView = new URLSearchParams(window.location.search).has('frame')
      trackDatasetLoad(dataset, hasView ? 'url' : 'preset')
      loadFromUrl(dataset, baseUrl, scene)
    } catch {
      // Invalid URL — silently ignore, user will see the landing page
      urlAutoLoadStarted = false
    }
  }, [status, loadFromUrl])
}

// ---------------------------------------------------------------------------
// URL view restore: apply shared view state params once data is ready
// ---------------------------------------------------------------------------

/** Guard against double-invocation */
let urlViewRestoreApplied = false

function useUrlViewRestore() {
  const status = useSceneStore((s) => s.status)

  useEffect(() => {
    if (urlViewRestoreApplied) return
    if (status !== 'ready') return

    // Use initial search (captured before replaceState overwrites view params)
    const viewParams = parseViewParams(getInitialSearch() ?? undefined)
    // Only restore if there are view params beyond dataset/data/scene
    if (Object.keys(viewParams).length === 0) return

    urlViewRestoreApplied = true
    const actions = useSceneStore.getState().actions
    const state = useSceneStore.getState()

    if (viewParams.frame != null) {
      const f = Math.min(viewParams.frame, state.totalFrames - 1)
      actions.seekFrame(f)
    }
    if (viewParams.colormap) {
      actions.setColormapMode(viewParams.colormap as typeof state.colormapMode)
    }
    if (viewParams.boxMode) {
      actions.setBoxMode(viewParams.boxMode as typeof state.boxMode)
    }
    if (viewParams.worldMode === false && state.worldMode) {
      actions.toggleWorldMode()
    }
    if (viewParams.sensors) {
      // Set exact sensor selection by toggling off all, then toggling on specified ones
      const allSensorIds = new Set(state.visibleSensors)
      const targetIds = new Set(viewParams.sensors)
      for (const id of allSensorIds) {
        if (!targetIds.has(id)) actions.toggleSensor(id)
      }
      for (const id of targetIds) {
        if (!allSensorIds.has(id)) actions.toggleSensor(id)
      }
    }
    if (viewParams.pointSize != null) actions.setPointSize(viewParams.pointSize)
    if (viewParams.pointOpacity != null) actions.setPointOpacity(viewParams.pointOpacity)
    if (viewParams.activeCam != null) actions.setActiveCam(viewParams.activeCam)
    if (viewParams.trailLength != null) actions.setTrailLength(viewParams.trailLength)
    if (viewParams.lidarOverlay && !state.showLidarOverlay) actions.toggleLidarOverlay()
    if (viewParams.keypoints3D && !state.showKeypoints3D) actions.toggleKeypoints3D()
    if (viewParams.keypoints2D && !state.showKeypoints2D) actions.toggleKeypoints2D()
    if (viewParams.cameraSeg && !state.showCameraSeg) actions.toggleCameraSeg()
    if (viewParams.speed != null) actions.setPlaybackSpeed(viewParams.speed)
    if (viewParams.followCam === false) actions.setFollowCam(false)
    if (viewParams.cameraPos && viewParams.cameraTarget) {
      setPendingCameraPose(viewParams.cameraPos, viewParams.cameraTarget, viewParams.cameraAzimuth, viewParams.cameraDistance)
    }
  }, [status])
}

// ---------------------------------------------------------------------------
// Embed mode: apply initial params once data is ready
// ---------------------------------------------------------------------------

function useEmbedInitialState(embedParams: EmbedParams) {
  const status = useSceneStore((s) => s.status)
  const appliedRef = useRef(false)

  useEffect(() => {
    if (!embedParams.embed || status !== 'ready' || appliedRef.current) return
    appliedRef.current = true

    const actions = useSceneStore.getState().actions

    // Apply initial frame
    if (embedParams.frame !== null) {
      const { totalFrames } = useSceneStore.getState()
      const f = Math.min(embedParams.frame, totalFrames - 1)
      actions.seekFrame(f)
    }

    // Apply colormap
    if (embedParams.colormap) {
      actions.setColormapMode(embedParams.colormap)
    }

    // Apply autoplay
    if (embedParams.autoplay) {
      actions.togglePlayback()
    }
  }, [embedParams, status])
}

// ---------------------------------------------------------------------------
// App
// ---------------------------------------------------------------------------

function App() {
  const [embedParams] = useState(() => getEmbedParams())
  useSegmentDiscovery()
  useUrlAutoLoad()
  useUrlViewRestore()
  useEmbedInitialState(embedParams)

  // Sync document title with active dataset + segment
  const _status = useSceneStore((s) => s.status)
  const _currentSegment = useSceneStore((s) => s.currentSegment)
  useEffect(() => {
    if (_status === 'ready' && _currentSegment) {
      const datasetName = getManifest().name
      const shortSeg = _currentSegment.length > 20
        ? `${_currentSegment.slice(0, 8)}…${_currentSegment.slice(-8)}`
        : _currentSegment
      document.title = `${shortSeg} — ${datasetName} · AV Triage`
    } else {
      document.title = 'AV Triage'
    }
  }, [_status, _currentSegment])

  // Initialize embed postMessage API when in embed mode
  useEffect(() => {
    if (!embedParams.embed) return
    const cleanup = initEmbedApi(embedParams)
    return cleanup
  }, [embedParams])

  // Browser back button: return to landing page when navigating back
  useEffect(() => {
    const onPopState = () => {
      const params = new URLSearchParams(window.location.search)
      if (!params.has('data')) {
        // No data param = landing page — full reset including segments
        const store = useSceneStore.getState()
        store.actions.reset()
        // reset() preserves segments for segment switching — clear them for landing
        useSceneStore.setState({
          availableSegments: [],
          currentSegment: null,
          segmentMetas: new Map(),
        })
        clearUrlSource()
        // Reset guards so forward-navigation can re-trigger auto-load
        urlAutoLoadStarted = false
        urlViewRestoreApplied = false
      } else {
        // Forward navigation — URL has data params, re-trigger load
        const { status: st } = useSceneStore.getState()
        if (st === 'idle' || st === 'ready') {
          // Reset state + guards, then re-load from URL
          if (st === 'ready') {
            const store = useSceneStore.getState()
            store.actions.reset()
            useSceneStore.setState({
              availableSegments: [],
              currentSegment: null,
              segmentMetas: new Map(),
            })
          }
          urlAutoLoadStarted = false
          urlViewRestoreApplied = false
          const dataset = params.get('dataset')!
          const dataUrl = params.get('data')!
          const scene = params.get('scene') || undefined
          if (SUPPORTED_URL_DATASETS.includes(dataset as UrlDataset)) {
            urlAutoLoadStarted = true
            try {
              const baseUrl = normalizeBaseUrl(dataUrl)
              useSceneStore.getState().actions.loadFromUrl(dataset, baseUrl, scene)
            } catch {
              urlAutoLoadStarted = false
            }
          }
        }
      }
    }
    window.addEventListener('popstate', onPopState)
    return () => window.removeEventListener('popstate', onPopState)
  }, [])
  const status = useSceneStore((s) => s.status)
  const availableSegments = useSceneStore((s) => s.availableSegments)
  const togglePlayback = useSceneStore((s) => s.actions.togglePlayback)
  const loadFromFiles = useSceneStore((s) => s.actions.loadFromFiles)

  const seekFrame = useSceneStore((s) => s.actions.seekFrame)
  const nextFrame = useSceneStore((s) => s.actions.nextFrame)
  const prevFrame = useSceneStore((s) => s.actions.prevFrame)

  const selectSegment = useSceneStore((s) => s.actions.selectSegment)

  // Global keyboard shortcuts:
  //   Space        = play/pause
  //   ← →          = ±1 frame
  //   [ / ]        = ±10 frames
  //   Shift+← / →  = prev/next segment
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const el = e.target as HTMLElement
      const tag = el?.tagName
      // Block shortcuts only for text-like inputs; allow range/checkbox/radio
      if (tag === 'TEXTAREA' || tag === 'SELECT') return
      if (tag === 'INPUT' && (el as HTMLInputElement).type !== 'range') return
      // Blur focused buttons so Space doesn't re-click them
      if (tag === 'BUTTON') (el as HTMLButtonElement).blur()

      // Shift+Arrow: segment navigation (works even during loading)
      if (e.shiftKey && (e.code === 'ArrowLeft' || e.code === 'ArrowRight')) {
        e.preventDefault()
        const { availableSegments: segs, currentSegment: cur, status: st } = useSceneStore.getState()
        if (st === 'loading' || !cur || segs.length <= 1) return
        const idx = segs.indexOf(cur)
        if (e.code === 'ArrowLeft' && idx > 0) { selectSegment(segs[idx - 1]); trackKeyboardShortcut('Shift+Left') }
        if (e.code === 'ArrowRight' && idx < segs.length - 1) { selectSegment(segs[idx + 1]); trackKeyboardShortcut('Shift+Right') }
        return
      }

      if (status !== 'ready') return

      switch (e.code) {
        case 'Space':
          e.preventDefault()
          togglePlayback()
          trackKeyboardShortcut('Space')
          break
        case 'ArrowRight':
          e.preventDefault()
          nextFrame()
          trackKeyboardShortcut('Right')
          break
        case 'ArrowLeft':
          e.preventDefault()
          prevFrame()
          trackKeyboardShortcut('Left')
          break
        case 'BracketRight': {
          e.preventDefault()
          const { currentFrameIndex: ci1, totalFrames: tf1 } = useSceneStore.getState()
          seekFrame(Math.min(ci1 + 10, tf1 - 1))
          trackKeyboardShortcut(']')
          break
        }
        case 'BracketLeft': {
          e.preventDefault()
          const { currentFrameIndex: ci2 } = useSceneStore.getState()
          seekFrame(Math.max(ci2 - 10, 0))
          trackKeyboardShortcut('[')
          break
        }
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [status, togglePlayback, nextFrame, prevFrame, seekFrame, selectSegment])

  // Show drop zone when no data loaded (idle + no segments)
  const showDropZone = status === 'idle' && availableSegments.length === 0
  const isEmbed = embedParams.embed
  const showTimeline = !showDropZone && (!isEmbed || embedParams.controls !== 'none')

  // Embed mode: custom background color
  const bgColor = isEmbed && embedParams.bgcolor
    ? `#${embedParams.bgcolor}`
    : colors.bgBase

  return (
    <div style={{
      width: '100%',
      height: '100dvh',
      display: 'flex',
      flexDirection: 'column',
      backgroundColor: bgColor,
      color: colors.textPrimary,
      fontFamily: fonts.sans,
      overflow: 'hidden',
    }}>
      {/* Memory debug overlay (enable: localStorage.setItem('waymo-memory-log','true') or press M) */}
      {!isEmbed && <MemoryOverlay />}

      {/* Main Content */}
      <main style={{ flex: 1, display: 'flex', flexDirection: 'row', overflow: 'hidden', position: 'relative' }}>
        {/* Scenario sidebar — hidden in embed mode only */}
        {!isEmbed && <ScenarioPanel />}
        <div style={{ flex: 1, display: 'flex', flexDirection: 'column', overflow: 'hidden', borderLeft: isEmbed ? 'none' : `1px solid ${colors.border}`, position: 'relative' }}>
          {showDropZone && !isEmbed ? (
            <DropZone onFilesLoaded={loadFromFiles} />
          ) : (
            <SensorView embedControls={isEmbed ? embedParams.controls : 'full'} />
          )}
        </div>
      </main>

      {/* Timeline — hidden in embed controls=none */}
      {showTimeline && (
        <footer style={{
          padding: isEmbed && embedParams.controls === 'minimal' ? '6px 12px' : '10px 20px',
          background: '#FFFFFF',
          borderTop: `1px solid ${colors.border}`,
          flexShrink: 0,
        }}>
          <Timeline minimal={isEmbed && embedParams.controls === 'minimal'} />
        </footer>
      )}

      {/* Credit bar — hidden in embed mode */}
      {!isEmbed && (
        <div style={{
          display: 'flex',
          justifyContent: 'center',
          alignItems: 'center',
          gap: 8,
          padding: '4px 0',
          fontSize: '10px',
          fontFamily: fonts.sans,
          color: colors.textDim,
          background: '#F1F3F5',
          borderTop: `1px solid ${colors.border}`,
          flexShrink: 0,
        }}>
          <span>AV Triage</span>
          <span style={{ opacity: 0.4 }}>·</span>
          <span>
            Powered by{' '}
            <a
              href="https://github.com/rafaelmaranon"
              target="_blank"
              rel="noopener noreferrer"
              style={{ color: colors.textSecondary, textDecoration: 'none', transition: 'color 0.15s' }}
              onMouseEnter={(e) => { e.currentTarget.style.color = colors.textPrimary }}
              onMouseLeave={(e) => { e.currentTarget.style.color = colors.textSecondary }}
            >ProdLab</a>
            {', '}
            <a
              href="https://github.com/egolens/egolens"
              target="_blank"
              rel="noopener noreferrer"
              style={{ color: colors.textSecondary, textDecoration: 'none', transition: 'color 0.15s' }}
              onMouseEnter={(e) => { e.currentTarget.style.color = colors.textPrimary }}
              onMouseLeave={(e) => { e.currentTarget.style.color = colors.textSecondary }}
            >EgoLens</a>
            {' and '}
            <a
              href="https://encord.com"
              target="_blank"
              rel="noopener noreferrer"
              style={{ color: colors.textSecondary, textDecoration: 'none', transition: 'color 0.15s' }}
              onMouseEnter={(e) => { e.currentTarget.style.color = colors.textPrimary }}
              onMouseLeave={(e) => { e.currentTarget.style.color = colors.textSecondary }}
            >Encord</a>
          </span>
          <span style={{ opacity: 0.4 }}>·</span>
          <a
            href="https://github.com/rafaelmaranon/waymo-triage"
            target="_blank"
            rel="noopener noreferrer"
            style={{ color: colors.textSecondary, textDecoration: 'none', transition: 'color 0.15s', display: 'inline-flex', alignItems: 'center', gap: 3 }}
            onMouseEnter={(e) => { e.currentTarget.style.color = colors.textPrimary }}
            onMouseLeave={(e) => { e.currentTarget.style.color = colors.textSecondary }}
          >
            <svg width="11" height="11" viewBox="0 0 24 24" fill="currentColor">
              <path d="M12 0C5.37 0 0 5.37 0 12c0 5.31 3.435 9.795 8.205 11.385.6.105.825-.255.825-.57 0-.285-.015-1.23-.015-2.235-3.015.555-3.795-.735-4.035-1.41-.135-.345-.72-1.41-1.23-1.695-.42-.225-1.02-.78-.015-.795.945-.015 1.62.87 1.845 1.23 1.08 1.815 2.805 1.305 3.495.99.105-.78.42-1.305.765-1.605-2.67-.3-5.46-1.335-5.46-5.925 0-1.305.465-2.385 1.23-3.225-.12-.3-.54-1.53.12-3.18 0 0 1.005-.315 3.3 1.23.96-.27 1.98-.405 3-.405s2.04.135 3 .405c2.295-1.56 3.3-1.23 3.3-1.23.66 1.65.24 2.88.12 3.18.765.84 1.23 1.905 1.23 3.225 0 4.605-2.805 5.625-5.475 5.925.435.375.81 1.095.81 2.22 0 1.605-.015 2.895-.015 3.3 0 .315.225.69.825.57A12.02 12.02 0 0 0 24 12c0-6.63-5.37-12-12-12z"/>
            </svg>
            GitHub
          </a>
        </div>
      )}
    </div>
  )
}



// ---------------------------------------------------------------------------
// Responsive hook — shared across Header, DropZone, etc.
// ---------------------------------------------------------------------------

function useIsMobile(breakpoint = 600) {
  const [isMobile, setIsMobile] = useState(() => window.innerWidth < breakpoint)
  useEffect(() => {
    const mq = window.matchMedia(`(max-width: ${breakpoint - 1}px)`)
    const handler = (e: MediaQueryListEvent) => setIsMobile(e.matches)
    mq.addEventListener('change', handler)
    setIsMobile(mq.matches)
    return () => mq.removeEventListener('change', handler)
  }, [breakpoint])
  return isMobile
}

// ---------------------------------------------------------------------------
// Landing page components
// ---------------------------------------------------------------------------

const USE_CASE_TYPES = [
  { type: 'near_miss',                      label: 'Near miss',             color: '#E24B4A', subtitle: 'Highest priority' },
  { type: 'cyclist_pedestrian_interaction', label: 'Cyclist + pedestrian',  color: '#534AB7', subtitle: 'VRU interactions' },
  { type: 'mid_block_crossing',             label: 'Mid-block crossing',    color: '#D85A30', subtitle: 'Unmarked crossings' },
  { type: 'dense_pedestrian',               label: 'Dense pedestrian',      color: '#378ADD', subtitle: 'Crowded scenes' },
  { type: 'pudo',                           label: 'PUDO',                  color: '#1D9E75', subtitle: 'Pickup / dropoff zones' },
  { type: 'cyclist_interaction',            label: 'Cyclist interaction',   color: '#BA7517', subtitle: 'Bike lane conflicts' },
] as const

type ScenarioItem = { id: string; type: string; location: string; label: string; dataset: string; base_url: string; disabled?: boolean; img_url?: string | null }
const _scenarios = scenarioIndex as ScenarioItem[]

function useCaseCounts() {
  const counts: Record<string, number> = {}
  for (const s of _scenarios) {
    counts[s.type] = (counts[s.type] || 0) + 1
  }
  return counts
}

function locationCounts() {
  const counts: Record<string, number> = {}
  for (const s of _scenarios) {
    if (s.location) counts[s.location] = (counts[s.location] || 0) + 1
  }
  // Sort descending by count
  return Object.entries(counts).sort((a, b) => b[1] - a[1])
}

function UseCaseGrid({ isMobile }: { isMobile: boolean }) {
  const setTypeFilter = useFilterStore(s => s.setTypeFilter)
  const counts = useCaseCounts()

  return (
    <div style={{
      display: 'grid',
      gridTemplateColumns: isMobile ? '1fr' : 'repeat(3, 1fr)',
      gap: '10px',
      width: '100%',
      maxWidth: '680px',
    }}>
      {USE_CASE_TYPES.map(({ type, label, color, subtitle }) => (
        <button
          key={type}
          onClick={() => setTypeFilter(type)}
          style={{
            display: 'flex', alignItems: 'stretch',
            padding: 0, margin: 0,
            backgroundColor: '#FFFFFF',
            border: `1px solid ${colors.border}`,
            borderRadius: radius.md,
            overflow: 'hidden',
            cursor: 'pointer',
            transition: 'box-shadow 0.15s, border-color 0.15s',
            boxShadow: '0 1px 3px rgba(0,0,0,0.06)',
            textAlign: 'left',
          }}
          onMouseEnter={(e) => { e.currentTarget.style.boxShadow = '0 2px 8px rgba(0,0,0,0.1)'; e.currentTarget.style.borderColor = color }}
          onMouseLeave={(e) => { e.currentTarget.style.boxShadow = '0 1px 3px rgba(0,0,0,0.06)'; e.currentTarget.style.borderColor = colors.border }}
        >
          {/* Colored left border */}
          <div style={{ width: 4, flexShrink: 0, backgroundColor: color }} />
          <div style={{ padding: '12px 14px', display: 'flex', flexDirection: 'column', gap: 3, flex: 1, minWidth: 0 }}>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8 }}>
              <span style={{ fontSize: 13, fontWeight: 600, fontFamily: fonts.sans, color: colors.textPrimary }}>{label}</span>
              <span style={{ fontSize: 13, fontWeight: 700, fontFamily: fonts.sans, color, flexShrink: 0 }}>{counts[type] ?? 0}</span>
            </div>
            <span style={{ fontSize: 11, fontFamily: fonts.sans, color: colors.textDim }}>{subtitle}</span>
          </div>
        </button>
      ))}
    </div>
  )
}

function CitiesRow() {
  const setSearchQuery = useFilterStore(s => s.setSearchQuery)
  const setTypeFilter = useFilterStore(s => s.setTypeFilter)
  const locs = locationCounts()

  return (
    <div style={{
      display: 'flex', gap: 8, flexWrap: 'wrap', justifyContent: 'center',
      width: '100%', maxWidth: '680px',
    }}>
      {locs.map(([loc, count]) => (
        <button
          key={loc}
          onClick={() => { setTypeFilter('all'); setSearchQuery(loc) }}
          style={{
            display: 'inline-flex', alignItems: 'center', gap: 5,
            padding: '5px 12px',
            fontSize: 12, fontFamily: fonts.sans, fontWeight: 500,
            color: colors.textSecondary,
            backgroundColor: '#FFFFFF',
            border: `1px solid ${colors.border}`,
            borderRadius: radius.pill,
            cursor: 'pointer',
            transition: 'all 0.15s',
          }}
          onMouseEnter={(e) => { e.currentTarget.style.borderColor = colors.accent; e.currentTarget.style.color = colors.accent }}
          onMouseLeave={(e) => { e.currentTarget.style.borderColor = colors.border; e.currentTarget.style.color = colors.textSecondary }}
        >
          <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ opacity: 0.5 }}>
            <path d="M21 10c0 7-9 13-9 13s-9-6-9-13a9 9 0 0 1 18 0z" /><circle cx="12" cy="10" r="3" />
          </svg>
          {loc}
          <span style={{ fontWeight: 700, color: colors.textPrimary, fontSize: 11 }}>{count}</span>
        </button>
      ))}
    </div>
  )
}

const LS_SENT_KEY = 'av_triage_encord_sent'
const ENCORD_PROJECT_URL = 'https://app.encord.com/projects/view/1b44da5a-ad5d-425c-818b-014be4dbce14'

function useSentIds(): string[] {
  const [ids, setIds] = useState<string[]>(() => {
    try {
      const raw = localStorage.getItem(LS_SENT_KEY)
      if (raw) return JSON.parse(raw) as string[]
    } catch { /* ignore */ }
    return []
  })

  useEffect(() => {
    const check = () => {
      try {
        const raw = localStorage.getItem(LS_SENT_KEY)
        if (raw) setIds(JSON.parse(raw) as string[])
      } catch { /* ignore */ }
    }
    window.addEventListener('storage', check)
    const interval = setInterval(check, 2000)
    return () => { window.removeEventListener('storage', check); clearInterval(interval) }
  }, [])

  return ids
}

function TriageProgress() {
  const total = _scenarios.filter(s => !s.disabled).length
  const sentIds = useSentIds()
  const sentCount = sentIds.length
  const sentOnly = useFilterStore(s => s.sentOnly)
  const setSentOnly = useFilterStore(s => s.setSentOnly)

  if (sentCount === 0) return null

  const pct = Math.min((sentCount / total) * 100, 100)

  return (
    <div
      onClick={() => setSentOnly(!sentOnly)}
      style={{
        display: 'flex', alignItems: 'center', gap: 10,
        padding: '8px 16px',
        backgroundColor: sentOnly ? colors.accentSubtle : '#FFFFFF',
        border: `1px solid ${sentOnly ? colors.accentDim : colors.border}`,
        borderRadius: radius.md,
        boxShadow: '0 1px 3px rgba(0,0,0,0.06)',
        maxWidth: '400px', width: '100%',
        cursor: 'pointer',
        transition: 'all 0.15s',
      }}
    >
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke={colors.accent} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <polyline points="20 6 9 17 4 12" />
      </svg>
      <div style={{ flex: 1, display: 'flex', flexDirection: 'column', gap: 4 }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <span style={{ fontSize: 11, fontFamily: fonts.sans, fontWeight: 600, color: colors.textPrimary }}>
            {sentOnly ? `Showing ${sentCount} sent` : `${sentCount} of ${total} sent to Encord`}
          </span>
          <span style={{ fontSize: 10, fontFamily: fonts.sans, color: sentOnly ? colors.accent : colors.textDim }}>
            {sentOnly ? 'Show all' : `${pct.toFixed(0)}%`}
          </span>
        </div>
        <div style={{ width: '100%', height: 4, backgroundColor: colors.bgOverlay, borderRadius: 2, overflow: 'hidden' }}>
          <div style={{ width: `${pct}%`, height: '100%', backgroundColor: colors.accent, borderRadius: 2, transition: 'width 0.3s ease' }} />
        </div>
      </div>
    </div>
  )
}

function RecentlySent() {
  const sentIds = useSentIds()
  if (sentIds.length === 0) return null

  // Get last 4 sent, most recent first
  const recentIds = sentIds.slice(-4).reverse()
  const scenarioMap = new Map(_scenarios.map(s => [s.id, s]))
  const recentScenarios = recentIds.map(id => scenarioMap.get(id)).filter(Boolean) as typeof _scenarios

  if (recentScenarios.length === 0) return null

  const typeColors: Record<string, string> = {
    near_miss: '#E24B4A', cyclist_pedestrian_interaction: '#534AB7',
    mid_block_crossing: '#D85A30', dense_pedestrian: '#378ADD',
    pudo: '#1D9E75', cyclist_interaction: '#BA7517',
  }

  return (
    <div style={{ width: '100%', maxWidth: '680px', display: 'flex', flexDirection: 'column', gap: 10 }}>
      <div style={{ fontSize: 11, fontFamily: fonts.sans, fontWeight: 600, color: colors.textDim, letterSpacing: '0.06em', textTransform: 'uppercase' }}>
        Recently sent
      </div>
      <div style={{ display: 'flex', gap: 10, overflowX: 'auto' }}>
        {recentScenarios.map((s) => {
          const tc = typeColors[s.type] ?? colors.textDim
          const imgUrl = s.dataset === 'argoverse2' && s.base_url
            ? `${s.base_url}sensors/cameras/ring_front_center/315968510419534000.jpg`
            : ('img_url' in s ? s.img_url : null)
          return (
            <div key={s.id} style={{
              flex: '0 0 200px', minWidth: 200,
              backgroundColor: '#FFFFFF',
              border: `1px solid ${colors.border}`,
              borderRadius: radius.md,
              overflow: 'hidden',
              boxShadow: '0 1px 3px rgba(0,0,0,0.06)',
            }}>
              {imgUrl && (
                <img src={imgUrl} loading="lazy" alt="" style={{ width: '100%', height: 80, objectFit: 'cover', display: 'block' }} />
              )}
              <div style={{ padding: '8px 10px', display: 'flex', flexDirection: 'column', gap: 5 }}>
                <div style={{ fontSize: 11, fontWeight: 600, fontFamily: fonts.sans, color: colors.textPrimary, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                  {s.label}
                </div>
                <div style={{ display: 'flex', alignItems: 'center', gap: 5 }}>
                  <span style={{
                    display: 'inline-block', padding: '1px 6px', fontSize: 9,
                    fontFamily: fonts.sans, fontWeight: 600, letterSpacing: '0.04em', textTransform: 'uppercase',
                    color: tc, backgroundColor: `${tc}12`, border: `1px solid ${tc}25`,
                    borderRadius: radius.pill, lineHeight: 1.7,
                  }}>
                    {s.type.replace(/_/g, ' ')}
                  </span>
                </div>
                <a
                  href={ENCORD_PROJECT_URL}
                  target="_blank"
                  rel="noopener noreferrer"
                  style={{
                    fontSize: 10, fontFamily: fonts.sans, fontWeight: 600,
                    color: colors.accent, textDecoration: 'none',
                  }}
                  onMouseEnter={(e) => { e.currentTarget.style.textDecoration = 'underline' }}
                  onMouseLeave={(e) => { e.currentTarget.style.textDecoration = 'none' }}
                >
                  Open in Encord &rarr;
                </a>
              </div>
            </div>
          )
        })}
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Drop Zone — shown when no data is loaded
// ---------------------------------------------------------------------------

function DropZone({ onFilesLoaded }: { onFilesLoaded: (segments: Map<string, Map<string, File>>) => Promise<void> }) {
  const [dragging, setDragging] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [scanning, setScanning] = useState(false)
  const dragCounter = useRef(0)
  const isMobile = useIsMobile()

  const handleFiles = useCallback(async (segments: Map<string, Map<string, File>>) => {
    if (segments.size === 0) {
      setError('No dataset found. Drop a Waymo, nuScenes, or Argoverse 2 dataset folder.')
      setScanning(false)
      return
    }
    // nuScenes sentinel key — pass directly (store handles validation)
    if (segments.has('__nuscenes__')) {
      setError(null)
      await onFilesLoaded(segments)
      return
    }
    // Argoverse 2 sentinel key — pass directly (store handles validation)
    if (segments.has('__argoverse2__')) {
      setError(null)
      await onFilesLoaded(segments)
      return
    }
    // Waymo: check that at least one segment has vehicle_pose (required)
    const valid = [...segments.entries()].filter(([, m]) => m.has('vehicle_pose'))
    if (valid.length === 0) {
      setError('No valid segments found. Each segment needs at least a vehicle_pose parquet file.')
      setScanning(false)
      return
    }
    setError(null)
    await onFilesLoaded(new Map(valid))
  }, [onFilesLoaded])

  const onDrop = useCallback(async (e: React.DragEvent) => {
    e.preventDefault()
    e.stopPropagation()
    setDragging(false)
    dragCounter.current = 0
    setScanning(true)
    setError(null)
    try {
      const segments = await scanDataTransfer(e.dataTransfer.items)
      await handleFiles(segments)
    } catch (err) {
      setError(`Failed to scan folder: ${err instanceof Error ? err.message : String(err)}`)
      setScanning(false)
    }
  }, [handleFiles])

  const onDragEnter = useCallback((e: React.DragEvent) => {
    e.preventDefault()
    e.stopPropagation()
    dragCounter.current++
    setDragging(true)
  }, [])

  const onDragLeave = useCallback((e: React.DragEvent) => {
    e.preventDefault()
    e.stopPropagation()
    dragCounter.current--
    if (dragCounter.current <= 0) {
      setDragging(false)
      dragCounter.current = 0
    }
  }, [])

  const onDragOver = useCallback((e: React.DragEvent) => {
    e.preventDefault()
    e.stopPropagation()
  }, [])

  return (
    <div
      className="dropzone-scroll"
      onDrop={onDrop}
      onDragEnter={onDragEnter}
      onDragLeave={onDragLeave}
      onDragOver={onDragOver}
      style={{
        flex: 1,
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        justifyContent: 'safe center',
        gap: isMobile ? '16px' : '24px',
        padding: isMobile ? '20px 16px' : '40px',
        overflow: 'auto',
        transition: 'background-color 0.2s',
        backgroundColor: dragging ? 'rgba(91, 80, 214, 0.03)' : '#FFFFFF',
      }}
    >
      <style>{`
        .dropzone-scroll::-webkit-scrollbar { width: 6px; height: 6px; }
        .dropzone-scroll::-webkit-scrollbar-track { background: transparent; }
        .dropzone-scroll::-webkit-scrollbar-thumb { background: rgba(0,0,0,0.1); border-radius: 3px; }
        .dropzone-scroll::-webkit-scrollbar-thumb:hover { background: rgba(0,0,0,0.2); }
        .dropzone-scroll { scrollbar-color: rgba(0,0,0,0.1) transparent; scrollbar-width: thin; }
      `}</style>

      {/* ── Hero ── */}
      <div style={{ textAlign: 'center', display: 'flex', flexDirection: 'column', alignItems: 'center', gap: '20px', maxWidth: '560px' }}>
        {/* Logo mark */}
        <div style={{
          width: 52, height: 52, borderRadius: '12px',
          background: `linear-gradient(135deg, ${colors.accent} 0%, ${colors.accentBlue} 100%)`,
          display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0,
          boxShadow: `0 4px 20px rgba(91, 80, 214, 0.2)`,
        }}>
          <svg width="26" height="26" viewBox="0 0 26 26" fill="none">
            <circle cx="13" cy="13" r="4.5" fill="#FFF" opacity="0.9" />
            <path d="M13 2.5 L13 7" stroke="#FFF" strokeWidth="2.2" strokeLinecap="round" opacity="0.7"/>
            <path d="M13 19 L13 23.5" stroke="#FFF" strokeWidth="2.2" strokeLinecap="round" opacity="0.7"/>
            <path d="M2.5 13 L7 13" stroke="#FFF" strokeWidth="2.2" strokeLinecap="round" opacity="0.7"/>
            <path d="M19 13 L23.5 13" stroke="#FFF" strokeWidth="2.2" strokeLinecap="round" opacity="0.7"/>
          </svg>
        </div>

        {/* Heading + subtitle */}
        <div style={{ display: 'flex', flexDirection: 'column', gap: '10px' }}>
          <h1 style={{
            margin: 0, fontSize: isMobile ? '22px' : '28px', fontWeight: 700,
            fontFamily: fonts.sans, letterSpacing: '-0.02em', color: colors.textPrimary, lineHeight: 1.2,
          }}>
            Find the right scenarios to label
          </h1>
          <p style={{
            margin: 0, fontSize: isMobile ? '13px' : '14px',
            fontFamily: fonts.sans, color: colors.textSecondary, lineHeight: 1.7,
          }}>
            Search 150+ scored AV scenarios, preview in 3D,<br />
            send to Encord in one click.
          </p>
        </div>

      </div>

      {/* ── Critical use cases ── */}
      <UseCaseGrid isMobile={isMobile} />

      {/* ── Cities ── */}
      <CitiesRow />

      {/* ── Triage progress ── */}
      <TriageProgress />

      {/* ── Recently sent ── */}
      <RecentlySent />

      {/* Scanning indicator (when files dropped) */}
      {scanning && (
        <div style={{
          fontSize: '14px',
          fontFamily: fonts.sans,
          color: colors.textSecondary,
        }}>
          Scanning folder for segments...
        </div>
      )}

      {error && (
        <div style={{
          fontSize: '12px',
          fontFamily: fonts.sans,
          color: colors.error,
          textAlign: 'center',
          padding: '8px 16px',
          backgroundColor: 'rgba(239, 68, 68, 0.06)',
          borderRadius: radius.sm,
          maxWidth: '520px',
        }}>
          {error}
        </div>
      )}
    </div>
  )

}

// ---------------------------------------------------------------------------
// Loading Skeleton
// ---------------------------------------------------------------------------

const LOAD_STEP_LABELS: Record<string, string> = {
  'opening': 'Opening data files…',
  'parsing': 'Loading metadata…',
  'workers': 'Initializing workers…',
  'first-frame': 'Decoding first frame…',
}

const LOAD_STEPS = ['opening', 'parsing', 'workers', 'first-frame'] as const

/** Shimmer keyframes — injected once */
const shimmerStyle = `
@keyframes shimmer {
  0% { background-position: -200% 0; }
  100% { background-position: 200% 0; }
}
`

/** Minimum time (ms) each step stays visible before advancing */
const STEP_MIN_MS = 400

function LoadingSkeleton() {
  const loadProgress = useSceneStore((s) => s.loadProgress)
  const loadStep = useSceneStore((s) => s.loadStep)
  const realStepIdx = LOAD_STEPS.indexOf(loadStep as typeof LOAD_STEPS[number])

  // Visual step trails behind the real step with a minimum display time
  const [displayStepIdx, setDisplayStepIdx] = useState(0)
  const [displayProgress, setDisplayProgress] = useState(0)
  const stepTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  useEffect(() => {
    if (realStepIdx > displayStepIdx) {
      // Queue the next visual step with a delay
      if (stepTimerRef.current) clearTimeout(stepTimerRef.current)
      stepTimerRef.current = setTimeout(() => {
        setDisplayStepIdx((prev) => Math.min(prev + 1, realStepIdx))
      }, STEP_MIN_MS)
    }
    return () => { if (stepTimerRef.current) clearTimeout(stepTimerRef.current) }
  }, [realStepIdx, displayStepIdx])

  // Smooth out progress bar — interpolate towards real value
  useEffect(() => {
    const target = loadProgress
    const step = () => {
      setDisplayProgress((prev) => {
        const diff = target - prev
        if (Math.abs(diff) < 0.005) return target
        return prev + diff * 0.15
      })
    }
    const id = setInterval(step, 30)
    return () => clearInterval(id)
  }, [loadProgress])

  const currentStepIdx = displayStepIdx

  return (
    <div style={{
      display: 'flex',
      flexDirection: 'column',
      alignItems: 'center',
      justifyContent: 'center',
      height: '100%',
      backgroundColor: colors.bgDeep,
      gap: '16px',
      padding: '40px',
    }}>
      {/* Progress bar + steps — no fake card */}
      <div style={{ width: '240px', display: 'flex', flexDirection: 'column', gap: '10px' }}>
        <div style={{
          height: '4px',
          backgroundColor: colors.bgOverlay,
          borderRadius: radius.pill,
          overflow: 'hidden',
        }}>
          <div style={{
            height: '100%',
            width: `${Math.round(displayProgress * 100)}%`,
            background: gradients.accent,
            borderRadius: radius.pill,
            transition: 'width 0.3s ease-out',
          }} />
        </div>

        {/* Step indicators */}
        <div style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}>
          {LOAD_STEPS.map((step, i) => {
            const isCurrent = i === currentStepIdx
            const isDone = i < currentStepIdx
            return (
              <div key={step} style={{
                display: 'flex',
                alignItems: 'center',
                gap: '8px',
                fontSize: '11px',
                fontFamily: fonts.mono,
                color: isCurrent ? colors.accent : isDone ? colors.textDim : colors.bgOverlay,
                transition: 'color 0.3s',
              }}>
                <span style={{ width: '14px', textAlign: 'center' }}>
                  {isDone ? '✓' : isCurrent ? '›' : '·'}
                </span>
                {LOAD_STEP_LABELS[step]}
              </div>
            )
          })}
        </div>
      </div>
    </div>
  )
}

/** Camera thumbnail strip skeleton — matches CameraThumbnailStrip height */
function CameraStripSkeleton() {
  const shimmerBg = `linear-gradient(90deg, ${colors.bgOverlay} 25%, ${colors.bgSurface} 50%, ${colors.bgOverlay} 75%)`
  return (
    <div style={{
      height: 108,
      flexShrink: 0,
      display: 'flex',
      gap: '4px',
      padding: '4px 6px',
      backgroundColor: colors.bgDeep,
      borderTop: `1px solid ${colors.borderSubtle}`,
      overflow: 'hidden',
    }}>
      <style>{shimmerStyle}</style>
      {[1, 2, 3, 4].map((i) => (
        <div key={i} style={{
          flex: 1,
          borderRadius: radius.sm,
          background: shimmerBg,
          backgroundSize: '200% 100%',
          animation: 'shimmer 1.5s ease-in-out infinite',
          animationDelay: `${i * 0.15}s`,
          opacity: 0.3,
        }} />
      ))}
    </div>
  )
}

// ---------------------------------------------------------------------------
// Main Views
// ---------------------------------------------------------------------------

// ShortcutHints removed — ? key now toggles Keys popup in LidarViewer

function SensorView({ embedControls = 'full' }: { embedControls?: 'full' | 'minimal' | 'none' }) {
  const status = useSceneStore((s) => s.status)
  const hideOverlays = embedControls === 'none'

  // Which camera is shown large on the left — defaults to FRONT
  const [primaryCamId, setPrimaryCamera] = useState<number | null>(null)

  // Reset to FRONT whenever a new dataset starts loading
  useEffect(() => {
    if (status === 'loading') setPrimaryCamera(null)
  }, [status])

  const cameras = getManifest().cameraSensors
  const defaultId = cameras.find((c) => c.label === 'FRONT')?.id ?? cameras[0]?.id ?? 1
  const primaryId = primaryCamId ?? defaultId

  // Embed (controls=none): full-width LiDAR only — preserve original embed behaviour
  if (hideOverlays) {
    return (
      <div style={{ flex: 1, display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
        <div style={{ flex: 1, position: 'relative', overflow: 'hidden' }}>
          <div style={{ position: 'absolute', inset: 0 }}>
            {status === 'ready' ? (
              <LidarViewer hideControls={true} />
            ) : status === 'loading' ? (
              <LoadingSkeleton />
            ) : (
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: '100%', backgroundColor: colors.bgDeep, color: colors.textDim, fontFamily: fonts.sans, fontSize: '14px' }}>
                3D LiDAR View
              </div>
            )}
          </div>
        </div>
      </div>
    )
  }

  return (
    <div style={{ flex: 1, display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>

      {/* ── Main row: large camera (left ~60%) + LiDAR 3D (right ~40%) ── */}
      <div style={{ flex: 1, display: 'flex', flexDirection: 'row', overflow: 'hidden' }}>

        {/* Large camera view */}
        <div style={{ flex: 3, position: 'relative', overflow: 'hidden', borderRight: `1px solid ${colors.border}` }}>
          {status === 'ready' ? (
            <CameraLargeView cameraId={primaryId} />
          ) : status === 'loading' ? (
            <div style={{ position: 'absolute', inset: 0, backgroundColor: colors.bgDeep, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
              <svg width="36" height="36" viewBox="0 0 24 24" fill="none" stroke={colors.textDim} strokeWidth="1" strokeLinecap="round" strokeLinejoin="round" style={{ opacity: 0.2 }}>
                <path d="M23 19a2 2 0 0 1-2 2H3a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4l2-3h6l2 3h4a2 2 0 0 1 2 2z" />
                <circle cx="12" cy="13" r="4" />
              </svg>
            </div>
          ) : (
            <div style={{ position: 'absolute', inset: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', backgroundColor: colors.bgDeep, color: colors.textDim, fontFamily: fonts.sans, fontSize: '13px', flexDirection: 'column', gap: 10 }}>
              <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1" strokeLinecap="round" strokeLinejoin="round" style={{ opacity: 0.25 }}>
                <path d="M23 19a2 2 0 0 1-2 2H3a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4l2-3h6l2 3h4a2 2 0 0 1 2 2z" />
                <circle cx="12" cy="13" r="4" />
              </svg>
              Camera
            </div>
          )}
        </div>

        {/* LiDAR 3D View */}
        <div style={{ flex: 2, position: 'relative', overflow: 'hidden' }}>
          <div style={{ position: 'absolute', inset: 0 }}>
            {status === 'ready' ? (
              <LidarViewer hideControls={false} />
            ) : status === 'loading' ? (
              <LoadingSkeleton />
            ) : (
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: '100%', backgroundColor: colors.bgDeep, color: colors.textDim, fontFamily: fonts.sans, fontSize: '14px' }}>
                3D LiDAR View
              </div>
            )}
          </div>
        </div>
      </div>

      {/* ── Thumbnail strip: all other cameras ── */}
      {status === 'ready' && cameras.length > 0 && (
        <CameraThumbnailStrip primaryCamId={primaryId} onSelectCamera={setPrimaryCamera} />
      )}
      {status === 'loading' && <CameraStripSkeleton />}
    </div>
  )
}

export default App
