# Waymo Scenario Triage Tool

Browser-based tool for finding, previewing, and exporting interesting
autonomous driving scenarios from Waymo, nuScenes, and Argoverse 2.

Built on top of [EgoLens](https://github.com/egolens/egolens) (MIT license).

## What this does

1. User picks a scenario type (pedestrian interaction, cyclist conflict, near-miss, etc.)
2. App shows a ranked list of matching segments with thumbnails
3. User clicks a segment — EgoLens loads it with LiDAR + cameras + 3D boxes
4. User clicks "Send to Encord" to push selected frames to the labeling queue

## Project structure

```
waymo-triage/
├── src/
│   ├── components/
│   │   ├── ScenarioPanel/        ← NEW: left sidebar scenario list
│   │   │   ├── ScenarioPanel.tsx
│   │   │   ├── ScenarioCard.tsx
│   │   │   └── ScenarioFilter.tsx
│   │   └── ... (existing EgoLens components)
│   ├── data/
│   │   └── scenario_index.json   ← NEW: pre-computed scenario index
│   ├── hooks/
│   │   └── useScenarios.ts       ← NEW: scenario loading + filtering logic
│   └── ... (existing EgoLens files)
├── scanner/                      ← NEW: Python scanner (runs in Colab)
│   ├── scan_perception.py
│   └── export_encord.py
├── CURSOR_INSTRUCTIONS.md        ← Read this before coding
└── CHANGELOG_CUSTOM.md           ← Track all changes from original EgoLens
```

## Setup

```bash
npm install
npm run dev
```

Open http://localhost:5173

## Datasets

- **Waymo Perception v1.4.3** — user authenticates with own Google account
- **nuScenes** — streamed via URL, no download
- **Argoverse 2** — streamed via URL, no download

## License

MIT — same as EgoLens. Built by forking egolens/egolens.
