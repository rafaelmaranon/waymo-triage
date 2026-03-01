# R3F Render Synchronization: useFrame vs useEffect

## Problem

In world coordinate mode, scrubbing to a new frame caused a visible "double render" jitter — the scene appeared to lurch/stutter instead of moving smoothly. The effect was a single-frame spatial pop where the point cloud jumped to the wrong position and snapped back.

## Root Cause

The scene group's world-pose matrix was updated via `useEffect`, while the point cloud buffer was updated via `useFrame`. These run in **different phases** of the render cycle:

- `useEffect` fires **after** React commits (after paint)
- `useFrame` fires **during** the next Three.js render loop (`requestAnimationFrame`)

This timing gap meant the group matrix and point buffer could be out of sync for one rendered frame.

### Desync Timeline

```
Zustand set()          React re-render         useEffect (after paint)    useFrame (next rAF)
─────────────────      ─────────────────       ──────────────────────     ──────────────────
currentFrame = N+1     BoundingBoxes re-render  sceneGroup.matrix =       PointCloud buffer =
currentFrameIndex++    with boxes_N+1           pose_N+1                  cloud_N+1
                       (immediate JSX)          (too late for this paint) (finally in sync)
```

### The Jittery Frame

```
Frame N (correct)       Intermediate (jitter!)        Frame N+1 (correct)
─────────────────       ──────────────────────        ─────────────────
Points:  cloud_N        Points:  cloud_N    (stale)   Points:  cloud_N+1
Pose:    pose_N         Pose:    pose_N     (stale)   Pose:    pose_N+1
Boxes:   boxes_N        Boxes:   boxes_N+1  (new!)    Boxes:   boxes_N+1
                        ↑ boxes jumped, rest lagged
```

For one paint cycle, BoundingBoxes (React JSX, synchronous) showed new positions while the group matrix and point buffer still held old data. This manifested as boxes snapping ahead of the cloud.

### Why Invisible in Vehicle Mode

In vehicle mode, the scene group matrix is always identity. Since `identity == identity` regardless of frame, the one-frame lag has no visual effect — there's no spatial offset to notice.

In world mode, consecutive frames have different poses (the vehicle moves through the world), so the desync produces a visible spatial discontinuity.

## Fix

Replaced the `useEffect` in `LidarViewer.tsx` with a `WorldPoseSync` component that reads pose state from the Zustand store inside `useFrame`:

```tsx
function WorldPoseSync({ groupRef }) {
  useFrame(() => {
    const { worldMode, currentFrame } = useSceneStore.getState()
    const pose = currentFrame?.vehiclePose ?? null
    if (worldMode && pose) {
      _poseMatrix.fromArray(pose).transpose()
      group.matrix.copy(_poseMatrix)
    } else {
      group.matrix.identity()
    }
    group.matrixWorldNeedsUpdate = true
  })
  return null
}
```

This ensures the group matrix updates in the **same rAF tick** as PointCloud's buffer write — both happen inside Three.js's render loop, before the frame is painted.

### Why `useSceneStore.getState()` Instead of a Selector

Using `getState()` inside `useFrame` reads the latest store state synchronously without triggering React re-renders. This avoids:
1. An extra React render cycle from the selector
2. The timing gap between React's commit phase and Three.js's render loop

## Verification

- World mode scrub (10 ArrowRight keydowns): smooth movement, no lurch
- INP: 58ms (processing: 0.1ms) — all heavy work in useFrame, outside INP measurement
- Vehicle mode: no regression, behavior unchanged
- Build: clean (`npm run build` + `npm test` pass)

## General Lesson

**When updating Three.js objects that must be visually synchronized, always use `useFrame` — never `useEffect`.**

| Hook | When it runs | Use for |
|------|-------------|---------|
| `useEffect` | After React commit (after paint) | DOM side effects, subscriptions, cleanup |
| `useFrame` | During Three.js render loop (before paint) | Object transforms, buffer writes, animations |

If component A updates a buffer in `useFrame` and component B updates a transform in `useEffect`, they will be one frame apart. Move both into `useFrame` to guarantee they execute in the same render pass.

### Pattern: Reading Zustand in useFrame Without Re-renders

```tsx
// BAD: selector causes React re-render, useEffect fires after paint
const pose = useSceneStore((s) => s.currentFrame?.vehiclePose)
useEffect(() => { applyPose(pose) }, [pose])

// GOOD: read imperatively in useFrame, same render tick as other useFrame work
useFrame(() => {
  const pose = useSceneStore.getState().currentFrame?.vehiclePose
  applyPose(pose)
})
```

This pattern is ideal for any Three.js state that must stay in sync with other per-frame updates.
