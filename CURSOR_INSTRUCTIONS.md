# Cursor Instructions — Waymo Scenario Triage Tool

Read this before making any changes. It tells Cursor exactly what this
project is, what has been changed from EgoLens, and what to build next.

---

## What this project is

This is a fork of EgoLens (https://github.com/egolens/egolens), a
browser-based 3D viewer for autonomous driving datasets. We are adding
a scenario mining layer on top of EgoLens without breaking any of its
existing functionality.

**Core rule: never modify existing EgoLens files unless absolutely
necessary. Add new files and components instead.**

---

## Tech stack

- React 19 + TypeScript
- Three.js + React Three Fiber (3D rendering)
- Vite (build tool)
- Zustand (state management — already used by EgoLens)
- Tailwind CSS utility classes for new components

---

## What we are adding (do not touch existing EgoLens code)

### 1. Scenario Panel — left sidebar

A new panel that shows a list of scenario cards. The user picks a
scenario type from a dropdown, the list filters, they click a card,
and EgoLens loads that segment.

**Files to create:**
- `src/components/ScenarioPanel/ScenarioPanel.tsx` — main sidebar container
- `src/components/ScenarioPanel/ScenarioCard.tsx` — individual scenario card
- `src/components/ScenarioPanel/ScenarioFilter.tsx` — dropdown filter by type
- `src/hooks/useScenarios.ts` — loads scenario_index.json, filters by type

**Where to mount it:**
Find the main layout file in EgoLens (likely `src/App.tsx` or similar).
Add the ScenarioPanel as a left sidebar BEFORE the existing 3D viewer.
Use a flex layout: `<div style="display:flex"><ScenarioPanel /><ExistingViewer /></div>`

### 2. Scenario index data

A JSON file at `src/data/scenario_index.json` with this structure:

```json
[
  {
    "id": "10094743350625019937_3420_000_3440_000",
    "type": "pudo",
    "label": "PUDO candidate — SF",
    "quality_score": 8.4,
    "min_speed": 0.0,
    "max_peds_nearby": 1,
    "thumbnail": "/thumbnails/10094.jpg",
    "gcs_path": "gs://waymo_open_dataset_v_1_4_3/individual_files/training/segment-10094743350625019937_3420_000_3440_000_with_camera_labels.tfrecord",
    "dataset": "waymo_perception",
    "location": "San Francisco, CA",
    "frames": 198,
    "notes": "Ego stopped for 110 frames, 1 pedestrian nearby throughout"
  },
  {
    "id": "10023947602400723454_1120_000_1140_000",
    "type": "dense_pedestrian",
    "label": "Dense pedestrian scene — SF",
    "quality_score": 7.1,
    "min_speed": 0.0,
    "max_peds_nearby": 15,
    "thumbnail": "/thumbnails/10023.jpg",
    "gcs_path": "gs://waymo_open_dataset_v_1_4_3/individual_files/training/segment-10023947602400723454_1120_000_1140_000_with_camera_labels.tfrecord",
    "dataset": "waymo_perception",
    "location": "San Francisco, CA",
    "frames": 198,
    "notes": "Busy intersection, 35+ pedestrians, gradual stop"
  }
]
```

### 3. Scenario types

The filter dropdown should include these types:

```
all                  — show everything
pudo                 — pickup / dropoff
dense_pedestrian     — many pedestrians nearby
cyclist_interaction  — cyclist + pedestrian proximity
near_miss            — fast deceleration event
mid_block_crossing   — pedestrian crossing outside crosswalk
```

### 4. ScenarioCard design

Each card should show:
- Thumbnail image (left, 120x80px)
- Scenario type badge (colored pill)
- Segment ID (small, muted)
- Location
- Quality score (right-aligned)
- Notes (one line, truncated)

On click: load the segment into EgoLens. Look at how EgoLens currently
loads a segment from a file drop or URL — replicate that trigger
programmatically when the card is clicked.

### 5. Send to Encord button

Add a button at the bottom of the ScenarioPanel. When clicked:
- Show a simple modal asking for Encord API key + project ID
- Call Encord SDK to push the current segment's frames
- Show success/error toast

This is Phase 6 — do not build this yet. Leave a placeholder button
that logs "Encord export coming soon" to the console.

---

## What NOT to change

- Any file in `src/` that existed in the original EgoLens repo
- The Three.js rendering pipeline
- The LiDAR point cloud renderer
- The camera sync timeline
- The drag-and-drop file loader
- `package.json` dependencies (add new ones only, never remove)

---

## How to find where to mount the ScenarioPanel

Run this in the terminal to find the main layout:

```bash
grep -r "return" src/App.tsx
grep -r "className" src/App.tsx | head -20
```

Look for the outermost div in the render tree. That is where to add
the flex wrapper and mount ScenarioPanel.

---

## Coding style

- TypeScript strict mode — all props must be typed
- Functional components only — no class components
- Use Zustand for any state that needs to be shared between
  ScenarioPanel and the EgoLens viewer
- CSS: use inline styles or Tailwind classes — no new CSS files

---

## First task for Cursor

**Start here. Do this first, nothing else.**

Create `src/data/scenario_index.json` with the two example scenarios
above. Then create `src/hooks/useScenarios.ts` that imports it and
returns a filtered list based on a type string. Then create a minimal
`src/components/ScenarioPanel/ScenarioPanel.tsx` that renders the list
as plain text (no styling yet) just to confirm it mounts correctly.

Do not touch any existing EgoLens file at this stage.
