import { useMemo } from 'react';
import scenarioIndex from '../data/scenario_index.json';

export interface Scenario {
  id: string;
  type: string;
  label: string;
  quality_score: number;
  min_speed: number;
  max_peds_nearby: number;
  thumbnail: string;
  base_url: string;
  gcs_path?: string;
  dataset: string;
  location: string;
  frames: number;
  notes: string;
  disabled?: boolean;
  // AV2 scanner fields
  n_pedestrians?: number;
  n_cyclists?: number;
  has_fast_decel?: boolean;
  img_url?: string | null;
}

function parseSearch(raw: string): { text: string; minScore: number | null; maxScore: number | null } {
  let text = raw;
  let minScore: number | null = null;
  let maxScore: number | null = null;

  const geMatch = text.match(/>=\s*(\d+(?:\.\d+)?)/);
  if (geMatch) { minScore = parseFloat(geMatch[1]); text = text.replace(geMatch[0], ''); }
  else {
    const gtMatch = text.match(/>\s*(\d+(?:\.\d+)?)/);
    if (gtMatch) { minScore = parseFloat(gtMatch[1]); text = text.replace(gtMatch[0], ''); }
  }
  const plusMatch = minScore === null && text.match(/(\d+(?:\.\d+)?)\+/);
  if (plusMatch) { minScore = parseFloat(plusMatch[1]); text = text.replace(plusMatch[0], ''); }

  const leMatch = text.match(/<=\s*(\d+(?:\.\d+)?)/);
  if (leMatch) { maxScore = parseFloat(leMatch[1]); text = text.replace(leMatch[0], ''); }
  else {
    const ltMatch = text.match(/<\s*(\d+(?:\.\d+)?)/);
    if (ltMatch) { maxScore = parseFloat(ltMatch[1]); text = text.replace(ltMatch[0], ''); }
  }

  return { text: text.trim().toLowerCase(), minScore, maxScore };
}

export function useScenarios(typeFilter: string, searchQuery?: string): Scenario[] {
  return useMemo(() => {
    let all = scenarioIndex as Scenario[];

    if (typeFilter && typeFilter !== 'all') {
      all = all.filter(s => s.type === typeFilter);
    }

    const raw = (searchQuery ?? '').trim();
    if (!raw) return all;

    const { text, minScore, maxScore } = parseSearch(raw);

    return all.filter(s => {
      const normScore = Math.min(s.quality_score, 10);
      if (minScore !== null && normScore < minScore) return false;
      if (maxScore !== null && normScore > maxScore) return false;
      if (text) {
        const hay = `${s.label} ${s.location} ${s.type.replace(/_/g, ' ')} ${s.dataset}`.toLowerCase();
        return text.split(/\s+/).filter(Boolean).every(w => hay.includes(w));
      }
      return true;
    });
  }, [typeFilter, searchQuery]);
}

/** Group key → ordered list of dataset values that belong to it */
export const DATASET_GROUPS: { key: string; label: string; datasets: string[]; lockTooltip?: string }[] = [
  { key: 'nuscenes_mini', label: 'nuScenes mini',  datasets: ['nuscenes_mini'] },
  { key: 'argoverse2',    label: 'Argoverse 2',    datasets: ['argoverse2'] },
  { key: 'waymo',         label: 'Waymo',          datasets: ['waymo_perception', 'waymo_v2'], lockTooltip: 'Provide Google Cloud credentials to unlock' },
];
