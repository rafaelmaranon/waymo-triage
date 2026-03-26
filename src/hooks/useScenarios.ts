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
}

export function useScenarios(typeFilter: string): Scenario[] {
  return useMemo(() => {
    const all = scenarioIndex as Scenario[];
    if (typeFilter === 'all' || typeFilter === '') return all;
    return all.filter((s) => s.type === typeFilter);
  }, [typeFilter]);
}

/** Group key → ordered list of dataset values that belong to it */
export const DATASET_GROUPS: { key: string; label: string; datasets: string[]; lockTooltip?: string }[] = [
  { key: 'nuscenes_mini', label: 'nuScenes mini',  datasets: ['nuscenes_mini'] },
  { key: 'argoverse2',    label: 'Argoverse 2',    datasets: ['argoverse2'] },
  { key: 'waymo',         label: 'Waymo',          datasets: ['waymo_perception', 'waymo_v2'], lockTooltip: 'Provide Google Cloud credentials to unlock' },
  { key: 'nuscenes_full', label: 'nuScenes full',  datasets: ['nuscenes_full'], lockTooltip: 'Provide nuScenes credentials to unlock' },
];
