# Erdos — Agent Guide

Interactive puzzle prototype: connect elongated **segments** on a 2D canvas to drop colored **dots** (caps). The player reorganizes segments to maximize collected dots.

## Tech stack

| Layer | Choice |
|-------|--------|
| Package manager | **pnpm** |
| Build | **Vite 5** + **TypeScript** |
| UI | **React 19** (functional components, hooks) |
| Styling | **Tailwind CSS v4** (via `@tailwindcss/vite`) |
| Graphics | **SVG** — no canvas/WebGL, no animation library |

```bash
pnpm install
pnpm dev      # dev server
pnpm build    # tsc + vite build
pnpm tsc --noEmit  # typecheck only
```

## Repository layout

```
src/
  App.tsx       # All game logic, state, layout, solver, rendering orchestration (~2000 lines)
  Segment.tsx   # Single segment SVG component + geometry helpers
  main.tsx      # React entry
  styles.css    # Tailwind imports
  vite-env.d.ts
index.html
vite.config.ts
```

**Important:** Almost all behavior lives in `App.tsx`. `Segment.tsx` is presentational plus `getSegmentHandlePoint`. Prefer extending existing helpers there rather than splitting prematurely unless the file becomes unmaintainable.

## Game goal (player-facing)

- Segments start scattered (non-overlapping random layout).
- **Connect** segments by snapping one handle onto another.
- Each new connection hides the **dragged** handle’s inner colored dot; it falls to a color-coded slot at the bottom of the canvas.
- **Objective:** rearrange the structure to collect as many fallen dots as possible.
- UI: segment count selector (3–20, default **5**), **Restart** button.

## Core entities

### Segment (`PuzzleSegment`)

- `id`: numeric `SegmentId` (0 … n−1)
- `pose`: `{ center: Point, angle: number }` — rigid body in SVG space
- `color`: unique per segment (HSL palette from `buildColorPalette`)

Rendered as: black-outlined capsule body, connector lines to **handles** (outer black ring + inner colored **cap/kernel**).

### Handle

- `"start"` | `"end"` at segment extremities.
- Key format: `"${segmentId}:${handle}"` (use `parseHandleKey` / `getHandleKey`).

### Connection & joint (node)

- A `Connection` links two handles. Multiple connections form a **joint** (star topology allowed).
- `getConnectedNodeMembers()` BFS-es the graph to get all handles in one joint.
- Connections are stored as edges; when a handle disconnects, remaining members are re-linked as a clique (`getConnectionsAfterDisconnectingHandle`).

### Cap / dot (`CapState`)

- `hiddenCapKeys`: handles whose inner kernel is hidden (connected or animating away).
- `fallenCaps`: caps on the floor or animating (fall / return / restack).
- **Ownership:** which kernel stays visible at a joint is **not** z-index — it uses `handleJoinOrderRef` (earliest joined handle wins). Z-index only affects draw order of bodies/rings.
- On connect: only the **dragged** handle’s cap falls. Target keeps its kernel.
- On disconnect without reconnect: cap returns to its handle (RAF animation).

## Interaction rules

| Action | Behavior |
|--------|----------|
| Drag **body** | Translate segment; disconnects entire segment from joints |
| Drag **handle** | Rotate around opposite handle; if opposite is connected, that pivot stays fixed |
| Snap zone | Within `metrics.snapRadius` of another handle |
| On release in snap zone | Align handles; run constraint solver; hide dragged cap(s) |

### Forbidden connections

- **No bridge overlap:** two handles of the dragged segment must not snap to the same target *node* (would fully overlap two segments).
- **No duplicate segment bridge:** opposite handle of dragged segment cannot connect into the same node as the snap target (`wouldCreateDuplicateSegmentBridge`).
- Segments already connected by an edge cannot snap again (`areSegmentsConnected`).

During **rotation**, the fixed pivot handle must not move. `normalizeConnectedGeometry` receives `fixedHandles` on rotate-release.

## Geometry & scaling

`getPuzzleMetrics(segmentCount)` derives all sizes from segment count:

- Canvas: **1200 × 720** (`CANVAS_WIDTH`, `CANVAS_HEIGHT`)
- Segment length, body width, handle radius, snap radius scale down as count increases (3 → large, 20 → small)
- `viewHandleRadius = handleRadius + 7` must match `Segment.tsx` rendering

Initial placement uses capsule overlap tests + retries; fallbacks: grid layout, then spaced horizontal rows (`createInitialSegments`).

## Constraint solver

`normalizeConnectedGeometry(segments, connections, metrics, fixedHandles?)`:

- Builds constraint **nodes** at joint positions (average of member handle points).
- Iterative PBD-style length constraints: each segment keeps `metrics.length` between its two handle nodes.
- Fixed nodes (rotation pivot) get zero weight when correcting.
- Output: updated `pose` per segment via `getPoseFromHandles`.

Run on snap release so multi-segment assemblies “jiggle” into a valid fit.

## Rendering order (SVG)

Do not collapse these passes without understanding layering bugs:

1. **Bodies** — all segments, z-order = `segments` array order (dragged segment moved to end on drag start).
2. **Handle rings** — black outer circles only (`renderHandles`, `renderCaps={false}`).
3. **Colored kernels** — after all rings (`renderCaps={true}`), visibility from `hiddenCapKeys`.
4. **Fallen caps** — floor dots.
5. **Disconnection effects** — amber pulse on disconnect.

Connector lines end at the outer ring, not the inner cap (`connectorHalfLength` in `Segment.tsx`).

## State & lifecycle

`createInitialGameState(segmentCount)` resets:

- `segments`, `connections`, `capState`, `snapCandidates`, `disconnectionEffects`, `dragState`
- `metrics`, `colorPalette`
- `handleJoinOrderRef` (must clear on restart)

Changing segment count or clicking **Restart** calls `restartGame()`.

Cap animations use `requestAnimationFrame` in a `useEffect` (not SVG `<animate>`).

## Conventions for changes

1. **Keep types strict** — `SegmentId` is `number`; handle keys use string `"id:handle"`.
2. **Pass `metrics`** into any function that uses segment length, snap radius, or collision size.
3. **Do not use segment array index for kernel ownership** — use `handleJoinOrderRef` + `hiddenCapKeys`.
4. **Rotation release:** `restoreReleasedCaps` must skip handles still connected (fixed pivot bug was fixed this way).
5. **Layout changes:** update overlap tests if visual size changes (`viewHandleRadius`, body width, border 5px in Segment).
6. **Minimal scope** — match existing patterns; avoid new dependencies unless necessary (animations are hand-rolled intentionally).
7. **No commits** unless the user asks.

## Common tasks

| Task | Where to look |
|------|----------------|
| Snap / connect rules | `findSnapCandidates`, `stopDrag`, `wouldCreateDuplicateSegmentBridge` |
| Visual handle layering | three-pass `segments.map` in JSX, `Segment` render props |
| Cap fall/return | `getCapStateWithHiddenDraggedCaps`, cap `useEffect`, `getCapSlotPosition` |
| Segment appearance | `Segment.tsx` |
| Initial layout / overlap | `segmentsOverlap`, `tryCreateRandomLayout`, `createSpacedRowLayout` |
| Puzzle difficulty / sizing | `getPuzzleMetrics`, `MIN/MAX_SEGMENT_COUNT` |

## What this is not (yet)

- No backend, persistence, levels, scoring UI, or win condition
- No unit tests in repo
- No routing — single-page app

Treat this as an **early gameplay prototype** focused on feel: snapping, connection topology, cap collection, and visual polish.
