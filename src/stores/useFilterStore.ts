/**
 * Lightweight shared filter state for ScenarioPanel ↔ landing page communication.
 * ScenarioPanel reads these; landing page cards write to them.
 */
import { create } from 'zustand'

interface FilterState {
  typeFilter: string
  searchQuery: string
  sentOnly: boolean
  setTypeFilter: (v: string) => void
  setSearchQuery: (v: string) => void
  setSentOnly: (v: boolean) => void
}

export const useFilterStore = create<FilterState>((set) => ({
  typeFilter: 'all',
  searchQuery: '',
  sentOnly: false,
  setTypeFilter: (v) => set({ typeFilter: v }),
  setSearchQuery: (v) => set({ searchQuery: v }),
  setSentOnly: (v) => set({ sentOnly: v }),
}))
