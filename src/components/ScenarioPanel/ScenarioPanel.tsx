import { useState, useRef, useCallback, useEffect } from 'react';
import { useScenarios, DATASET_GROUPS, type Scenario } from '../../hooks/useScenarios';
import { useSceneStore } from '../../stores/useSceneStore';
import { useFilterStore } from '../../stores/useFilterStore';
import { colors, fonts, radius, shadows } from '../../theme';
import { buildShareUrl, hasUrlSource, getUrlSource, type ShareableState } from '../../utils/urlState';
import { getCameraPose } from '../LidarViewer/LidarViewer';
import scenarioIndex from '../../data/scenario_index.json';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const TYPE_COLORS: Record<string, { bg: string; text: string; border: string }> = {
  pudo:                           { bg: 'rgba(91, 80, 214, 0.08)',   text: '#5B50D6', border: 'rgba(91, 80, 214, 0.25)' },
  dense_pedestrian:               { bg: 'rgba(59, 130, 246, 0.08)',  text: '#3B82F6', border: 'rgba(59, 130, 246, 0.25)' },
  cyclist_interaction:            { bg: 'rgba(245, 158, 11, 0.08)',  text: '#D97706', border: 'rgba(245, 158, 11, 0.25)' },
  near_miss:                      { bg: 'rgba(239, 68, 68, 0.08)',   text: '#EF4444', border: 'rgba(239, 68, 68, 0.25)' },
  mid_block_crossing:             { bg: 'rgba(16, 185, 129, 0.08)',  text: '#059669', border: 'rgba(16, 185, 129, 0.25)' },
  cyclist_pedestrian_interaction: { bg: 'rgba(139, 92, 246, 0.08)',  text: '#7C3AED', border: 'rgba(139, 92, 246, 0.25)' },
};
const DEFAULT_TYPE_COLOR = { bg: 'rgba(107,114,128,0.08)', text: colors.textSecondary, border: 'rgba(107,114,128,0.2)' };

const TYPE_CHIPS: { value: string; label: string }[] = [
  { value: 'all',                            label: 'All' },
  { value: 'pudo',                           label: 'PUDO' },
  { value: 'dense_pedestrian',               label: 'Dense Ped' },
  { value: 'cyclist_interaction',            label: 'Cyclists' },
  { value: 'near_miss',                      label: 'Near Miss' },
  { value: 'mid_block_crossing',             label: 'Mid-Block' },
  { value: 'cyclist_pedestrian_interaction', label: 'Cyc + Ped' },
];

const TYPE_LABELS: Record<string, string> = {
  pudo: 'PUDO scenarios',
  dense_pedestrian: 'dense pedestrian scenarios',
  cyclist_interaction: 'cyclist interactions',
  near_miss: 'near misses',
  mid_block_crossing: 'mid-block crossings',
  cyclist_pedestrian_interaction: 'cyclist + ped scenarios',
};

const DATASET_SOURCE_LABEL: Record<string, string> = {
  nuscenes_mini:     'nuScenes',
  nuscenes_full:     'nuScenes',
  argoverse2:        'AV2',
  waymo_perception:  'Waymo',
  waymo_v2:          'Waymo v2',
};
const DATASET_SOURCE_COLOR: Record<string, string> = {
  nuscenes_mini:     '#3B82F6',
  argoverse2:        '#D97706',
  waymo_perception:  '#92805A',
  waymo_v2:          '#92805A',
  nuscenes_full:     '#3B82F6',
};

function normScore(s: Scenario) { return Math.min(s.quality_score, 10); }
function scoreColor(v: number)   { return v >= 8 ? colors.success : v >= 6 ? '#D97706' : colors.error; }
function formatType(t: string)   { return t.replace(/_/g, ' '); }

function thumbnailUrl(s: Scenario): string | null | undefined {
  if ('img_url' in s) return s.img_url ?? null;
  if (s.dataset === 'argoverse2') {
    return `${s.base_url}sensors/cameras/ring_front_center/315968510419534000.jpg`;
  }
  if (s.thumbnail) return s.thumbnail;
  return undefined;
}

const WAYMO_DATASETS = new Set(['waymo_perception', 'waymo_v2']);

// ---------------------------------------------------------------------------
// Thumbnail component
// ---------------------------------------------------------------------------

function ScenarioThumbnail({ scenario }: { scenario: Scenario }) {
  const [failed, setFailed] = useState(false);
  const url = thumbnailUrl(scenario);
  const tc = TYPE_COLORS[scenario.type] ?? DEFAULT_TYPE_COLOR;
  const isWaymo = WAYMO_DATASETS.has(scenario.dataset);
  const isWaymoLocked = isWaymo && !scenario.base_url;

  if (url === null || failed) {
    return (
      <div style={{
        width: '100%', height: 120, flexShrink: 0,
        background: isWaymoLocked
          ? `linear-gradient(160deg, #f5f0e8 0%, #F8F9FA 60%)`
          : `linear-gradient(135deg, ${tc.bg}, #F8F9FA 80%)`,
        display: 'flex', flexDirection: 'column',
        alignItems: 'center', justifyContent: 'center', gap: 6,
        borderBottom: `1px solid ${colors.border}`,
      }}>
        {isWaymoLocked ? (
          <>
            <svg width="28" height="10" viewBox="0 0 56 20" fill="none" style={{ opacity: 0.55 }}>
              <text x="0" y="16" fontFamily="Arial Black, sans-serif" fontWeight="900" fontSize="18" fill="#92805A" letterSpacing="2">WAYMO</text>
            </svg>
            <span style={{ fontSize: 8, fontFamily: fonts.sans, color: '#92805A', opacity: 0.5, letterSpacing: '0.1em', textTransform: 'uppercase' }}>
              Preview locked
            </span>
          </>
        ) : (
          <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke={tc.text} strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" style={{ opacity: 0.35 }}>
            <path d="M23 19a2 2 0 0 1-2 2H3a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4l2-3h6l2 3h4a2 2 0 0 1 2 2z" />
            <circle cx="12" cy="13" r="4" />
          </svg>
        )}
      </div>
    );
  }

  if (!url) return null;

  return (
    <img
      src={url}
      onError={() => setFailed(true)}
      loading="lazy"
      style={{ width: '100%', height: 120, objectFit: 'cover', display: 'block', flexShrink: 0 }}
      alt=""
    />
  );
}

// ---------------------------------------------------------------------------
// Star rating
// ---------------------------------------------------------------------------

function StarRating({ score }: { score: number }) {
  const norm = normScore({ quality_score: score } as Scenario);
  const filled = norm / 2;
  const color = scoreColor(norm);

  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 2 }}>
      {[1, 2, 3, 4, 5].map(i => {
        const frac = Math.min(Math.max(filled - (i - 1), 0), 1);
        return (
          <svg key={i} width="10" height="10" viewBox="0 0 24 24" style={{ flexShrink: 0 }}>
            <defs>
              <linearGradient id={`star-${i}-${score.toFixed(0)}`} x1="0" x2="1" y1="0" y2="0">
                <stop offset={`${frac * 100}%`} stopColor={color} />
                <stop offset={`${frac * 100}%`} stopColor={colors.bgHover} />
              </linearGradient>
            </defs>
            <polygon
              points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"
              fill={`url(#star-${i}-${score.toFixed(0)})`}
              stroke={frac > 0 ? color : colors.bgHover}
              strokeWidth="1"
            />
          </svg>
        );
      })}
      <span style={{ fontSize: 10, fontFamily: fonts.sans, fontWeight: 700, color, marginLeft: 3, letterSpacing: '-0.01em' }}>
        {norm.toFixed(1)}
      </span>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Pedestrian / cyclist count chips
// ---------------------------------------------------------------------------

function CountChip({ icon, value, color }: { icon: React.ReactNode; value: number; color: string }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 3, padding: '2px 6px', backgroundColor: `${color}10`, borderRadius: radius.pill, border: `1px solid ${color}20` }}>
      <span style={{ color, display: 'flex', alignItems: 'center' }}>{icon}</span>
      <span style={{ fontSize: 10, fontFamily: fonts.sans, fontWeight: 700, color, letterSpacing: '-0.01em' }}>
        {value >= 1000 ? `${(value / 1000).toFixed(1)}k` : value}
      </span>
    </div>
  );
}

function PedIcon() {
  return (
    <svg width="9" height="9" viewBox="0 0 24 24" fill="currentColor">
      <circle cx="12" cy="5" r="2.5" />
      <path d="M12 8.5c-2.5 0-4.5 2-4.5 4.5v4h2v4h5v-4h2v-4c0-2.5-2-4.5-4.5-4.5z" />
    </svg>
  );
}

function CyclistIcon() {
  return (
    <svg width="11" height="9" viewBox="0 0 32 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
      <circle cx="6" cy="18" r="5" />
      <circle cx="26" cy="18" r="5" />
      <path d="M6 18 L16 8 L22 8 M16 8 L20 18 M22 8 L26 18" />
      <circle cx="22" cy="5" r="2.5" fill="currentColor" stroke="none" />
    </svg>
  );
}

// ---------------------------------------------------------------------------
// Icons
// ---------------------------------------------------------------------------

function LockIcon({ size = 10 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <rect x="3" y="11" width="18" height="11" rx="2" ry="2" />
      <path d="M7 11V7a5 5 0 0 1 10 0v4" />
    </svg>
  );
}
function CopyIcon()  { return <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><rect x="9" y="9" width="13" height="13" rx="2" /><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" /></svg>; }
function CheckIcon() { return <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><polyline points="20 6 9 17 4 12" /></svg>; }
function PlayIcon()  { return <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="10" /><polygon points="10 8 16 12 10 16 10 8" fill="currentColor" /></svg>; }

// ---------------------------------------------------------------------------
// Stat chip (for Waymo expanded detail)
// ---------------------------------------------------------------------------

function StatChip({ label, value, valueColor }: { label: string; value: string; valueColor?: string }) {
  return (
    <div style={{ flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center', padding: '5px 4px', backgroundColor: '#F8F9FA', borderRadius: radius.sm, border: `1px solid ${colors.border}`, gap: 2 }}>
      <span style={{ fontSize: 12, fontWeight: 700, fontFamily: fonts.sans, color: valueColor ?? colors.textPrimary, letterSpacing: '-0.01em' }}>{value}</span>
      <span style={{ fontSize: 9, fontFamily: fonts.sans, color: colors.textDim, letterSpacing: '0.04em', textTransform: 'uppercase' }}>{label}</span>
    </div>
  );
}

function Pill({ label }: { label: string }) {
  return <span style={{ fontSize: 9, opacity: 0.6, letterSpacing: '0.06em', marginLeft: 4 }}>{label}</span>;
}

const disabledBtnStyle: React.CSSProperties = { display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 6, width: '100%', padding: '8px 12px', fontSize: 11, fontFamily: fonts.sans, fontWeight: 600, color: colors.textDim, backgroundColor: 'transparent', border: `1px solid ${colors.border}`, borderRadius: radius.sm, cursor: 'not-allowed', letterSpacing: '0.01em' };

function ActionButton({ onClick, active, label, activeLabel, icon, activeIcon }: { onClick: React.MouseEventHandler; active: boolean; label: string; activeLabel: string; icon: React.ReactNode; activeIcon: React.ReactNode }) {
  return (
    <button onClick={onClick} style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 6, width: '100%', padding: '8px 12px', fontSize: 11, fontFamily: fonts.sans, fontWeight: 600, color: active ? '#FFFFFF' : colors.accent, backgroundColor: active ? colors.accent : colors.accentSubtle, border: `1px solid ${active ? colors.accent : colors.accentDim}`, borderRadius: radius.sm, cursor: 'pointer', transition: 'all 0.15s', letterSpacing: '0.01em' }}>
      {active ? activeIcon : icon}{active ? activeLabel : label}
    </button>
  );
}

// ---------------------------------------------------------------------------
// Waymo expanded detail
// ---------------------------------------------------------------------------

function WaymoDetail({ scenario }: { scenario: Scenario }) {
  const [copied, setCopied] = useState(false);
  function copy() {
    navigator.clipboard.writeText(`gsutil -m cp "${scenario.gcs_path}" ~/Downloads/`).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    });
  }
  return (
    <div style={{ padding: '10px 12px 12px', borderTop: `1px solid ${colors.border}`, display: 'flex', flexDirection: 'column', gap: 10 }}>
      <div style={{ display: 'flex', gap: 8 }}>
        <StatChip label="Frames" value={String(scenario.frames)} />
        <StatChip label="Quality" value={normScore(scenario).toFixed(1)} valueColor={scoreColor(normScore(scenario))} />
        <StatChip label="Max peds" value={String(scenario.max_peds_nearby)} />
      </div>
      {scenario.notes && <p style={{ margin: 0, fontSize: 11, fontFamily: fonts.sans, color: colors.textSecondary, lineHeight: 1.5, fontStyle: 'italic' }}>{scenario.notes}</p>}
      {scenario.gcs_path && (
        <div style={{ fontSize: 9, fontFamily: fonts.mono ?? fonts.sans, color: colors.textSecondary, wordBreak: 'break-all', lineHeight: 1.4, padding: '5px 7px', backgroundColor: '#F8F9FA', borderRadius: radius.sm, border: `1px solid ${colors.border}` }}>
          {scenario.gcs_path}
        </div>
      )}
      <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
        <ActionButton onClick={(e) => { e.stopPropagation(); copy(); }} active={copied} activeLabel="Copied to clipboard" activeIcon={<CheckIcon />} icon={<CopyIcon />} label="Copy gsutil command" />
        <button onClick={(e) => e.stopPropagation()} disabled style={disabledBtnStyle}><PlayIcon /> Watch video <Pill label="SOON" /></button>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Section header
// ---------------------------------------------------------------------------

function SectionHeader({ label, count, allLocked, lockTooltip }: { label: string; count: number; allLocked: boolean; lockTooltip?: string }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '10px 4px 5px', marginTop: 2 }}>
      <span style={{ fontSize: 10, fontWeight: 700, fontFamily: fonts.sans, color: allLocked ? colors.textDim : colors.textSecondary, letterSpacing: '0.07em', textTransform: 'uppercase', flex: 1 }}>
        {label}
      </span>
      {allLocked && lockTooltip ? (
        <span title={lockTooltip} style={{ color: colors.textDim, display: 'flex', alignItems: 'center', gap: 4, cursor: 'help' }}>
          <LockIcon size={9} />
          <span style={{ fontSize: 9, fontFamily: fonts.sans, letterSpacing: '0.06em', textTransform: 'uppercase' }}>soon</span>
        </span>
      ) : (
        <span style={{ fontSize: 9, fontFamily: fonts.sans, color: colors.textDim }}>{count}</span>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Encord sent IDs persistence
// ---------------------------------------------------------------------------

const LS_KEY = 'av_triage_encord_sent';

function loadSentIds(): Set<string> {
  try {
    const raw = localStorage.getItem(LS_KEY);
    if (raw) return new Set(JSON.parse(raw) as string[]);
  } catch { /* ignore */ }
  return new Set();
}

function saveSentIds(ids: Set<string>) {
  try { localStorage.setItem(LS_KEY, JSON.stringify([...ids])); } catch { /* ignore */ }
}

// ---------------------------------------------------------------------------
// Encord workflow status hook + badge
// ---------------------------------------------------------------------------

const ENCORD_PROJECT_URL = 'https://app.encord.com/projects/view/1b44da5a-ad5d-425c-818b-014be4dbce14/queue';

/** Map of data_title → workflow status, fetched from API */
type StatusMap = Record<string, string>

function useEncordStatuses(): StatusMap {
  const [statuses, setStatuses] = useState<StatusMap>({});

  useEffect(() => {
    let cancelled = false;

    async function fetchStatuses() {
      try {
        const res = await fetch('/api/encord/status');
        if (!res.ok) return;
        const data = await res.json() as { statuses: StatusMap };
        if (!cancelled) setStatuses(data.statuses);
      } catch { /* API not running — ignore */ }
    }

    fetchStatuses();
    const interval = setInterval(fetchStatuses, 60_000);
    return () => { cancelled = true; clearInterval(interval); };
  }, []);

  return statuses;
}

/** Resolve workflow status for a scenario by matching its ID prefix against Encord data titles */
function resolveWorkflowStatus(scenarioId: string, statuses: StatusMap): string | null {
  const prefix = `av2_${scenarioId.slice(0, 8)}`;
  for (const [title, status] of Object.entries(statuses)) {
    if (title.startsWith(prefix)) return status;
  }
  return null;
}

/** Map Encord workflow node titles to display labels */
function workflowDisplay(status: string): { label: string; color: string; bg: string; border: string } {
  const s = status.toLowerCase();
  if (s.includes('complete')) return { label: 'Complete', color: '#059669', bg: 'rgba(16,185,129,0.08)', border: 'rgba(16,185,129,0.2)' };
  if (s.includes('review'))  return { label: 'In Review', color: '#D97706', bg: 'rgba(245,158,11,0.08)', border: 'rgba(245,158,11,0.2)' };
  // Default: Annotate or any other status = Queued
  return { label: 'Queued', color: colors.textDim, bg: 'rgba(156,163,175,0.08)', border: 'rgba(156,163,175,0.2)' };
}

function WorkflowBadge({ scenarioId, statuses }: { scenarioId: string; statuses: StatusMap }) {
  const status = resolveWorkflowStatus(scenarioId, statuses);
  const display = status ? workflowDisplay(status) : { label: 'Sent', color: colors.textDim, bg: 'rgba(156,163,175,0.08)', border: 'rgba(156,163,175,0.2)' };

  return (
    <div style={{
      display: 'inline-flex', alignItems: 'center', gap: 3,
      padding: '2px 6px', borderRadius: radius.pill,
      backgroundColor: display.bg,
      border: `1px solid ${display.border}`,
      fontSize: 9, fontFamily: fonts.sans, fontWeight: 600,
      color: display.color,
    }}>
      {display.label === 'Complete' ? (
        <svg width="8" height="8" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round">
          <polyline points="20 6 9 17 4 12" />
        </svg>
      ) : (
        <svg width="6" height="6" viewBox="0 0 6 6"><circle cx="3" cy="3" r="3" fill="currentColor" /></svg>
      )}
      {display.label}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Scenario card
// ---------------------------------------------------------------------------

function ScenarioCard({
  scenario, isHovered, isActive, isLoading, isExpanded, isSent, isSelected,
  statuses,
  onMouseEnter, onMouseLeave, onClick, onToggleSelect,
}: {
  scenario: Scenario;
  isHovered: boolean; isActive: boolean; isLoading: boolean; isExpanded: boolean; isSent: boolean; isSelected: boolean;
  statuses: StatusMap;
  onMouseEnter: () => void; onMouseLeave: () => void; onClick: () => void;
  onToggleSelect: () => void;
}) {
  const isWaymo   = scenario.dataset === 'waymo_perception' || scenario.dataset === 'waymo_v2';
  const isDisabled = !!scenario.disabled;
  const typeColor  = TYPE_COLORS[scenario.type] ?? DEFAULT_TYPE_COLOR;
  const srcColor   = DATASET_SOURCE_COLOR[scenario.dataset] ?? colors.textDim;
  const srcLabel   = DATASET_SOURCE_LABEL[scenario.dataset] ?? scenario.dataset;
  const hasThumbnail = !isDisabled;

  const pedCount     = scenario.n_pedestrians ?? scenario.max_peds_nearby ?? null;
  const cyclistCount = scenario.n_cyclists ?? null;
  const hasCounts    = pedCount !== null || cyclistCount !== null;

  const showCheckbox = !isDisabled && (!isWaymo || !!scenario.base_url);

  const cardBorder = isActive
    ? `2px solid ${colors.accent}`
    : isSelected
      ? `2px solid ${colors.accentDim}`
      : isHovered && !isDisabled
        ? `1px solid ${colors.border}`
        : `1px solid ${colors.border}`;
  const cardBg = isActive
    ? colors.accentSubtle
    : isSelected
      ? 'rgba(91, 80, 214, 0.04)'
      : isHovered && !isDisabled
        ? '#FFFFFF'
        : '#FFFFFF';
  const cardShadow = isActive
    ? `0 0 0 1px ${colors.accentDim}, ${shadows.card}`
    : isHovered && !isDisabled
      ? shadows.cardHover
      : shadows.card;

  return (
    <div
      onClick={onClick}
      onMouseEnter={onMouseEnter}
      onMouseLeave={onMouseLeave}
      title={isDisabled ? (DATASET_GROUPS.find(g => g.datasets.includes(scenario.dataset))?.lockTooltip ?? '') : undefined}
      style={{
        position: 'relative',
        backgroundColor: cardBg,
        border: cardBorder,
        borderRadius: radius.md,
        overflow: 'hidden',
        cursor: isDisabled ? 'default' : isLoading ? 'wait' : 'pointer',
        transition: 'background-color 0.15s, border-color 0.15s, box-shadow 0.15s',
        boxShadow: cardShadow,
        opacity: isDisabled ? 0.5 : isLoading ? 0.65 : 1,
        display: 'flex',
        flexDirection: 'column',
      }}
    >
      {/* Checkbox — top-right of card */}
      {showCheckbox && (
        <div
          onClick={(e) => { e.stopPropagation(); onToggleSelect(); }}
          style={{
            position: 'absolute', top: 6, right: 6, zIndex: 2,
            width: 18, height: 18, borderRadius: '4px',
            border: isSelected ? `2px solid ${colors.accent}` : `2px solid rgba(255,255,255,0.6)`,
            backgroundColor: isSelected ? colors.accent : 'rgba(255,255,255,0.8)',
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            cursor: 'pointer', transition: 'all 0.15s',
            backdropFilter: 'blur(4px)',
            boxShadow: '0 1px 3px rgba(0,0,0,0.15)',
          }}
        >
          {isSelected && (
            <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="#FFFFFF" strokeWidth="3.5" strokeLinecap="round" strokeLinejoin="round">
              <polyline points="20 6 9 17 4 12" />
            </svg>
          )}
        </div>
      )}

      {/* Thumbnail */}
      {hasThumbnail && <ScenarioThumbnail scenario={scenario} />}

      {/* Content */}
      <div style={{ padding: '9px 11px', display: 'flex', flexDirection: 'column', gap: 6 }}>

        {/* Row 1: title + indicator */}
        <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 6 }}>
          <div style={{ fontSize: 12, fontWeight: 600, fontFamily: fonts.sans, color: isActive ? colors.accent : isDisabled ? colors.textDim : colors.textPrimary, lineHeight: 1.3, letterSpacing: '-0.005em', flex: 1 }}>
            {scenario.label}
          </div>
          {isDisabled && <span style={{ color: colors.textDim, flexShrink: 0, marginTop: 1 }}><LockIcon size={11} /></span>}
          {isLoading && <span style={{ flexShrink: 0, color: colors.accent, fontSize: 9, fontFamily: fonts.sans, letterSpacing: '0.06em', textTransform: 'uppercase', paddingTop: 2 }}>Loading...</span>}
          {isActive && !isLoading && <svg width="8" height="8" viewBox="0 0 8 8" style={{ flexShrink: 0, marginTop: 3 }}><circle cx="4" cy="4" r="4" fill={colors.accent} /></svg>}
          {isWaymo && !isActive && !isLoading && !isDisabled && (
            <svg width="10" height="10" viewBox="0 0 10 10" fill="none" style={{ flexShrink: 0, marginTop: 2, color: colors.textDim, transform: isExpanded ? 'rotate(180deg)' : 'none', transition: 'transform 0.15s' }}>
              <path d="M2 3.5 L5 6.5 L8 3.5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
          )}
        </div>

        {/* Row 2: source tag + type badge */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 5, flexWrap: 'wrap' }}>
          <span style={{ fontSize: 9, fontFamily: fonts.sans, fontWeight: 600, letterSpacing: '0.06em', textTransform: 'uppercase', color: srcColor, opacity: 0.8 }}>
            {srcLabel}
          </span>
          <span style={{ color: colors.border, fontSize: 9 }}>·</span>
          <span style={{ display: 'inline-block', padding: '2px 7px', fontSize: 9, fontFamily: fonts.sans, fontWeight: 600, letterSpacing: '0.04em', textTransform: 'uppercase', color: typeColor.text, backgroundColor: typeColor.bg, border: `1px solid ${typeColor.border}`, borderRadius: radius.pill, lineHeight: 1.7 }}>
            {formatType(scenario.type)}
          </span>
          {scenario.has_fast_decel && (
            <span style={{ display: 'inline-block', padding: '2px 6px', fontSize: 9, fontFamily: fonts.sans, fontWeight: 600, letterSpacing: '0.04em', color: colors.error, backgroundColor: 'rgba(239,68,68,0.08)', border: '1px solid rgba(239,68,68,0.2)', borderRadius: radius.pill, lineHeight: 1.7 }}>
              decel
            </span>
          )}
          {isSent && <WorkflowBadge scenarioId={scenario.id} statuses={statuses} />}
        </div>

        {/* Row 3: location + star rating */}
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 6 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 4, fontSize: 10, fontFamily: fonts.sans, color: colors.textSecondary, minWidth: 0, overflow: 'hidden' }}>
            <svg width="9" height="9" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ flexShrink: 0, opacity: 0.6 }}>
              <path d="M21 10c0 7-9 13-9 13s-9-6-9-13a9 9 0 0 1 18 0z" /><circle cx="12" cy="10" r="3" />
            </svg>
            <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{scenario.location}</span>
          </div>
          {scenario.dataset !== 'argoverse2' && <StarRating score={scenario.quality_score} />}
        </div>

        {/* Row 4: ped / cyclist counts */}
        {hasCounts && (
          <div style={{ display: 'flex', alignItems: 'center', gap: 5 }}>
            {pedCount !== null && pedCount > 0 && (
              <CountChip icon={<PedIcon />} value={pedCount} color="#3B82F6" />
            )}
            {cyclistCount !== null && cyclistCount > 0 && (
              <CountChip icon={<CyclistIcon />} value={cyclistCount} color="#D97706" />
            )}
            <span style={{ fontSize: 9, fontFamily: fonts.sans, color: colors.textDim, marginLeft: 'auto' }}>
              {scenario.frames}f
            </span>
          </div>
        )}

        {/* Row 5: Open in Encord link — shown after sent */}
        {isSent && (
          <a
            href={ENCORD_PROJECT_URL}
            target="_blank"
            rel="noopener noreferrer"
            onClick={(e) => e.stopPropagation()}
            style={{
              display: 'flex', alignItems: 'center', gap: 5,
              padding: '6px 10px',
              fontSize: 11, fontFamily: fonts.sans, fontWeight: 600,
              color: colors.accent,
              backgroundColor: colors.accentSubtle,
              border: `1px solid ${colors.accentDim}`,
              borderRadius: radius.sm,
              textDecoration: 'none',
              transition: 'background-color 0.15s',
            }}
            onMouseEnter={(e) => { e.currentTarget.style.backgroundColor = 'rgba(91,80,214,0.12)' }}
            onMouseLeave={(e) => { e.currentTarget.style.backgroundColor = colors.accentSubtle }}
          >
            <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
              <polyline points="20 6 9 17 4 12" />
            </svg>
            Open in Encord &rarr;
          </a>
        )}
      </div>

      {/* Expanded Waymo detail */}
      {isExpanded && isWaymo && <WaymoDetail scenario={scenario} />}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Batch send progress bar
// ---------------------------------------------------------------------------

function BatchSendBar({
  selectedCount, sentCount, totalSending, error, onSend, onClear,
}: {
  selectedCount: number; sentCount: number; totalSending: number; error: string | null;
  onSend: () => void; onClear: () => void;
}) {
  const isSending = totalSending > 0;
  const progress = totalSending > 0 ? (sentCount / totalSending) * 100 : 0;

  return (
    <div style={{
      position: 'sticky', bottom: 0, left: 0, right: 0,
      padding: '12px 14px',
      borderTop: `1px solid ${colors.border}`,
      backgroundColor: '#FFFFFF',
      display: 'flex', flexDirection: 'column', gap: 8,
      boxShadow: '0 -2px 8px rgba(0,0,0,0.06)',
    }}>
      {isSending && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
          <div style={{ fontSize: 11, fontFamily: fonts.sans, color: colors.textSecondary }}>
            {sentCount} of {totalSending} sent...
          </div>
          <div style={{ width: '100%', height: 4, backgroundColor: colors.bgOverlay, borderRadius: 2, overflow: 'hidden' }}>
            <div style={{ width: `${progress}%`, height: '100%', backgroundColor: colors.accent, borderRadius: 2, transition: 'width 0.3s ease' }} />
          </div>
        </div>
      )}
      {error && (
        <div style={{ fontSize: 10, fontFamily: fonts.sans, color: colors.error, lineHeight: 1.4 }}>
          {error}
        </div>
      )}
      <div style={{ display: 'flex', gap: 8 }}>
        <button
          onClick={onSend}
          disabled={isSending || selectedCount === 0}
          style={{
            flex: 1,
            display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 6,
            padding: '9px 16px', fontSize: 12, fontFamily: fonts.sans, fontWeight: 600,
            color: '#FFFFFF',
            backgroundColor: isSending || selectedCount === 0 ? colors.textDim : colors.accent,
            border: 'none', borderRadius: radius.sm,
            cursor: isSending || selectedCount === 0 ? 'not-allowed' : 'pointer',
            transition: 'background-color 0.15s',
          }}
          onMouseEnter={(e) => { if (!isSending && selectedCount > 0) e.currentTarget.style.backgroundColor = colors.accentHover }}
          onMouseLeave={(e) => { if (!isSending && selectedCount > 0) e.currentTarget.style.backgroundColor = colors.accent }}
        >
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
            <line x1="22" y1="2" x2="11" y2="13" />
            <polygon points="22 2 15 22 11 13 2 9 22 2" />
          </svg>
          {isSending ? `Sending...` : `Send ${selectedCount} to Encord`}
        </button>
        <button
          onClick={onClear}
          style={{
            padding: '9px 12px', fontSize: 11, fontFamily: fonts.sans, fontWeight: 500,
            color: colors.textSecondary,
            backgroundColor: 'transparent',
            border: `1px solid ${colors.border}`, borderRadius: radius.sm,
            cursor: 'pointer', transition: 'all 0.15s',
          }}
          onMouseEnter={(e) => { e.currentTarget.style.borderColor = colors.textDim; e.currentTarget.style.color = colors.textPrimary }}
          onMouseLeave={(e) => { e.currentTarget.style.borderColor = colors.border; e.currentTarget.style.color = colors.textSecondary }}
        >
          Clear
        </button>
      </div>
      <style>{`@keyframes spin { from { transform: rotate(0deg); } to { transform: rotate(360deg); } }`}</style>
    </div>
  );
}

// ---------------------------------------------------------------------------
// ScenarioPanel
// ---------------------------------------------------------------------------

export function ScenarioPanel() {
  const typeFilter    = useFilterStore(s => s.typeFilter);
  const setTypeFilter = useFilterStore(s => s.setTypeFilter);
  const searchQuery   = useFilterStore(s => s.searchQuery);
  const setSearchQuery = useFilterStore(s => s.setSearchQuery);
  const [hoveredId,    setHoveredId]    = useState<string | null>(null);
  const [expandedId,   setExpandedId]   = useState<string | null>(null);
  const [loadingId,    setLoadingId]    = useState<string | null>(null);
  const [sentIds,      setSentIds]      = useState<Set<string>>(() => loadSentIds());
  const [selectedIds,  setSelectedIds]  = useState<Set<string>>(new Set());
  const [batchSent,    setBatchSent]    = useState(0);
  const [batchTotal,   setBatchTotal]   = useState(0);
  const [batchError,   setBatchError]   = useState<string | null>(null);
  const [shareCopied,  setShareCopied]  = useState(false);
  const searchRef = useRef<HTMLInputElement>(null);

  const sentOnly      = useFilterStore(s => s.sentOnly);
  const setSentOnly   = useFilterStore(s => s.setSentOnly);
  const allScenarios  = useScenarios(typeFilter, searchQuery);
  const scenarios     = sentOnly ? allScenarios.filter(s => sentIds.has(s.id)) : allScenarios;
  const total         = (scenarioIndex as Scenario[]).length;

  const loadFromUrl       = useSceneStore(s => s.actions.loadFromUrl);
  const selectSegment     = useSceneStore(s => s.actions.selectSegment);
  const availableSegments = useSceneStore(s => s.availableSegments);
  const currentSegment    = useSceneStore(s => s.currentSegment);
  const status            = useSceneStore(s => s.status);
  const encordStatuses    = useEncordStatuses();

  const handleShare = useCallback(() => {
    if (!hasUrlSource()) return;
    const s = useSceneStore.getState();
    const src = getUrlSource();
    const cam = getCameraPose();
    const state: ShareableState = {
      dataset: src?.dataset,
      baseUrl: src?.baseUrl,
      scene: s.currentSegment ?? undefined,
      frame: s.currentFrameIndex,
      colormap: s.colormapMode,
      boxMode: s.boxMode,
      worldMode: s.worldMode,
      sensors: [...s.visibleSensors],
      pointSize: s.pointSize,
      pointOpacity: s.pointOpacity,
      activeCam: s.activeCam,
      trailLength: s.trailLength,
      lidarOverlay: s.showLidarOverlay,
      keypoints3D: s.showKeypoints3D,
      keypoints2D: s.showKeypoints2D,
      cameraSeg: s.showCameraSeg,
      speed: s.playbackSpeed,
      followCam: s.followCam,
      cameraPos: cam.position,
      cameraTarget: cam.target,
      cameraAzimuth: cam.azimuth,
      cameraDistance: cam.distance || undefined,
    };
    navigator.clipboard.writeText(buildShareUrl(state)).then(() => {
      setShareCopied(true);
      setTimeout(() => setShareCopied(false), 2000);
    });
  }, []);

  // Selectable scenarios: not disabled, and either non-Waymo or Waymo with a base_url
  const selectableScenarios = scenarios.filter(s => !s.disabled && (!WAYMO_DATASETS.has(s.dataset) || !!s.base_url));
  const allVisibleSelected = selectableScenarios.length > 0 && selectableScenarios.every(s => selectedIds.has(s.id));

  const toggleSelectAll = useCallback(() => {
    setSelectedIds(prev => {
      const next = new Set(prev);
      if (allVisibleSelected) {
        selectableScenarios.forEach(s => next.delete(s.id));
      } else {
        selectableScenarios.forEach(s => next.add(s.id));
      }
      return next;
    });
  }, [allVisibleSelected, selectableScenarios]);

  const toggleSelect = useCallback((id: string) => {
    setSelectedIds(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  async function handleCardClick(s: Scenario) {
    if (s.disabled) return;

    if (s.dataset === 'waymo_perception' || s.dataset === 'waymo_v2') {
      // Waymo with no base_url → just expand/collapse detail
      if (!s.base_url) {
        setExpandedId(prev => prev === s.id ? null : s.id);
        return;
      }
      // Waymo with base_url → load in 3D viewer
      if (loadingId) return;
      if (currentSegment === s.id) return;
      if (availableSegments.includes(s.id)) {
        await selectSegment(s.id);
        return;
      }
      setLoadingId(s.id);
      try {
        await loadFromUrl('waymo', s.base_url, s.id);
      } finally {
        setLoadingId(null);
      }
      return;
    }

    if (s.dataset === 'nuscenes_mini' || s.dataset === 'argoverse2') {
      if (loadingId) return;
      if (currentSegment === s.id) return;
      if (availableSegments.includes(s.id)) {
        await selectSegment(s.id);
        return;
      }
      setLoadingId(s.id);
      try {
        if (s.dataset === 'nuscenes_mini') {
          await loadFromUrl('nuscenes', s.base_url, s.id);
        } else {
          await loadFromUrl('argoverse2', s.base_url);
        }
      } finally {
        setLoadingId(null);
      }
    }
  }

  async function sendSingle(scenarioId: string): Promise<boolean> {
    const scenario = (scenarioIndex as Scenario[]).find(s => s.id === scenarioId);
    try {
      const res = await fetch('/api/encord/send', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          scenario_id: scenarioId,
          dataset: scenario?.dataset ?? 'argoverse2',
        }),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({ detail: res.statusText }));
        throw new Error((data as { detail?: string }).detail ?? res.statusText);
      }
      const data = await res.json() as { success: boolean };
      if (!data.success) throw new Error('Unexpected response');
      return true;
    } catch {
      return false;
    }
  }

  async function handleBatchSend() {
    const ids = [...selectedIds].filter(id => !sentIds.has(id));
    if (ids.length === 0) return;


    setBatchSent(0);
    setBatchTotal(ids.length);
    setBatchError(null);

    let completed = 0;
    let failures = 0;
    const CONCURRENCY = 3;

    // Process in chunks of CONCURRENCY
    for (let i = 0; i < ids.length; i += CONCURRENCY) {
      const chunk = ids.slice(i, i + CONCURRENCY);
      const results = await Promise.all(chunk.map(id => sendSingle(id)));

      results.forEach((ok, idx) => {
        completed++;
        if (ok) {
          const id = chunk[idx];
          setSentIds(prev => {
            const next = new Set(prev);
            next.add(id);
            saveSentIds(next);
            return next;
          });
        } else {
          failures++;
        }
      });
      setBatchSent(completed);
    }


    if (failures > 0) {
      setBatchError(`${failures} of ${ids.length} failed. Is the API server running?`);
    } else {
      // Clear selection after successful batch
      setSelectedIds(new Set());
    }
    setBatchTotal(0);
  }

  // Count label
  const hasSearch = searchQuery.trim().length > 0;
  const hasType   = typeFilter !== 'all';
  let countLabel: string;
  if (sentOnly) {
    countLabel = `Showing ${scenarios.length} sent`;
  } else if (hasSearch && hasType) {
    countLabel = `${scenarios.length} of ${total} matching`;
  } else if (hasSearch) {
    countLabel = `${scenarios.length} matching`;
  } else if (hasType) {
    const typeName = TYPE_LABELS[typeFilter] ?? `${formatType(typeFilter)} scenarios`;
    countLabel = `${scenarios.length} ${typeName}`;
  } else {
    const live   = allScenarios.filter(s => !s.disabled).length;
    const locked = allScenarios.filter(s => s.disabled).length;
    countLabel = `${live} live · ${locked} locked`;
  }

  return (
    <aside style={{ width: 300, minWidth: 300, maxWidth: 300, height: '100%', display: 'flex', flexDirection: 'column', backgroundColor: '#F8F9FA', borderRight: `1px solid ${colors.border}`, overflow: 'hidden', flexShrink: 0 }}>
      <style>{`
        .scenario-scroll::-webkit-scrollbar { width: 4px; }
        .scenario-scroll::-webkit-scrollbar-track { background: transparent; }
        .scenario-scroll::-webkit-scrollbar-thumb { background: ${colors.border}; border-radius: 2px; }
        .scenario-scroll::-webkit-scrollbar-thumb:hover { background: ${colors.textDim}; }
        .scenario-scroll { scrollbar-color: ${colors.border} transparent; scrollbar-width: thin; }
        .type-chips::-webkit-scrollbar { display: none; }
        .type-chips { scrollbar-width: none; }
        .search-input::placeholder { color: ${colors.textDim}; }
        .search-input:focus { outline: none; border-color: ${colors.accentDim} !important; }
        .chip-btn { transition: background-color 0.12s, color 0.12s, border-color 0.12s; }
      `}</style>

      {/* Header */}
      <div style={{ padding: '14px 14px 10px', borderBottom: `1px solid ${colors.border}`, flexShrink: 0 }}>

        {/* Logo row */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 12 }}>
          <div style={{ width: 28, height: 28, borderRadius: radius.sm, background: `linear-gradient(135deg, ${colors.accent} 0%, ${colors.accentBlue} 100%)`, display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none">
              <circle cx="12" cy="12" r="3" fill="#FFF" opacity="0.9" />
              <path d="M12 2 L12 6 M12 18 L12 22 M2 12 L6 12 M18 12 L22 12" stroke="#FFF" strokeWidth="2.5" strokeLinecap="round" opacity="0.7" />
              <circle cx="12" cy="12" r="8" stroke="#FFF" strokeWidth="1.5" fill="none" opacity="0.4" />
            </svg>
          </div>
          <div style={{ flex: 1 }}>
            <div style={{ fontSize: 15, fontWeight: 700, fontFamily: fonts.sans, color: colors.textPrimary, letterSpacing: '-0.01em', lineHeight: 1 }}>AV Triage</div>
            <div style={{ fontSize: 10, fontFamily: fonts.sans, color: colors.textDim, letterSpacing: '0.06em', textTransform: 'uppercase', marginTop: 2, lineHeight: 1 }}>Scenario Review</div>
          </div>
          {/* Share button — small icon */}
          {status === 'ready' && hasUrlSource() && (
            <button
              onClick={handleShare}
              title={shareCopied ? 'Link copied!' : 'Copy share link'}
              style={{
                display: 'flex', alignItems: 'center', justifyContent: 'center',
                width: 28, height: 28, flexShrink: 0,
                backgroundColor: shareCopied ? colors.accentSubtle : 'transparent',
                border: `1px solid ${shareCopied ? colors.accent : colors.border}`,
                borderRadius: radius.sm, cursor: 'pointer',
                color: shareCopied ? colors.accent : colors.textDim,
                transition: 'all 0.15s',
              }}
            >
              {shareCopied ? (
                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                  <polyline points="20 6 9 17 4 12" />
                </svg>
              ) : (
                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71" />
                  <path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71" />
                </svg>
              )}
            </button>
          )}
        </div>

        {/* Search box */}
        <div style={{ position: 'relative', marginBottom: 8 }}>
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke={colors.textDim} strokeWidth="2" strokeLinecap="round" style={{ position: 'absolute', left: 10, top: '50%', transform: 'translateY(-50%)', pointerEvents: 'none' }}>
            <circle cx="11" cy="11" r="8" /><path d="M21 21l-4.35-4.35" />
          </svg>
          <input
            ref={searchRef}
            className="search-input"
            type="text"
            value={searchQuery}
            onChange={e => setSearchQuery(e.target.value)}
            placeholder="Type, location, or score >8"
            style={{
              width: '100%', boxSizing: 'border-box',
              padding: '7px 28px 7px 30px',
              fontSize: 11, fontFamily: fonts.sans, fontWeight: 500,
              backgroundColor: '#FFFFFF', color: colors.textPrimary,
              border: `1px solid ${colors.border}`, borderRadius: radius.sm,
              letterSpacing: '0.01em',
            }}
          />
          {searchQuery && (
            <button
              onClick={() => setSearchQuery('')}
              style={{ position: 'absolute', right: 8, top: '50%', transform: 'translateY(-50%)', background: 'none', border: 'none', cursor: 'pointer', color: colors.textDim, padding: 0, display: 'flex', alignItems: 'center' }}
            >
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round">
                <line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" />
              </svg>
            </button>
          )}
        </div>

        {/* Type chips */}
        <div className="type-chips" style={{ display: 'flex', gap: 4, overflowX: 'auto', paddingBottom: 2, marginBottom: 8 }}>
          {TYPE_CHIPS.map(chip => {
            const active = typeFilter === chip.value;
            const tc = chip.value === 'all' ? null : (TYPE_COLORS[chip.value] ?? null);
            return (
              <button
                key={chip.value}
                className="chip-btn"
                onClick={() => setTypeFilter(chip.value)}
                style={{
                  flexShrink: 0,
                  padding: '3px 8px',
                  fontSize: 10, fontFamily: fonts.sans, fontWeight: 600,
                  letterSpacing: '0.03em',
                  borderRadius: radius.pill,
                  cursor: 'pointer',
                  border: active
                    ? `1px solid ${tc ? tc.border : colors.accentDim}`
                    : `1px solid ${colors.border}`,
                  backgroundColor: active
                    ? (tc ? tc.bg : colors.accentSubtle)
                    : 'transparent',
                  color: active
                    ? (tc ? tc.text : colors.accent)
                    : colors.textDim,
                }}
              >
                {chip.label}
              </button>
            );
          })}
        </div>

        {/* Count + select all toggle */}
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
          <div style={{ fontSize: 10, fontFamily: fonts.sans, color: colors.textDim, letterSpacing: '0.02em' }}>
            {countLabel}
            {sentOnly && (
              <button
                onClick={() => setSentOnly(false)}
                style={{ fontSize: 10, fontFamily: fonts.sans, fontWeight: 500, color: colors.accent, backgroundColor: 'transparent', border: 'none', cursor: 'pointer', padding: '0 4px', marginLeft: 4 }}
              >Show all</button>
            )}
          </div>
          {selectableScenarios.length > 0 && (
            <button
              onClick={toggleSelectAll}
              style={{
                fontSize: 10, fontFamily: fonts.sans, fontWeight: 500,
                color: colors.accent, backgroundColor: 'transparent',
                border: 'none', cursor: 'pointer', padding: '2px 4px',
              }}
            >
              {allVisibleSelected ? 'Deselect All' : 'Select All Visible'}
            </button>
          )}
        </div>
      </div>

      {/* Grouped scenario list */}
      <div className="scenario-scroll" style={{ flex: 1, overflowY: 'auto', padding: '4px 8px 16px', display: 'flex', flexDirection: 'column' }}>
        {DATASET_GROUPS.map(group => {
          const groupScenarios = scenarios.filter(s => group.datasets.includes(s.dataset));
          if (groupScenarios.length === 0) return null;
          const allLocked = groupScenarios.every(s => s.disabled);

          return (
            <div key={group.key}>
              <SectionHeader label={group.label} count={groupScenarios.length} allLocked={allLocked} lockTooltip={group.lockTooltip} />
              <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                {groupScenarios.map(s => (
                  <ScenarioCard
                    key={s.id}
                    scenario={s}
                    isHovered={hoveredId === s.id}
                    isActive={currentSegment === s.id}
                    isLoading={loadingId === s.id}
                    isExpanded={expandedId === s.id}
                    isSent={sentIds.has(s.id)}
                    isSelected={selectedIds.has(s.id)}
                    statuses={encordStatuses}
                    onMouseEnter={() => setHoveredId(s.id)}
                    onMouseLeave={() => setHoveredId(null)}
                    onClick={() => handleCardClick(s)}
                    onToggleSelect={() => toggleSelect(s.id)}
                  />
                ))}
              </div>
            </div>
          );
        })}

        {scenarios.length === 0 && (
          <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', flex: 1, gap: 8, padding: '40px 16px', color: colors.textDim, fontFamily: fonts.sans, fontSize: 12, textAlign: 'center' }}>
            <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round">
              <circle cx="11" cy="11" r="8" /><path d="M21 21l-4.35-4.35" />
            </svg>
            No scenarios match this filter
          </div>
        )}
      </div>

      {/* Batch send bar — visible when items selected */}
      {selectedIds.size > 0 && (
        <BatchSendBar
          selectedCount={[...selectedIds].filter(id => !sentIds.has(id)).length}
          sentCount={batchSent}
          totalSending={batchTotal}
          error={batchError}
          onSend={handleBatchSend}
          onClear={() => { setSelectedIds(new Set()); setBatchError(null); }}
        />
      )}
    </aside>
  );
}
