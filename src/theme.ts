/**
 * AV Triage design tokens — Encord-inspired light theme
 *
 * Color palette: purple accent on white/light gray backgrounds
 * - Light backgrounds with clean, professional styling
 * - Encord purple accent for interactive elements
 */

// ---------------------------------------------------------------------------
// Core palette
// ---------------------------------------------------------------------------

export const colors = {
  /** Primary accent — Encord purple */
  accent: '#5B50D6',
  accentDim: 'rgba(91, 80, 214, 0.2)',
  accentGlow: 'rgba(91, 80, 214, 0.08)',

  /** Accent hover */
  accentHover: '#4F46E5',

  /** Accent subtle */
  accentSubtle: 'rgba(91, 80, 214, 0.08)',

  /** Secondary accent — blue */
  accentBlue: '#6366F1',

  /** Background tiers */
  bgDeep: '#0C0F1A',       // 3D scene only — stays dark
  bgBase: '#FFFFFF',        // main app background
  bgSurface: '#F8F9FA',    // header, footer, cards
  bgOverlay: '#F1F3F5',    // buttons, overlays
  bgHover: '#E9ECEF',      // hover states

  /** Borders */
  border: '#E5E7EB',
  borderSubtle: '#F1F3F5',

  /** Text */
  textPrimary: '#1A1A2E',
  textSecondary: '#6B7280',
  textDim: '#9CA3AF',

  /** Semantic — success, warning, error */
  success: '#10B981',
  warning: '#F59E0B',
  error: '#EF4444',

  /** Semantic — sensor LiDAR (cool-tone family) */
  sensorTop: '#5B50D6',       // purple (primary)
  sensorFront: '#6366F1',     // indigo
  sensorSideL: '#4DA8FF',     // sky blue
  sensorSideR: '#7B6FFF',     // violet
  sensorRear: '#B490FF',      // lavender

  /** Semantic — radar sensors (warm-tone family to distinguish from LiDAR) */
  radarFront: '#EF4444',       // red
  radarFrontLeft: '#F59E0B',   // amber
  radarFrontRight: '#EAB308',  // yellow
  radarBackLeft: '#DC2626',    // dark red
  radarBackRight: '#EA580C',   // orange

  /** Semantic — cameras (harmonized with sensors) */
  camFront: '#1A1A2E',
  camFrontLeft: '#5B50D6',
  camFrontRight: '#6366F1',
  camSideLeft: '#4DA8FF',
  camSideRight: '#B490FF',

  /** Semantic — detection object types (nuScenes convention) */
  boxVehicle: '#FF9E00',
  boxPedestrian: '#CCFF00',
  boxSign: '#FF44FF',
  boxCyclist: '#DC143C',
  boxUnknown: '#6B7280',

  /** 3D scene — subtle so LiDAR points dominate (stays dark) */
  gridMajor: '#2E3550',
  gridMinor: '#252B42',
  vehicleMarker: '#5B50D6',

  /** Gizmo */
  gizmoX: '#EF4444',
  gizmoY: '#10B981',
  gizmoZ: '#4DA8FF',
} as const

// ---------------------------------------------------------------------------
// Typography
// ---------------------------------------------------------------------------

export const fonts = {
  /** UI labels, headers, body text — Inter / system font stack */
  sans: "Inter, -apple-system, 'system-ui', 'Segoe UI', Roboto, 'Helvetica Neue', Arial, 'Noto Sans', sans-serif",
  /** Data values, technical readouts */
  mono: "'SF Mono', 'Cascadia Code', 'JetBrains Mono', Consolas, monospace",
} as const

// ---------------------------------------------------------------------------
// Spacing & Radii
// ---------------------------------------------------------------------------

export const radius = {
  sm: '6px',
  md: '8px',
  lg: '12px',
  pill: '999px',
} as const

// ---------------------------------------------------------------------------
// Shadows
// ---------------------------------------------------------------------------

export const shadows = {
  card: '0 1px 3px rgba(0, 0, 0, 0.06)',
  cardHover: '0 2px 8px rgba(0, 0, 0, 0.1)',
  glow: `0 0 12px rgba(91, 80, 214, 0.1)`,
  glowStrong: `0 0 20px rgba(91, 80, 214, 0.15)`,
} as const

// ---------------------------------------------------------------------------
// Gradients
// ---------------------------------------------------------------------------

export const gradients = {
  /** Timeline progress bar */
  accent: `linear-gradient(90deg, #5B50D6, #6366F1)`,
  /** Subtle header/footer background */
  surface: `linear-gradient(180deg, #F8F9FA 0%, #FFFFFF 100%)`,
} as const
