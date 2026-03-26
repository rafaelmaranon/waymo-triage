# Changelog — custom changes from EgoLens

This file tracks every change made on top of the original EgoLens codebase.
Update this every time you add or modify something.

Format:
## [date] — [what changed]
- Files added: ...
- Files modified: ...
- Why: ...

---

## [2026-03-25] — Project setup

- Files added: `README_PROJECT.md`, `CURSOR_INSTRUCTIONS.md`, `CHANGELOG_CUSTOM.md`
- Files modified: none
- Why: Initial project setup. Forked from egolens/egolens. No EgoLens files touched yet.

---

## Next up

- [ ] Create `src/data/scenario_index.json` — hardcoded 2 scenarios
- [ ] Create `src/hooks/useScenarios.ts` — load + filter scenarios
- [ ] Create `src/components/ScenarioPanel/ScenarioPanel.tsx` — sidebar
- [ ] Create `src/components/ScenarioPanel/ScenarioCard.tsx` — card component
- [ ] Create `src/components/ScenarioPanel/ScenarioFilter.tsx` — type filter
- [ ] Mount ScenarioPanel in main App layout
- [ ] Run full 798-file scanner → replace hardcoded data with real index
- [ ] Add nuScenes URL streaming support
- [ ] Add Send to Encord button
