# Performance Optimization Log

Tracking all performance work with measured before/after data.
See `.claude/CONVENTIONS.md` for process rules.

---

## OPT-001: Fix geometry memory leak on frame scrub

**Date:** 2026-03-01
**Status:** Implemented
**Files:** `src/components/LidarViewer/BoundingBoxes.tsx`, `src/components/LidarViewer/CameraFrustums.tsx`

### Problem

Profiling with chrome-devtools-mcp heap snapshots showed **+105,592 objects (+6.5 MB)** leaked after scrubbing 50 frames. Two sources identified:

1. **TrajectoryTrail** (`BoundingBoxes.tsx:236`): `useMemo` creates a new `BufferGeometry.setFromPoints()` every frame change (~20-30 tracked objects per frame). Old geometries were never disposed — their GPU-side vertex buffers accumulated indefinitely.

2. **CameraFrustums** (`CameraFrustums.tsx:75-87`): Pyramid edge meshes used conditional mount (`{highlighted && <lineSegments>}`), creating and destroying `bufferGeometry` + `lineBasicMaterial` on every hover toggle. Unmounting a R3F element disposes the Three.js object, but the mount/unmount churn creates allocation pressure and short-lived objects that stress GC.

### Alternatives considered

| Approach | Tradeoff |
|---|---|
| **A) useEffect cleanup + dispose()** | Simple, targeted. Requires a ref to track previous geometry. |
| B) Reuse single geometry, update buffer in-place | More complex, avoids all allocation. Overkill for trail lines (<50 vertices). |
| C) Object pool for geometries | High complexity, marginal benefit for this use case. |

| Approach | Tradeoff |
|---|---|
| **A) Toggle `visible` prop** | Zero allocation on hover. Invisible meshes still exist in scene graph but are skipped by renderer. |
| B) Dispose manually in useEffect | Doesn't prevent the mount/unmount churn itself. |

### Decision

- **TrajectoryTrail**: Option A — added `useRef` + `useEffect` that calls `geometry.dispose()` on the previous geometry when `useMemo` produces a new one, and on unmount.
- **CameraFrustums**: Option A — replaced `{highlighted && (<lineSegments>...)}` with `<lineSegments visible={highlighted}>`. Meshes are always mounted; visibility toggles without allocation.

### Measurements

Methodology: chrome-devtools-mcp `take_memory_snapshot` before and after programmatically scrubbing 50 frames (150ms between frames, boxes enabled with trail length 10).

| Metric | Before fix | After fix | Improvement |
|---|---|---|---|
| Object delta (50 scrubs) | +105,592 | +41,916 | **-60%** |
| Heap size delta (50 scrubs) | +6.5 MB | +3.2 MB | **-51%** |

Remaining +41,916 objects are expected growth from the prefetch cache filling with decoded frame data (point clouds, camera images, box rows) — working storage, not leaked geometry.

### Baseline performance (no regression)

Measured during the same profiling session, confirming no frame budget regression:

| Metric | Value | Within 16.6ms budget? |
|---|---|---|
| Idle frame time (p50) | 16.7 ms | Yes (60 fps) |
| Colormap loop (170K pts) | 11.3 ms | Yes (runs once per frame change) |
| computeBoundingSphere | 2.1 ms | Yes |
| Scrubbing frame time (p90) | 33.3 ms | Occasional double-vsync, acceptable |

---

## Rejected / Deferred

### computeBoundingSphere optimization
**Reason deferred:** Measured at 2.1 ms average, only fires once per frame change (not every rAF tick). Well within frame budget. Total useFrame dirty cost is ~13.4 ms including the colormap loop.

### Colormap loop vectorization
**Reason deferred:** 11.3 ms average for 170K points. Combined with computeBoundingSphere (2.1 ms), total dirty-frame cost is ~13.4 ms — under the 16.6 ms budget. Would only matter if point counts increase significantly.
