import { useState } from 'react';
import { useScenarios, DATASET_GROUPS, type Scenario } from '../../hooks/useScenarios';
import { useSceneStore } from '../../stores/useSceneStore';
import { colors, fonts, radius, shadows } from '../../theme';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const TYPE_COLORS: Record<string, { bg: string; text: string; border: string }> = {
  pudo:                { bg: 'rgba(0, 232, 157, 0.12)',  text: '#00E89D', border: 'rgba(0, 232, 157, 0.3)' },
  dense_pedestrian:    { bg: 'rgba(77, 168, 255, 0.12)', text: '#4DA8FF', border: 'rgba(77, 168, 255, 0.3)' },
  cyclist_interaction: { bg: 'rgba(255, 158, 0, 0.12)',  text: '#FF9E00', border: 'rgba(255, 158, 0, 0.3)' },
  near_miss:           { bg: 'rgba(255, 107, 107, 0.12)',text: '#FF6B6B', border: 'rgba(255, 107, 107, 0.3)' },
  mid_block_crossing:  { bg: 'rgba(204, 255, 0, 0.12)',  text: '#CCFF00', border: 'rgba(204, 255, 0, 0.3)' },
};
const DEFAULT_TYPE_COLOR = { bg: 'rgba(90,99,120,0.15)', text: colors.textSecondary, border: 'rgba(90,99,120,0.3)' };

const DATASET_SOURCE_COLOR: Record<string, string> = {
  nuscenes_mini: '#4DA8FF',
  argoverse2:    '#FF9E00',
  waymo_perception: '#A0855B',
  waymo_v2:      '#A0855B',
  nuscenes_full: '#4DA8FF',
};

function scoreColor(s: number) { return s >= 8 ? '#00E89D' : s >= 6 ? '#FF9E00' : '#FF6B6B'; }
function formatType(t: string) { return t.replace(/_/g, ' '); }

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
    <div style={{ marginTop: 2, paddingTop: 10, borderTop: `1px solid ${colors.borderSubtle}`, display: 'flex', flexDirection: 'column', gap: 10 }}>
      <div style={{ display: 'flex', gap: 8 }}>
        <StatChip label="Frames" value={String(scenario.frames)} />
        <StatChip label="Quality" value={scenario.quality_score.toFixed(1)} valueColor={scoreColor(scenario.quality_score)} />
        <StatChip label="Max peds" value={String(scenario.max_peds_nearby)} />
      </div>
      {scenario.notes && <p style={{ margin: 0, fontSize: 11, fontFamily: fonts.sans, color: colors.textSecondary, lineHeight: 1.5, fontStyle: 'italic' }}>{scenario.notes}</p>}
      {scenario.gcs_path && (
        <div style={{ fontSize: 9, fontFamily: fonts.mono ?? fonts.sans, color: colors.textDim, wordBreak: 'break-all', lineHeight: 1.4, padding: '5px 7px', backgroundColor: colors.bgDeep, borderRadius: radius.sm, border: `1px solid ${colors.borderSubtle}` }}>
          {scenario.gcs_path}
        </div>
      )}
      <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
        <ActionButton
          onClick={(e) => { e.stopPropagation(); copy(); }}
          active={copied}
          activeLabel="Copied to clipboard"
          activeIcon={<CheckIcon />}
          icon={<CopyIcon />}
          label="Copy gsutil command"
        />
        <button onClick={(e) => e.stopPropagation()} disabled style={disabledBtnStyle}>
          <PlayIcon /> Watch video <Pill label="SOON" />
        </button>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Stat chip
// ---------------------------------------------------------------------------

function StatChip({ label, value, valueColor }: { label: string; value: string; valueColor?: string }) {
  return (
    <div style={{ flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center', padding: '5px 4px', backgroundColor: colors.bgDeep, borderRadius: radius.sm, border: `1px solid ${colors.borderSubtle}`, gap: 2 }}>
      <span style={{ fontSize: 12, fontWeight: 700, fontFamily: fonts.sans, color: valueColor ?? colors.textPrimary, letterSpacing: '-0.01em' }}>{value}</span>
      <span style={{ fontSize: 9, fontFamily: fonts.sans, color: colors.textDim, letterSpacing: '0.04em', textTransform: 'uppercase' }}>{label}</span>
    </div>
  );
}

function Pill({ label }: { label: string }) {
  return <span style={{ fontSize: 9, opacity: 0.6, letterSpacing: '0.06em', marginLeft: 4 }}>{label}</span>;
}

// ---------------------------------------------------------------------------
// Buttons
// ---------------------------------------------------------------------------

const disabledBtnStyle: React.CSSProperties = { display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 6, width: '100%', padding: '8px 12px', fontSize: 11, fontFamily: fonts.sans, fontWeight: 600, color: colors.textDim, backgroundColor: 'transparent', border: `1px solid ${colors.borderSubtle}`, borderRadius: radius.sm, cursor: 'not-allowed', letterSpacing: '0.01em' };

function ActionButton({ onClick, active, label, activeLabel, icon, activeIcon }: { onClick: React.MouseEventHandler; active: boolean; label: string; activeLabel: string; icon: React.ReactNode; activeIcon: React.ReactNode }) {
  return (
    <button onClick={onClick} style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 6, width: '100%', padding: '8px 12px', fontSize: 11, fontFamily: fonts.sans, fontWeight: 600, color: active ? colors.bgDeep : colors.accent, backgroundColor: active ? colors.accent : 'rgba(0,232,157,0.1)', border: `1px solid ${active ? colors.accent : colors.accentDim}`, borderRadius: radius.sm, cursor: 'pointer', transition: 'all 0.15s', letterSpacing: '0.01em' }}>
      {active ? activeIcon : icon}{active ? activeLabel : label}
    </button>
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
        <span style={{ fontSize: 9, fontFamily: fonts.sans, color: colors.textDim }}>
          {count}
        </span>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Scenario card
// ---------------------------------------------------------------------------

function ScenarioCard({
  scenario,
  isHovered, isActive, isLoading, isExpanded,
  onMouseEnter, onMouseLeave, onClick,
}: {
  scenario: Scenario;
  isHovered: boolean; isActive: boolean; isLoading: boolean; isExpanded: boolean;
  onMouseEnter: () => void; onMouseLeave: () => void; onClick: () => void;
}) {
  const isWaymo = scenario.dataset === 'waymo_perception';
  const isDisabled = !!scenario.disabled;
  const typeColor = TYPE_COLORS[scenario.type] ?? DEFAULT_TYPE_COLOR;
  const srcColor = DATASET_SOURCE_COLOR[scenario.dataset] ?? colors.textDim;

  return (
    <div
      onClick={onClick}
      onMouseEnter={onMouseEnter}
      onMouseLeave={onMouseLeave}
      title={isDisabled ? (DATASET_GROUPS.find(g => g.datasets.includes(scenario.dataset))?.lockTooltip ?? '') : undefined}
      style={{
        backgroundColor: isActive ? 'rgba(0,232,157,0.06)' : isExpanded ? 'rgba(0,232,157,0.04)' : isHovered ? colors.bgOverlay : colors.bgBase,
        border: `1px solid ${isActive || isExpanded ? colors.accentDim : isHovered && !isDisabled ? colors.border : colors.borderSubtle}`,
        borderRadius: radius.md,
        padding: '10px 12px',
        cursor: isDisabled ? 'default' : isLoading ? 'wait' : 'pointer',
        transition: 'background-color 0.15s, border-color 0.15s',
        boxShadow: isActive ? `0 0 0 1px ${colors.accentDim}` : isHovered && !isDisabled ? shadows.card : 'none',
        display: 'flex', flexDirection: 'column', gap: 7,
        opacity: isDisabled ? 0.5 : isLoading ? 0.65 : 1,
      }}
    >
      {/* Row 1: title + right indicator */}
      <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 6 }}>
        <div style={{ fontSize: 12, fontWeight: 600, fontFamily: fonts.sans, color: isActive ? colors.accent : isDisabled ? colors.textDim : colors.textPrimary, lineHeight: 1.3, letterSpacing: '-0.005em', flex: 1 }}>
          {scenario.label}
        </div>
        {isDisabled && <span title={DATASET_GROUPS.find(g => g.datasets.includes(scenario.dataset))?.lockTooltip ?? ''} style={{ color: colors.textDim, flexShrink: 0, marginTop: 2 }}><LockIcon size={11} /></span>}
        {isLoading && <span style={{ flexShrink: 0, color: colors.accent, fontSize: 9, fontFamily: fonts.sans, letterSpacing: '0.06em', textTransform: 'uppercase', paddingTop: 2 }}>Loading…</span>}
        {isActive && !isLoading && <svg width="8" height="8" viewBox="0 0 8 8" style={{ flexShrink: 0, marginTop: 3 }}><circle cx="4" cy="4" r="4" fill={colors.accent} /></svg>}
        {isWaymo && !isActive && !isLoading && !isDisabled && (
          <svg width="10" height="10" viewBox="0 0 10 10" fill="none" style={{ flexShrink: 0, marginTop: 2, color: colors.textDim, transform: isExpanded ? 'rotate(180deg)' : 'none', transition: 'transform 0.15s' }}>
            <path d="M2 3.5 L5 6.5 L8 3.5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        )}
      </div>

      {/* Row 2: source tag + type badge */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 5, flexWrap: 'wrap' }}>
        <span style={{ fontSize: 9, fontFamily: fonts.sans, fontWeight: 600, letterSpacing: '0.06em', textTransform: 'uppercase', color: srcColor, opacity: 0.75 }}>
          {scenario.dataset === 'nuscenes_mini' ? 'nuScenes' : scenario.dataset === 'nuscenes_full' ? 'nuScenes' : scenario.dataset === 'argoverse2' ? 'AV2' : scenario.dataset === 'waymo_v2' ? 'Waymo v2' : 'Waymo'}
        </span>
        <span style={{ color: colors.borderSubtle, fontSize: 9 }}>·</span>
        <span style={{ display: 'inline-block', padding: '2px 7px', fontSize: 10, fontFamily: fonts.sans, fontWeight: 600, letterSpacing: '0.04em', textTransform: 'uppercase', color: typeColor.text, backgroundColor: typeColor.bg, border: `1px solid ${typeColor.border}`, borderRadius: radius.pill, lineHeight: 1.6 }}>
          {formatType(scenario.type)}
        </span>
      </div>

      {/* Row 3: location + score */}
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 4, fontSize: 10, fontFamily: fonts.sans, color: colors.textSecondary, minWidth: 0, overflow: 'hidden' }}>
          <svg width="9" height="9" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ flexShrink: 0, opacity: 0.6 }}>
            <path d="M21 10c0 7-9 13-9 13s-9-6-9-13a9 9 0 0 1 18 0z" /><circle cx="12" cy="10" r="3" />
          </svg>
          <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{scenario.location}</span>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 4, flexShrink: 0 }}>
          <svg width="9" height="9" viewBox="0 0 24 24" fill={scoreColor(scenario.quality_score)} style={{ opacity: 0.9 }}>
            <polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2" />
          </svg>
          <span style={{ fontSize: 11, fontFamily: fonts.sans, fontWeight: 700, color: scoreColor(scenario.quality_score), letterSpacing: '-0.01em' }}>
            {scenario.quality_score.toFixed(1)}
          </span>
        </div>
      </div>

      {/* Expanded Waymo detail */}
      {isExpanded && isWaymo && <WaymoDetail scenario={scenario} />}
    </div>
  );
}

// ---------------------------------------------------------------------------
// ScenarioPanel
// ---------------------------------------------------------------------------

export function ScenarioPanel() {
  const [typeFilter, setTypeFilter] = useState('all');
  const [hoveredId, setHoveredId] = useState<string | null>(null);
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [loadingId, setLoadingId] = useState<string | null>(null);

  const scenarios = useScenarios(typeFilter);

  const loadFromUrl = useSceneStore((s) => s.actions.loadFromUrl);
  const selectSegment = useSceneStore((s) => s.actions.selectSegment);
  const availableSegments = useSceneStore((s) => s.availableSegments);
  const currentSegment = useSceneStore((s) => s.currentSegment);

  async function handleCardClick(s: Scenario) {
    if (s.disabled) return;

    if (s.dataset === 'waymo_perception') {
      setExpandedId((prev) => (prev === s.id ? null : s.id));
      return;
    }

    // Live-loadable datasets
    if (s.dataset === 'nuscenes_mini' || s.dataset === 'argoverse2') {
      if (loadingId) return;
      if (currentSegment === s.id) return;

      // Already discovered — just switch
      if (availableSegments.includes(s.id)) {
        await selectSegment(s.id);
        return;
      }

      setLoadingId(s.id);
      try {
        if (s.dataset === 'nuscenes_mini') {
          // base_url is parent; pass scene name as initialScene
          await loadFromUrl('nuscenes', s.base_url, s.id);
        } else {
          // base_url is log-specific; no initialScene needed
          await loadFromUrl('argoverse2', s.base_url);
        }
      } finally {
        setLoadingId(null);
      }
    }
  }

  return (
    <aside style={{ width: 280, minWidth: 280, maxWidth: 280, height: '100%', display: 'flex', flexDirection: 'column', backgroundColor: colors.bgSurface, borderRight: `1px solid ${colors.border}`, overflow: 'hidden', flexShrink: 0 }}>
      <style>{`
        .scenario-scroll::-webkit-scrollbar { width: 4px; }
        .scenario-scroll::-webkit-scrollbar-track { background: transparent; }
        .scenario-scroll::-webkit-scrollbar-thumb { background: ${colors.border}; border-radius: 2px; }
        .scenario-scroll::-webkit-scrollbar-thumb:hover { background: ${colors.bgHover}; }
        .scenario-scroll { scrollbar-color: ${colors.border} transparent; scrollbar-width: thin; }
        .scenario-select option { background-color: ${colors.bgSurface}; color: ${colors.textPrimary}; }
      `}</style>

      {/* ── Header ── */}
      <div style={{ padding: '16px 16px 12px', borderBottom: `1px solid ${colors.borderSubtle}`, flexShrink: 0 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 12 }}>
          <div style={{ width: 28, height: 28, borderRadius: radius.sm, background: `linear-gradient(135deg, ${colors.accent} 0%, ${colors.accentBlue} 100%)`, display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none">
              <circle cx="12" cy="12" r="3" fill="#000" opacity="0.8" />
              <path d="M12 2 L12 6 M12 18 L12 22 M2 12 L6 12 M18 12 L22 12" stroke="#000" strokeWidth="2.5" strokeLinecap="round" opacity="0.7" />
              <circle cx="12" cy="12" r="8" stroke="#000" strokeWidth="1.5" fill="none" opacity="0.4" />
            </svg>
          </div>
          <div>
            <div style={{ fontSize: 15, fontWeight: 700, fontFamily: fonts.sans, color: colors.textPrimary, letterSpacing: '-0.01em', lineHeight: 1 }}>AV Triage</div>
            <div style={{ fontSize: 10, fontFamily: fonts.sans, color: colors.textDim, letterSpacing: '0.06em', textTransform: 'uppercase', marginTop: 2, lineHeight: 1 }}>Scenario Review</div>
          </div>
        </div>

        <div style={{ position: 'relative' }}>
          <select className="scenario-select" value={typeFilter} onChange={(e) => setTypeFilter(e.target.value)} style={{ width: '100%', padding: '7px 28px 7px 10px', fontSize: 11, fontFamily: fonts.sans, fontWeight: 500, backgroundColor: colors.bgOverlay, color: colors.textPrimary, border: `1px solid ${colors.border}`, borderRadius: radius.sm, outline: 'none', cursor: 'pointer', appearance: 'none', WebkitAppearance: 'none', letterSpacing: '0.01em' }}>
            <option value="all">All types</option>
            <option value="pudo">PUDO</option>
            <option value="dense_pedestrian">Dense Pedestrian</option>
            <option value="cyclist_interaction">Cyclist Interaction</option>
            <option value="near_miss">Near Miss</option>
            <option value="mid_block_crossing">Mid-Block Crossing</option>
          </select>
          <svg width="10" height="10" viewBox="0 0 10 10" fill="none" style={{ position: 'absolute', right: 10, top: '50%', transform: 'translateY(-50%)', pointerEvents: 'none', color: colors.textDim }}>
            <path d="M2 3.5 L5 6.5 L8 3.5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        </div>

        <div style={{ marginTop: 8, fontSize: 10, fontFamily: fonts.sans, color: colors.textDim, letterSpacing: '0.02em' }}>
          {scenarios.filter(s => !s.disabled).length} live · {scenarios.filter(s => s.disabled).length} locked
        </div>
      </div>

      {/* ── Grouped scenario list ── */}
      <div className="scenario-scroll" style={{ flex: 1, overflowY: 'auto', padding: '4px 8px 12px', display: 'flex', flexDirection: 'column' }}>
        {DATASET_GROUPS.map((group) => {
          const groupScenarios = scenarios.filter(s => group.datasets.includes(s.dataset));
          if (groupScenarios.length === 0) return null;
          const allLocked = groupScenarios.every(s => s.disabled);

          return (
            <div key={group.key}>
              <SectionHeader
                label={group.label}
                count={groupScenarios.length}
                allLocked={allLocked}
                lockTooltip={group.lockTooltip}
              />
              <div style={{ display: 'flex', flexDirection: 'column', gap: 5 }}>
                {groupScenarios.map((s) => (
                  <ScenarioCard
                    key={s.id}
                    scenario={s}
                    isHovered={hoveredId === s.id}
                    isActive={currentSegment === s.id}
                    isLoading={loadingId === s.id}
                    isExpanded={expandedId === s.id}
                    onMouseEnter={() => setHoveredId(s.id)}
                    onMouseLeave={() => setHoveredId(null)}
                    onClick={() => handleCardClick(s)}
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
    </aside>
  );
}
