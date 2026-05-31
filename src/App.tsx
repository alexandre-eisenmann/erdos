import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { getSegmentHandlePoint, Segment, type Point, type SegmentPose } from "./Segment";
import {
  createBody,
  grabOffsetFor,
  PHYSICS,
  poseFromBody,
  settleConnectedSegments,
  stepPhysics,
  type PhysicsRuntime,
} from "./dragPhysics";

type DragMode = "classic" | "physics";

const DISCONNECT_ANIMATION_MS = 700;
const CAP_FALL_DURATION_MS = 520;
const CAP_RETURN_DURATION_MS = 480;
const CAP_RESTACK_SPEED = 0.2;
const CANVAS_WIDTH = 1200;
const CANVAS_MIN_HEIGHT = 1200;
const PILE_COUNTER_FONT_PX = 56;
// Reference chrome height used only for sizing the canonical rod-length band.
const REFERENCE_CHROME_TOP_PX = 360;
// Every puzzle uses the rod length that fits this many pieces in the reference band.
const PUZZLE_REFERENCE_SEGMENT_COUNT = 5;

type CanvasSize = {
  width: number;
  height: number;
};

function getSvgUniformScale(canvas: CanvasSize, chrome: LayoutChrome) {
  const scaleX = chrome.containerWidthPx / canvas.width;
  const scaleY = chrome.containerHeightPx / canvas.height;
  return Math.max(Math.min(scaleX, scaleY), 0.0001);
}

function getCanvasSize(containerWidth: number, containerHeight: number): CanvasSize {
  const width = CANVAS_WIDTH;
  const height = Math.round(width * (containerHeight / Math.max(containerWidth, 1)));

  return { width, height };
}

function getDefaultCanvasSize(): CanvasSize {
  if (typeof window === "undefined") {
    return { width: CANVAS_WIDTH, height: CANVAS_MIN_HEIGHT };
  }

  return getCanvasSize(window.innerWidth, window.innerHeight);
}

function getDefaultLayoutChrome(): LayoutChrome {
  if (typeof window === "undefined") {
    return {
      topPx: 0,
      containerHeightPx: CANVAS_MIN_HEIGHT,
      containerWidthPx: CANVAS_WIDTH,
    };
  }

  const containerWidthPx = window.innerWidth;
  const containerHeightPx = window.innerHeight;

  return {
    topPx: 0,
    containerHeightPx,
    containerWidthPx,
  };
}
const MIN_SEGMENT_COUNT = 3;
const MAX_SEGMENT_COUNT = 35;
const DEFAULT_SEGMENT_COUNT = 5;
const SEGMENT_COUNT_OPTIONS = Array.from(
  { length: MAX_SEGMENT_COUNT - MIN_SEGMENT_COUNT + 1 },
  (_, index) => MIN_SEGMENT_COUNT + index,
);

// U_TABLE[n] = u(n) = the number of segments for index n.
const U_TABLE = [0, 0, 1, 3, 5, 7, 9, 12, 14, 18, 20, 23, 27, 30, 33, 37, 41, 43, 46, 50, 54, 57];

// The piece count IS u(n), so invert the table to recover n: take the largest
// index whose u(n) does not exceed the piece count (missing counts fall back to
// the previous table value, i.e. u(n) = u(n-1)). Max dots = 2·u(n) − n.
function getMaxDots(segmentCount: number): number {
  let n = 0;
  for (let i = 0; i < U_TABLE.length; i += 1) {
    if (U_TABLE[i] <= segmentCount) {
      n = i;
    }
  }
  return Math.max(0, 2 * U_TABLE[n] - n);
}

type SegmentId = number;
type HandleId = "start" | "end";

type PuzzleSegment = {
  id: SegmentId;
  pose: SegmentPose;
  color: string;
};

type PuzzleMetrics = {
  canvasWidth: number;
  canvasHeight: number;
  length: number;
  bodyWidth: number;
  handleRadius: number;
  viewHandleRadius: number;
  snapRadius: number;
  capStackStep: number;
  pileCenterX: number;
  pileBaseY: number;
  pileCounterY: number;
  pileCounterFontSize: number;
  pileDotRadius: number;
  collisionRadius: number;
  minSegmentSeparation: number;
  layoutGridSeparation: number;
  layoutPlayTopY: number;
  layoutPlayHeight: number;
  layoutMinY: number;
  layoutMaxY: number;
  layoutMargin: number;
  layoutCols: number;
};

type LayoutChrome = {
  topPx: number;
  containerHeightPx: number;
  containerWidthPx: number;
};

type SegmentHandle = {
  segmentId: SegmentId;
  handle: HandleId;
};

type Connection = {
  from: SegmentHandle;
  to: SegmentHandle;
};

type SnapCandidate = {
  dragged: {
    segmentId: SegmentId;
    handle: HandleId;
    point: Point;
  };
  target: {
    segmentId: SegmentId;
    handle: HandleId;
    point: Point;
  };
};

type ConstraintNode = {
  key: string;
  point: Point;
  fixed: boolean;
};

type DisconnectionEffect = {
  id: number;
  point: Point;
};

type FallenCap = {
  key: string;
  color: string;
  from: Point;
  to: Point;
  current: Point;
  status: "falling" | "fallen" | "returning";
  startedAt: number;
  returnFrom?: Point;
  returnTo?: Point;
};

type CapState = {
  hiddenCapKeys: string[];
  fallenCaps: FallenCap[];
};

type DragState =
  | {
      type: "translate";
      segmentId: SegmentId;
      snapConnections: Connection[];
      pointerStart: Point;
      poseStart: SegmentPose;
    }
  | {
      type: "rotate";
      segmentId: SegmentId;
      snapConnections: Connection[];
      fixedPoint: Point;
      draggedHandle: HandleId;
      connectedPivotPoint?: Point;
    }
  | {
      type: "physics";
      segmentId: SegmentId;
    };

function lerp(start: number, end: number, progress: number) {
  return start + (end - start) * progress;
}

function getReferenceLayoutBand(
  layoutMargin: number,
  viewHandleRadius: number,
  pileDotRadius: number,
) {
  const referenceLayoutMinY =
    Math.round((REFERENCE_CHROME_TOP_PX / CANVAS_MIN_HEIGHT) * CANVAS_MIN_HEIGHT) +
    Math.round(layoutMargin * 0.35);
  const refBottomInset = Math.max(28, Math.round(CANVAS_MIN_HEIGHT * 0.035));
  const layoutBottomClearance = viewHandleRadius + pileDotRadius;
  const referenceLayoutMaxY =
    CANVAS_MIN_HEIGHT - refBottomInset - layoutBottomClearance - pileDotRadius;
  return {
    playWidth: CANVAS_WIDTH - layoutMargin * 2,
    playHeight: referenceLayoutMaxY - referenceLayoutMinY,
    referenceLayoutMinY,
    referenceLayoutMaxY,
  };
}

function maxRodLengthForCols(
  segmentCount: number,
  cols: number,
  playWidth: number,
  playHeight: number,
  viewHandleRadius: number,
  separation: number,
  maxLength: number,
) {
  const rows = Math.ceil(segmentCount / cols);
  const boxByWidth = (playWidth - (cols - 1) * separation) / cols;
  const boxByHeight = (playHeight - (rows - 1) * separation) / rows;
  const box = Math.min(boxByWidth, boxByHeight);
  const length = Math.SQRT2 * (box - 2 * viewHandleRadius);
  return Math.min(maxLength, Math.max(0, length));
}

function gridFitsFixedLength(
  segmentCount: number,
  cols: number,
  length: number,
  playWidth: number,
  playHeight: number,
  viewHandleRadius: number,
  separation: number,
) {
  const boxSide = length / Math.SQRT2 + viewHandleRadius * 2;
  const pitch = boxSide + separation;
  const rows = Math.ceil(segmentCount / cols);
  const gridWidth = (cols - 1) * pitch + boxSide;
  const gridHeight = (rows - 1) * pitch + boxSide;
  return gridWidth <= playWidth + 0.5 && gridHeight <= playHeight + 0.5;
}

// Rod length is always the n=5 reference. Column count uses the fewest columns
// (most rows) that fit that length; if none fit, keep the reference length and
// use the fewest columns among layouts closest to it.
function chooseInitialLayout(
  segmentCount: number,
  playWidth: number,
  playHeight: number,
  viewHandleRadius: number,
  separation: number,
  referenceRodLength: number,
  maxLength: number,
) {
  if (
    segmentCount === PUZZLE_REFERENCE_SEGMENT_COUNT &&
    gridFitsFixedLength(
      segmentCount,
      segmentCount,
      referenceRodLength,
      playWidth,
      playHeight,
      viewHandleRadius,
      separation,
    )
  ) {
    return { length: referenceRodLength, cols: segmentCount };
  }

  for (let cols = 1; cols <= segmentCount; cols += 1) {
    if (
      gridFitsFixedLength(
        segmentCount,
        cols,
        referenceRodLength,
        playWidth,
        playHeight,
        viewHandleRadius,
        separation,
      )
    ) {
      return { length: referenceRodLength, cols };
    }
  }

  let best = { length: 0, cols: segmentCount };
  for (let cols = 1; cols <= segmentCount; cols += 1) {
    const maxForCols = maxRodLengthForCols(
      segmentCount,
      cols,
      playWidth,
      playHeight,
      viewHandleRadius,
      separation,
      maxLength,
    );
    const length = Math.min(referenceRodLength, maxForCols);
    const clearlyLonger = length > best.length + 0.5;
    const tiePreferFewerCols =
      best.length > 0 && length >= best.length - 0.5 && cols < best.cols;
    if (clearlyLonger || tiePreferFewerCols || best.length === 0) {
      best = { length, cols };
    }
  }

  return best;
}

function getReferenceRodLength(
  layoutMargin: number,
  viewHandleRadius: number,
  pileDotRadius: number,
  separation: number,
  maxLength: number,
) {
  const band = getReferenceLayoutBand(layoutMargin, viewHandleRadius, pileDotRadius);
  // The canonical rod size: one row of five pieces (the default puzzle).
  const singleRowLength = maxRodLengthForCols(
    PUZZLE_REFERENCE_SEGMENT_COUNT,
    PUZZLE_REFERENCE_SEGMENT_COUNT,
    band.playWidth,
    band.playHeight,
    viewHandleRadius,
    separation,
    maxLength,
  );
  if (singleRowLength > 0) {
    return singleRowLength;
  }

  let bestLength = 0;
  for (let cols = 1; cols <= PUZZLE_REFERENCE_SEGMENT_COUNT; cols += 1) {
    const length = maxRodLengthForCols(
      PUZZLE_REFERENCE_SEGMENT_COUNT,
      cols,
      band.playWidth,
      band.playHeight,
      viewHandleRadius,
      separation,
      maxLength,
    );
    if (length > bestLength) {
      bestLength = length;
    }
  }

  return bestLength;
}

function getPuzzleMetrics(
  segmentCount: number,
  canvas: CanvasSize,
  chrome: LayoutChrome = {
    topPx: 0,
    containerHeightPx: canvas.height,
    containerWidthPx: canvas.width,
  },
): PuzzleMetrics {
  const t =
    (segmentCount - MIN_SEGMENT_COUNT) / (MAX_SEGMENT_COUNT - MIN_SEGMENT_COUNT);
  const bodyWidth = Math.round(lerp(28, 14, t));
  const handleRadius = Math.round(lerp(10, 7, t));
  const viewHandleRadius = handleRadius + 7;
  const snapRadiusBase = Math.round(lerp(54, 32, t));
  const capStackStep = handleRadius * 2 + 6;
  const layoutMargin = Math.round(lerp(48, 32, t));
  // A pile dot is the size of the whole handle circle (the outer ring); the
  // colorful kernel is what drops into it.
  const pileDotRadius = viewHandleRadius;
  const svgScale = getSvgUniformScale(canvas, chrome);
  const pileCounterFontSize = PILE_COUNTER_FONT_PX / svgScale;
  const bottomInset = Math.max(48, Math.round(canvas.height * 0.06));
  const pileToCounterGap = Math.max(14, Math.round(pileDotRadius * 1.5));
  const pileCounterY = canvas.height - bottomInset - pileCounterFontSize * 0.32;
  const pileBaseY =
    pileCounterY - pileCounterFontSize * 0.48 - pileToCounterGap - pileDotRadius;
  // Keep the initial grid just above the pile row; fallen caps stack upward from
  // pileBaseY during play. (A multi-row cap-stack reserve left the play area too
  // short, which forced wide 9×2 grids and short segments at higher counts.)
  const layoutBottomClearance = viewHandleRadius + pileDotRadius;
  const layoutMinY = Math.round(layoutMargin * 0.35);
  const layoutMaxY =
    canvas.height - bottomInset - layoutBottomClearance - pileDotRadius;
  const minSegmentSeparation = Math.round(lerp(28, 8, t));
  const bodyHalfWidth = (bodyWidth + 6) / 2;
  const collisionRadius = Math.max(bodyHalfWidth, viewHandleRadius) + 8;
  // Segment length & column count are sized against a FIXED reference play area
  // (the design canvas), not the live one. That keeps them a pure function of
  // piece count, so resizing the window only rescales the SVG viewBox — it never
  // reflows the puzzle, which would otherwise resize every rod and tear joints
  // apart (their poses were built for the previous length). Canvas width is
  // already fixed (CANVAS_WIDTH); only the height needed pinning.
  const tRef =
    (PUZZLE_REFERENCE_SEGMENT_COUNT - MIN_SEGMENT_COUNT) /
    (MAX_SEGMENT_COUNT - MIN_SEGMENT_COUNT);
  const refHandleRadius = Math.round(lerp(10, 7, tRef));
  const refViewHandleRadius = refHandleRadius + 7;
  const refLayoutMargin = Math.round(lerp(48, 32, tRef));
  const refLayoutGridSeparation = Math.round(lerp(12, 4, tRef));
  const referenceBand = getReferenceLayoutBand(
    refLayoutMargin,
    refViewHandleRadius,
    refViewHandleRadius,
  );
  const referenceRodLength = getReferenceRodLength(
    refLayoutMargin,
    refViewHandleRadius,
    refViewHandleRadius,
    refLayoutGridSeparation,
    360,
  );
  const layout = chooseInitialLayout(
    segmentCount,
    referenceBand.playWidth,
    referenceBand.playHeight,
    refViewHandleRadius,
    refLayoutGridSeparation,
    referenceRodLength,
    360,
  );
  const length = layout.length;
  const layoutPlayTopY = layoutMinY + Math.round(viewHandleRadius * 0.5);
  const layoutPlayHeight = layoutMaxY - layoutPlayTopY;
  // Segments shrink to fit large counts, so keep the snap radius from dwarfing a
  // short segment (which would make every release snap and feel uncontrollable).
  const snapRadius = Math.min(snapRadiusBase, Math.round(length * 0.6));

  return {
    canvasWidth: canvas.width,
    canvasHeight: canvas.height,
    length,
    bodyWidth,
    handleRadius,
    viewHandleRadius,
    snapRadius,
    capStackStep,
    pileCenterX: canvas.width / 2,
    pileBaseY,
    pileCounterY,
    pileCounterFontSize,
    pileDotRadius,
    collisionRadius,
    minSegmentSeparation,
    layoutGridSeparation: refLayoutGridSeparation,
    layoutPlayTopY,
    layoutPlayHeight,
    layoutMinY,
    layoutMaxY,
    layoutMargin,
    layoutCols: layout.cols,
  };
}

function buildColorPalette(segmentCount: number) {
  return Array.from({ length: segmentCount }, (_, index) => {
    const hue = Math.round((index * 360) / segmentCount);
    return `hsl(${hue} 62% 46%)`;
  });
}

function createInitialGameState(
  segmentCount: number,
  canvas: CanvasSize,
  chrome?: LayoutChrome,
) {
  const metrics = getPuzzleMetrics(segmentCount, canvas, chrome);
  const colorPalette = buildColorPalette(segmentCount);

  return {
    metrics,
    colorPalette,
    segments: createInitialSegments(segmentCount, colorPalette, metrics),
    connections: [] as Connection[],
    snapCandidates: [] as SnapCandidate[],
    capState: { hiddenCapKeys: [], fallenCaps: [] } as CapState,
    disconnectionEffects: [] as DisconnectionEffect[],
    dragState: null as DragState | null,
  };
}

// One fixed, deterministic layout for every puzzle: every segment is oriented
// at 45° on a centred grid (the "//////" tiling). It is instant to compute,
// identical each time, and overlap-free by construction — each cell's bounding
// box is sized so neighbours never touch, so no collision testing is needed.
function createInitialSegments(
  segmentCount: number,
  colorPalette: string[],
  metrics: PuzzleMetrics,
): PuzzleSegment[] {
  const cols = Math.max(1, metrics.layoutCols);
  const rows = Math.ceil(segmentCount / cols);
  const boxSide = metrics.length / Math.SQRT2 + metrics.viewHandleRadius * 2;
  const pitch = boxSide + metrics.layoutGridSeparation;
  const gridHeight = (rows - 1) * pitch + boxSide;
  const playWidth = metrics.canvasWidth - metrics.layoutMargin * 2;
  const playHeight = metrics.layoutPlayHeight;
  const startY = metrics.layoutPlayTopY + (playHeight - gridHeight) / 2 + boxSide / 2;
  const placed: PuzzleSegment[] = [];

  for (let id = 0; id < segmentCount; id += 1) {
    const row = Math.floor(id / cols);
    const col = id % cols;
    const colsInRow = Math.min(cols, segmentCount - row * cols);
    const rowWidth = (colsInRow - 1) * pitch + boxSide;
    const rowStartX = metrics.layoutMargin + (playWidth - rowWidth) / 2 + boxSide / 2;

    placed.push({
      id,
      color: colorPalette[id],
      pose: {
        center: { x: rowStartX + col * pitch, y: startY + row * pitch },
        // 45° up-right slash, matching the "//////" tiling.
        angle: -Math.PI / 4,
      },
    });
  }

  return placed;
}

function getSvgPoint(svg: SVGSVGElement, clientX: number, clientY: number): Point {
  const point = svg.createSVGPoint();
  point.x = clientX;
  point.y = clientY;

  const screenCtm = svg.getScreenCTM();
  if (!screenCtm) {
    return { x: clientX, y: clientY };
  }

  return point.matrixTransform(screenCtm.inverse());
}

function getPoseFromFixedHandle(
  fixedPoint: Point,
  pointer: Point,
  draggedHandle: HandleId,
  segmentLength: number,
): SegmentPose {
  const vector =
    draggedHandle === "end"
      ? { x: pointer.x - fixedPoint.x, y: pointer.y - fixedPoint.y }
      : { x: fixedPoint.x - pointer.x, y: fixedPoint.y - pointer.y };
  const angle = Math.atan2(vector.y, vector.x);
  const direction = draggedHandle === "end" ? 1 : -1;

  return {
    angle,
    center: {
      x: fixedPoint.x + Math.cos(angle) * (segmentLength / 2) * direction,
      y: fixedPoint.y + Math.sin(angle) * (segmentLength / 2) * direction,
    },
  };
}

function getDistance(a: Point, b: Point) {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

function easeOutCubic(progress: number) {
  return 1 - (1 - progress) ** 3;
}

// Bottom-up row sizes for a centered triangular heap of `total` dots. The base
// row is as wide as needed to keep the pile roughly equilateral; rows above it
// each hold one fewer dot, and the topmost row may be partial.
function getPileRowSizes(total: number): number[] {
  if (total <= 0) {
    return [];
  }

  const baseCount = Math.ceil((-1 + Math.sqrt(1 + 8 * total)) / 2);
  const rows: number[] = [];
  let remaining = total;
  let rowSize = baseCount;
  while (remaining > 0) {
    const take = Math.min(rowSize, remaining);
    rows.push(take);
    remaining -= take;
    rowSize = Math.max(1, rowSize - 1);
  }
  return rows;
}

// Position of the dot at `index` (0 = first to land, sits at bottom-left of the
// base) within a pile of `total` dots. The whole pile re-packs whenever `total`
// changes, so removing a dot from the middle pulls the rest in to fill the gap.
function getPilePosition(index: number, total: number, metrics: PuzzleMetrics): Point {
  const rows = getPileRowSizes(total);
  const step = metrics.pileDotRadius * 2 + 6;
  const rowHeight = step * 0.88;

  let remainder = Math.max(0, index);
  let rowIndex = 0;
  while (rowIndex < rows.length - 1 && remainder >= rows[rowIndex]) {
    remainder -= rows[rowIndex];
    rowIndex += 1;
  }

  const rowSize = rows[rowIndex] ?? 1;
  return {
    x: metrics.pileCenterX + (remainder - (rowSize - 1) / 2) * step,
    y: metrics.pileBaseY - rowIndex * rowHeight,
  };
}

function getOrderedPileCaps(fallenCaps: FallenCap[]) {
  return fallenCaps
    .filter((cap) => cap.status !== "returning")
    .sort((first, second) => first.startedAt - second.startedAt);
}

function getCapPileSlot(cap: FallenCap, fallenCaps: FallenCap[], metrics: PuzzleMetrics): Point {
  const ordered = getOrderedPileCaps(fallenCaps);
  const index = ordered.findIndex((other) => other.key === cap.key);
  return getPilePosition(index < 0 ? ordered.length : index, ordered.length, metrics);
}

function isCapAtSlot(cap: FallenCap, fallenCaps: FallenCap[], metrics: PuzzleMetrics) {
  if (cap.status !== "fallen") {
    return false;
  }

  const target = getCapPileSlot(cap, fallenCaps, metrics);
  return getDistance(cap.current, target) < 0.5;
}

function animateToward(from: Point, to: Point, progress: number): Point {
  const eased = easeOutCubic(progress);
  return {
    x: lerp(from.x, to.x, eased),
    y: lerp(from.y, to.y, eased),
  };
}

function getSegmentById(segments: PuzzleSegment[], segmentId: SegmentId) {
  return segments.find((segment) => segment.id === segmentId);
}

function getSegmentColor(segments: PuzzleSegment[], segmentId: SegmentId) {
  return getSegmentById(segments, segmentId)?.color ?? "#00a80f";
}

function getOppositeHandle(handle: HandleId): HandleId {
  return handle === "start" ? "end" : "start";
}

function getHandleKey(segmentId: SegmentId, handle: HandleId) {
  return `${segmentId}:${handle}`;
}

function parseHandleKey(key: string): SegmentHandle {
  const separatorIndex = key.lastIndexOf(":");
  return {
    segmentId: Number(key.slice(0, separatorIndex)),
    handle: key.slice(separatorIndex + 1) as HandleId,
  };
}

function getHandleNodeKey(
  nodeKeyByHandleKey: Map<string, string>,
  segmentId: SegmentId,
  handle: HandleId,
) {
  return nodeKeyByHandleKey.get(getHandleKey(segmentId, handle));
}

function areSameHandle(first: SegmentHandle, second: SegmentHandle) {
  return first.segmentId === second.segmentId && first.handle === second.handle;
}

function areHandlesAlreadyJoined(
  connections: Connection[],
  dragged: SegmentHandle,
  target: SegmentHandle,
) {
  return getConnectedNodeMembers(connections, dragged.segmentId, dragged.handle).some(
    (member) => member.segmentId === target.segmentId && member.handle === target.handle,
  );
}

function getConnectionKey(connection: Connection) {
  return [connection.from, connection.to]
    .map((handle) => getHandleKey(handle.segmentId, handle.handle))
    .sort()
    .join("--");
}

function isConnectionHandle(
  connection: Connection,
  segmentId: SegmentId,
  handle: HandleId,
) {
  return (
    (connection.from.segmentId === segmentId && connection.from.handle === handle) ||
    (connection.to.segmentId === segmentId && connection.to.handle === handle)
  );
}

function getConnectedNodeMembers(
  connections: Connection[],
  segmentId: SegmentId,
  handle: HandleId,
): SegmentHandle[] {
  const root: SegmentHandle = { segmentId, handle };
  const members = new Map<string, SegmentHandle>([
    [getHandleKey(segmentId, handle), root],
  ]);
  const queue = [root];

  while (queue.length > 0) {
    const currentHandle = queue.shift()!;

    for (const connection of connections) {
      let nextHandle: SegmentHandle | null = null;

      if (areSameHandle(connection.from, currentHandle)) {
        nextHandle = connection.to;
      } else if (areSameHandle(connection.to, currentHandle)) {
        nextHandle = connection.from;
      }

      if (!nextHandle) {
        continue;
      }

      const nextKey = getHandleKey(nextHandle.segmentId, nextHandle.handle);
      if (!members.has(nextKey)) {
        members.set(nextKey, nextHandle);
        queue.push(nextHandle);
      }
    }
  }

  return [...members.values()];
}

function isHandleConnected(
  connections: Connection[],
  segmentId: SegmentId,
  handle: HandleId,
) {
  return connections.some((connection) =>
    isConnectionHandle(connection, segmentId, handle),
  );
}

function getConnectedNodeSegmentIds(
  connections: Connection[],
  segmentId: SegmentId,
  handle: HandleId,
) {
  return new Set(
    getConnectedNodeMembers(connections, segmentId, handle).map(
      (member) => member.segmentId,
    ),
  );
}

function hasSharedSegment(firstSegmentIds: Set<SegmentId>, secondSegmentIds: Set<SegmentId>) {
  for (const segmentId of firstSegmentIds) {
    if (secondSegmentIds.has(segmentId)) {
      return true;
    }
  }

  return false;
}

function getNodeKey(
  connections: Connection[],
  segmentId: SegmentId,
  handle: HandleId,
) {
  return getConnectedNodeMembers(connections, segmentId, handle)
    .map((member) => getHandleKey(member.segmentId, member.handle))
    .sort()
    .join("--");
}

function getSegmentNodePairKey(
  connections: Connection[],
  segmentId: SegmentId,
): string | null {
  if (
    !isHandleConnected(connections, segmentId, "start") ||
    !isHandleConnected(connections, segmentId, "end")
  ) {
    return null;
  }

  const startNodeKey = getNodeKey(connections, segmentId, "start");
  const endNodeKey = getNodeKey(connections, segmentId, "end");
  if (startNodeKey === endNodeKey) {
    return null;
  }

  return [startNodeKey, endNodeKey].sort().join("||");
}

function getSegmentIdsFromConnections(connections: Connection[]): Set<SegmentId> {
  const segmentIds = new Set<SegmentId>();
  for (const connection of connections) {
    segmentIds.add(connection.from.segmentId);
    segmentIds.add(connection.to.segmentId);
  }
  return segmentIds;
}

function getConnectionsAfterDisconnectingSegment(
  connections: Connection[],
  segmentId: SegmentId,
) {
  const affectedNodeKeys = new Set<string>();
  const affectedNodes: SegmentHandle[][] = [];

  for (const connection of connections) {
    if (
      connection.from.segmentId !== segmentId &&
      connection.to.segmentId !== segmentId
    ) {
      continue;
    }

    const members = getConnectedNodeMembers(
      connections,
      connection.from.segmentId,
      connection.from.handle,
    );
    const nodeKey = members
      .map((member) => getHandleKey(member.segmentId, member.handle))
      .sort()
      .join("|");

    if (!affectedNodeKeys.has(nodeKey)) {
      affectedNodeKeys.add(nodeKey);
      affectedNodes.push(members);
    }
  }

  const nextConnections = connections.filter(
    (connection) =>
      connection.from.segmentId !== segmentId && connection.to.segmentId !== segmentId,
  );
  const connectionKeys = new Set(nextConnections.map(getConnectionKey));

  for (const node of affectedNodes) {
    const remainingMembers = node.filter((member) => member.segmentId !== segmentId);

    for (let index = 1; index < remainingMembers.length; index += 1) {
      const connection = {
        from: remainingMembers[0],
        to: remainingMembers[index],
      };
      const connectionKey = getConnectionKey(connection);

      if (!connectionKeys.has(connectionKey)) {
        nextConnections.push(connection);
        connectionKeys.add(connectionKey);
      }
    }
  }

  return nextConnections;
}

function getConnectionsAfterDisconnectingHandle(
  connections: Connection[],
  segmentId: SegmentId,
  handle: HandleId,
) {
  const affectedNodeMembers = getConnectedNodeMembers(connections, segmentId, handle);
  const nextConnections = connections.filter(
    (connection) => !isConnectionHandle(connection, segmentId, handle),
  );
  const connectionKeys = new Set(nextConnections.map(getConnectionKey));
  const remainingMembers = affectedNodeMembers.filter(
    (member) => !areSameHandle(member, { segmentId, handle }),
  );

  for (let index = 1; index < remainingMembers.length; index += 1) {
    const connection = {
      from: remainingMembers[0],
      to: remainingMembers[index],
    };
    const connectionKey = getConnectionKey(connection);

    if (!connectionKeys.has(connectionKey)) {
      nextConnections.push(connection);
      connectionKeys.add(connectionKey);
    }
  }

  return nextConnections;
}

function getPoseFromHandles(start: Point, end: Point): SegmentPose {
  return {
    center: {
      x: (start.x + end.x) / 2,
      y: (start.y + end.y) / 2,
    },
    angle: Math.atan2(end.y - start.y, end.x - start.x),
  };
}

function getHandlePoint(
  segments: PuzzleSegment[],
  handle: SegmentHandle,
  segmentLength: number,
) {
  const segment = getSegmentById(segments, handle.segmentId);
  if (!segment) {
    return null;
  }

  return getSegmentHandlePoint(segment.pose, segmentLength, handle.handle);
}

function getConstraintGraph(
  segments: PuzzleSegment[],
  connections: Connection[],
  fixedHandles: SegmentHandle[],
  segmentLength: number,
) {
  const allHandles = segments.flatMap((segment) =>
    (["start", "end"] as const).map((handle) => ({
      segmentId: segment.id,
      handle,
    })),
  );
  const unvisited = new Set(
    allHandles.map((handle) => getHandleKey(handle.segmentId, handle.handle)),
  );
  const nodeKeyByHandleKey = new Map<string, string>();
  const nodes: ConstraintNode[] = [];

  while (unvisited.size > 0) {
    const firstKey = unvisited.values().next().value;
    if (!firstKey) {
      break;
    }

    const separatorIndex = firstKey.lastIndexOf(":");
    const segmentId = Number(firstKey.slice(0, separatorIndex));
    const handle = firstKey.slice(separatorIndex + 1) as HandleId;
    const members = getConnectedNodeMembers(connections, segmentId, handle);
    const nodeKey = members
      .map((member) => getHandleKey(member.segmentId, member.handle))
      .sort()
      .join("|");
    const points = members
      .map((member) => getHandlePoint(segments, member, segmentLength))
      .filter((point): point is Point => point !== null);
    const point =
      points.length > 0
        ? {
            x: points.reduce((sum, current) => sum + current.x, 0) / points.length,
            y: points.reduce((sum, current) => sum + current.y, 0) / points.length,
          }
        : { x: 0, y: 0 };

    for (const member of members) {
      const memberKey = getHandleKey(member.segmentId, member.handle);
      nodeKeyByHandleKey.set(memberKey, nodeKey);
      unvisited.delete(memberKey);
    }

    nodes.push({
      key: nodeKey,
      point,
      fixed: fixedHandles.some((fixedHandle) =>
        members.some((member) => areSameHandle(member, fixedHandle)),
      ),
    });
  }

  return {
    nodes,
    nodeKeyByHandleKey,
  };
}

// Settles a released drag into clean geometry using the rigid-body joint
// solver: rods keep their exact length while their joints are pulled tight, so
// connected handles meet and a segment can never be drawn shorter than its rod
// (the mid-body-kernel glitch). Returns segments with updated poses.
function settleGeometry(
  segments: PuzzleSegment[],
  connections: Connection[],
  metrics: PuzzleMetrics,
): PuzzleSegment[] {
  const poseById = settleConnectedSegments(segments, connections, metrics.length);
  return segments.map((segment) => {
    const pose = poseById.get(segment.id);
    return pose ? { ...segment, pose } : segment;
  });
}

function normalizeConnectedGeometry(
  segments: PuzzleSegment[],
  connections: Connection[],
  metrics: PuzzleMetrics,
  fixedHandles: SegmentHandle[] = [],
) {
  const { nodes, nodeKeyByHandleKey } = getConstraintGraph(
    segments,
    connections,
    fixedHandles,
    metrics.length,
  );
  const nodeByKey = new Map(nodes.map((node) => [node.key, node]));

  for (let iteration = 0; iteration < 40; iteration += 1) {
    for (const segment of segments) {
      const startNodeKey = getHandleNodeKey(nodeKeyByHandleKey, segment.id, "start");
      const endNodeKey = getHandleNodeKey(nodeKeyByHandleKey, segment.id, "end");
      if (!startNodeKey || !endNodeKey) {
        continue;
      }

      const startNode = nodeByKey.get(startNodeKey);
      const endNode = nodeByKey.get(endNodeKey);
      if (!startNode || !endNode) {
        continue;
      }

      // A segment whose two handles resolve to the same node is a self-loop the
      // length constraint can never satisfy. Skip it so we don't repeatedly
      // teleport the shared node by +length each iteration (which would fling
      // the whole assembly off-canvas).
      if (startNode === endNode) {
        continue;
      }

      const distance = getDistance(startNode.point, endNode.point);
      if (distance === 0) {
        endNode.point = {
          x: startNode.point.x + metrics.length,
          y: startNode.point.y,
        };
        continue;
      }

      const error = distance - metrics.length;
      const unit = {
        x: (endNode.point.x - startNode.point.x) / distance,
        y: (endNode.point.y - startNode.point.y) / distance,
      };
      const startWeight = startNode.fixed ? 0 : 1;
      const endWeight = endNode.fixed ? 0 : 1;
      const weightSum = startWeight + endWeight;
      if (weightSum === 0) {
        continue;
      }

      startNode.point = {
        x: startNode.point.x + unit.x * error * (startWeight / weightSum),
        y: startNode.point.y + unit.y * error * (startWeight / weightSum),
      };
      endNode.point = {
        x: endNode.point.x - unit.x * error * (endWeight / weightSum),
        y: endNode.point.y - unit.y * error * (endWeight / weightSum),
      };
    }
  }

  return segments.map((segment) => {
    const startNodeKey = getHandleNodeKey(nodeKeyByHandleKey, segment.id, "start");
    const endNodeKey = getHandleNodeKey(nodeKeyByHandleKey, segment.id, "end");
    const startNode = startNodeKey ? nodeByKey.get(startNodeKey) : undefined;
    const endNode = endNodeKey ? nodeByKey.get(endNodeKey) : undefined;

    if (!startNode || !endNode) {
      return segment;
    }

    return {
      ...segment,
      pose: getPoseFromHandles(startNode.point, endNode.point),
    };
  });
}

function wouldCreateDuplicateSegmentBridge(
  connections: Connection[],
  candidate: SnapCandidate,
) {
  if (candidate.dragged.segmentId === candidate.target.segmentId) {
    return true;
  }

  // Forbid snapping a handle into a node that already holds the dragged
  // segment's opposite handle: that would loop one segment back onto itself
  // (both handles in one node), which is geometrically degenerate and makes
  // the length-constraint solver fling the assembly off-canvas.
  const oppositeHandle = getOppositeHandle(candidate.dragged.handle);
  const targetNodeMembers = getConnectedNodeMembers(
    connections,
    candidate.target.segmentId,
    candidate.target.handle,
  );
  if (
    targetNodeMembers.some(
      (member) =>
        member.segmentId === candidate.dragged.segmentId &&
        member.handle === oppositeHandle,
    )
  ) {
    return true;
  }

  const nextConnections = [...connections, getConnectionFromSnapCandidate(candidate)];
  const pairOwners = new Map<string, SegmentId>();

  for (const segmentId of getSegmentIdsFromConnections(nextConnections)) {
    const pairKey = getSegmentNodePairKey(nextConnections, segmentId);
    if (!pairKey) {
      continue;
    }

    if (pairOwners.has(pairKey)) {
      return true;
    }

    pairOwners.set(pairKey, segmentId);
  }

  return false;
}

function hasOverlappingTargetNodeSegments(
  connections: Connection[],
  candidates: SnapCandidate[],
) {
  if (candidates.length < 2) {
    return false;
  }

  const startCandidate = candidates.find(
    (candidate) => candidate.dragged.handle === "start",
  );
  const endCandidate = candidates.find((candidate) => candidate.dragged.handle === "end");

  if (!startCandidate || !endCandidate) {
    return false;
  }

  return hasSharedSegment(
    getConnectedNodeSegmentIds(
      connections,
      startCandidate.target.segmentId,
      startCandidate.target.handle,
    ),
    getConnectedNodeSegmentIds(
      connections,
      endCandidate.target.segmentId,
      endCandidate.target.handle,
    ),
  );
}

function findSnapCandidates(
  segments: PuzzleSegment[],
  draggedSegmentId: SegmentId,
  connections: Connection[],
  metrics: PuzzleMetrics,
): SnapCandidate[] {
  const draggedSegment = getSegmentById(segments, draggedSegmentId);
  if (!draggedSegment) {
    return [];
  }

  const candidates: SnapCandidate[] = [];

    for (const draggedHandle of ["start", "end"] as const) {
      const draggedPoint = getSegmentHandlePoint(
      draggedSegment.pose,
      metrics.length,
      draggedHandle,
    );
    let closestCandidate: SnapCandidate | null = null;
    let closestDistance = Number.POSITIVE_INFINITY;

    for (const targetSegment of segments) {
      if (targetSegment.id === draggedSegmentId) {
        continue;
      }

      for (const targetHandle of ["start", "end"] as const) {
        const targetPoint = getSegmentHandlePoint(
          targetSegment.pose,
          metrics.length,
          targetHandle,
        );
        const distance = getDistance(draggedPoint, targetPoint);

        const candidate = {
          dragged: {
            segmentId: draggedSegment.id,
            handle: draggedHandle,
            point: draggedPoint,
          },
          target: {
            segmentId: targetSegment.id,
            handle: targetHandle,
            point: targetPoint,
          },
        };

        if (
          distance <= metrics.snapRadius &&
          distance < closestDistance &&
          !areHandlesAlreadyJoined(connections, candidate.dragged, candidate.target) &&
          !wouldCreateDuplicateSegmentBridge(connections, candidate)
        ) {
          closestDistance = distance;
          closestCandidate = candidate;
        }
      }
    }

    if (closestCandidate) {
      candidates.push(closestCandidate);
    }
  }

  if (hasOverlappingTargetNodeSegments(connections, candidates)) {
    return [];
  }

  return candidates;
}

// All segment ids reachable from `segmentId` through connections (the rigid
// assembly that physics drag moves together). Includes the segment itself.
function getConnectedComponentIds(
  connections: Connection[],
  segmentId: SegmentId,
): SegmentId[] {
  const seen = new Set<SegmentId>([segmentId]);
  const queue: SegmentId[] = [segmentId];

  while (queue.length > 0) {
    const current = queue.shift()!;
    for (const connection of connections) {
      const other =
        connection.from.segmentId === current
          ? connection.to.segmentId
          : connection.to.segmentId === current
            ? connection.from.segmentId
            : null;
      if (other !== null && !seen.has(other)) {
        seen.add(other);
        queue.push(other);
      }
    }
  }

  return [...seen];
}

// Closest valid snap between any handle of the dragged component and another
// segment's handle. Connected handles may snap outward to new nodes (e.g. a
// joint attaching to a solo segment); only same-joint pairs and forbidden-bridge
// cases are excluded. Distance is the minimum of cursor-to-target and
// tip-to-target. Returns at most one candidate.
function findClosestComponentSnap(
  segments: PuzzleSegment[],
  componentIds: SegmentId[],
  pointer: Point,
  connections: Connection[],
  metrics: PuzzleMetrics,
): SnapCandidate[] {
  const component = new Set(componentIds);
  let best: SnapCandidate | null = null;
  let bestDistance = Number.POSITIVE_INFINITY;

  for (const draggedSegment of segments) {
    if (!component.has(draggedSegment.id)) {
      continue;
    }

    for (const draggedHandle of ["start", "end"] as const) {
      const draggedPoint = getSegmentHandlePoint(
        draggedSegment.pose,
        metrics.length,
        draggedHandle,
      );

      for (const targetSegment of segments) {
        if (targetSegment.id === draggedSegment.id) {
          continue;
        }

        for (const targetHandle of ["start", "end"] as const) {
          const targetPoint = getSegmentHandlePoint(
            targetSegment.pose,
            metrics.length,
            targetHandle,
          );
          const tipDistance = getDistance(draggedPoint, targetPoint);
          const pointerDistance = getDistance(pointer, targetPoint);
          const distance = Math.min(tipDistance, pointerDistance);
          const candidate: SnapCandidate = {
            dragged: { segmentId: draggedSegment.id, handle: draggedHandle, point: draggedPoint },
            target: { segmentId: targetSegment.id, handle: targetHandle, point: targetPoint },
          };

          if (
            distance <= metrics.snapRadius &&
            distance < bestDistance &&
            !areHandlesAlreadyJoined(connections, candidate.dragged, candidate.target) &&
            !wouldCreateDuplicateSegmentBridge(connections, candidate)
          ) {
            bestDistance = distance;
            best = candidate;
          }
        }
      }
    }
  }

  return best ? [best] : [];
}

// Pointer-led snap: when the user explicitly grabbed a free handle, snap is
// decided by where the pointer is, not by the (possibly chain-constrained)
// physical position of the grabbed handle. This lets loop closures and long
// reaches fire even when the chain hasn't folded yet — release-time normalize
// then bends the geometry into the new shape.
function findPointerHandleSnap(
  segments: PuzzleSegment[],
  draggedSegmentId: SegmentId,
  draggedHandle: HandleId,
  pointer: Point,
  connections: Connection[],
  metrics: PuzzleMetrics,
): SnapCandidate[] {
  const draggedSegment = getSegmentById(segments, draggedSegmentId);
  if (!draggedSegment) {
    return [];
  }

  const draggedPoint = getSegmentHandlePoint(
    draggedSegment.pose,
    metrics.length,
    draggedHandle,
  );

  let best: SnapCandidate | null = null;
  let bestDistance = Number.POSITIVE_INFINITY;

  for (const targetSegment of segments) {
    if (targetSegment.id === draggedSegmentId) {
      continue;
    }

    for (const targetHandle of ["start", "end"] as const) {
      const targetPoint = getSegmentHandlePoint(
        targetSegment.pose,
        metrics.length,
        targetHandle,
      );
      const distance = getDistance(pointer, targetPoint);
      const candidate: SnapCandidate = {
        dragged: { segmentId: draggedSegmentId, handle: draggedHandle, point: draggedPoint },
        target: { segmentId: targetSegment.id, handle: targetHandle, point: targetPoint },
      };

      if (
        distance <= metrics.snapRadius &&
        distance < bestDistance &&
        !areHandlesAlreadyJoined(connections, candidate.dragged, candidate.target) &&
        !wouldCreateDuplicateSegmentBridge(connections, candidate)
      ) {
        bestDistance = distance;
        best = candidate;
      }
    }
  }

  return best ? [best] : [];
}

function getConnectionFromSnapCandidate(candidate: SnapCandidate): Connection {
  return {
    from: {
      segmentId: candidate.target.segmentId,
      handle: candidate.target.handle,
    },
    to: {
      segmentId: candidate.dragged.segmentId,
      handle: candidate.dragged.handle,
    },
  };
}

// The set of handle keys whose colored kernel is hidden (i.e. a released dot):
// every joint with 2+ members keeps only its earliest-joined handle visible
// (the owner) and hides the rest. The released-dot count is exactly this set's
// size — equivalently (connected handles) − (number of joints) — so it is
// always correct, including after detaching a segment joined at both ends.
function computeHiddenCapKeys(
  connections: Connection[],
  joinOrder: Map<string, number>,
): Set<string> {
  const hidden = new Set<string>();
  const visited = new Set<string>();

  for (const connection of connections) {
    for (const handle of [connection.from, connection.to]) {
      const key = getHandleKey(handle.segmentId, handle.handle);
      if (visited.has(key)) {
        continue;
      }

      const members = getConnectedNodeMembers(connections, handle.segmentId, handle.handle);
      for (const member of members) {
        visited.add(getHandleKey(member.segmentId, member.handle));
      }
      if (members.length < 2) {
        continue;
      }

      let ownerKey: string | null = null;
      let ownerOrder = Number.POSITIVE_INFINITY;
      for (const member of members) {
        const memberKey = getHandleKey(member.segmentId, member.handle);
        const order = joinOrder.get(memberKey) ?? Number.POSITIVE_INFINITY;
        if (order < ownerOrder) {
          ownerOrder = order;
          ownerKey = memberKey;
        }
      }

      for (const member of members) {
        const memberKey = getHandleKey(member.segmentId, member.handle);
        if (memberKey !== ownerKey) {
          hidden.add(memberKey);
        }
      }
    }
  }

  return hidden;
}

// Single source of truth for the dot pile: reconcile the fallen caps against the
// hidden set derived from the current connections. Newly hidden kernels fall
// into the pile; kernels no longer hidden animate back to their handle. Called
// after every connect/disconnect, so the count can never drift.
function reconcileCaps(
  segments: PuzzleSegment[],
  connections: Connection[],
  joinOrder: Map<string, number>,
  metrics: PuzzleMetrics,
  capState: CapState,
): CapState {
  const hidden = computeHiddenCapKeys(connections, joinOrder);
  const now = performance.now();
  const existingKeys = new Set(capState.fallenCaps.map((cap) => cap.key));
  let pileCount = capState.fallenCaps.filter((cap) => cap.status !== "returning").length;

  const fallenCaps: FallenCap[] = capState.fallenCaps.map((cap) => {
    if (hidden.has(cap.key)) {
      // Belongs in the pile. If it was animating back, send it down again.
      if (cap.status === "returning") {
        return { ...cap, status: "falling", from: cap.current, to: cap.current, startedAt: now };
      }
      return cap;
    }

    // No longer hidden — return it to its handle (unless already doing so).
    if (cap.status === "returning") {
      return cap;
    }
    const handle = parseHandleKey(cap.key);
    const returnTo = getHandlePoint(segments, handle, metrics.length) ?? cap.from;
    return { ...cap, status: "returning", startedAt: now, returnFrom: cap.current, returnTo };
  });

  for (const key of hidden) {
    if (existingKeys.has(key)) {
      continue;
    }
    const handle = parseHandleKey(key);
    const point = getHandlePoint(segments, handle, metrics.length);
    if (!point) {
      continue;
    }
    fallenCaps.push({
      key,
      color: getSegmentColor(segments, handle.segmentId),
      from: point,
      to: getPilePosition(pileCount, pileCount + 1, metrics),
      current: point,
      status: "falling",
      startedAt: now,
    });
    pileCount += 1;
  }

  return { hiddenCapKeys: [...hidden], fallenCaps };
}

// --- Temporary diagnostic --------------------------------------------------
// Detects the "empty handle that isn't really free" state so a reproduction
// surfaces the exact cause. Two failure modes are flagged:
//   open-joint      handles the graph treats as one joint are drawn apart.
//   hidden-but-free a kernel is hidden on a handle in no multi-member joint.
// Remove once the root cause is fixed.
const SHOW_DIAGNOSTICS = true;

type StateProblem = { key: string; point: Point; reason: string };

function findStateProblems(
  segments: PuzzleSegment[],
  connections: Connection[],
  hiddenCapKeys: string[],
  length: number,
): StateProblem[] {
  const problems: StateProblem[] = [];
  const seenNodes = new Set<string>();

  for (const connection of connections) {
    for (const handle of [connection.from, connection.to]) {
      const members = getConnectedNodeMembers(connections, handle.segmentId, handle.handle);
      if (members.length < 2) {
        continue;
      }
      const nodeKey = members
        .map((member) => getHandleKey(member.segmentId, member.handle))
        .sort()
        .join("|");
      if (seenNodes.has(nodeKey)) {
        continue;
      }
      seenNodes.add(nodeKey);

      const points = members
        .map((member) => getHandlePoint(segments, member, length))
        .filter((point): point is Point => point !== null);
      let maxGap = 0;
      for (let i = 0; i < points.length; i += 1) {
        for (let j = i + 1; j < points.length; j += 1) {
          maxGap = Math.max(maxGap, getDistance(points[i], points[j]));
        }
      }
      if (maxGap > 6) {
        for (const member of members) {
          const point = getHandlePoint(segments, member, length);
          if (point) {
            problems.push({
              key: getHandleKey(member.segmentId, member.handle),
              point,
              reason: `open-joint gap=${Math.round(maxGap)}`,
            });
          }
        }
      }
    }
  }

  for (const key of hiddenCapKeys) {
    const handle = parseHandleKey(key);
    const members = getConnectedNodeMembers(connections, handle.segmentId, handle.handle);
    if (members.length < 2) {
      const point = getHandlePoint(segments, handle, length);
      if (point) {
        problems.push({ key, point, reason: "hidden-but-free" });
      }
    }
  }

  return problems;
}

export default function App() {
  const svgRef = useRef<SVGSVGElement | null>(null);
  const mainRef = useRef<HTMLElement | null>(null);
  const gameRef = useRef<HTMLDivElement | null>(null);
  const chromeRef = useRef<HTMLDivElement | null>(null);
  const disconnectionEffectIdRef = useRef(0);
  // Tracks the order in which each handle first became part of a connection node.
  // The kernel "owner" of a joint is the member with the lowest join-order index
  // (i.e. the earliest joined), so ownership is stable across re-renders and is
  // decoupled from segment z-index, which only controls draw order.
  const handleJoinOrderRef = useRef<Map<string, number>>(new Map());

  function recordHandleJoin(handle: SegmentHandle) {
    const key = getHandleKey(handle.segmentId, handle.handle);
    if (!handleJoinOrderRef.current.has(key)) {
      handleJoinOrderRef.current.set(key, handleJoinOrderRef.current.size);
    }
  }
  const initialCanvasSize = getDefaultCanvasSize();
  const initialLayoutChrome = getDefaultLayoutChrome();
  const initialGame = createInitialGameState(
    DEFAULT_SEGMENT_COUNT,
    initialCanvasSize,
    initialLayoutChrome,
  );
  const [canvasSize, setCanvasSize] = useState(initialCanvasSize);
  const [layoutChrome, setLayoutChrome] = useState(initialLayoutChrome);
  const [segmentCount, setSegmentCount] = useState(DEFAULT_SEGMENT_COUNT);
  const [metrics, setMetrics] = useState(initialGame.metrics);
  const [segments, setSegments] = useState(initialGame.segments);
  const [connections, setConnections] = useState(initialGame.connections);
  const [snapCandidates, setSnapCandidates] = useState(initialGame.snapCandidates);
  const [capState, setCapState] = useState(initialGame.capState);
  const [disconnectionEffects, setDisconnectionEffects] = useState(
    initialGame.disconnectionEffects,
  );
  const [dragState, setDragState] = useState(initialGame.dragState);
  const [checkResult, setCheckResult] = useState<{ dots: number; max: number } | null>(null);
  // Physics is the shipping mode; the classic path is retained behind this flag
  // so it can be revived by flipping the value.
  const dragMode: DragMode = "physics";

  // Physics-drag runtime lives in refs so the rAF loop reads fresh values
  // without re-subscribing; React state only mirrors poses for rendering.
  const physicsRef = useRef<PhysicsRuntime | null>(null);
  const physicsFrameRef = useRef<number | null>(null);
  const gestureRef = useRef<{
    startedAt: number;
    // Pointer-down position in client (screen) pixels — movement is measured
    // here, not in SVG units, so tap detection is scale-independent on mobile.
    startClient: Point;
    moveTolerancePx: number;
    moved: boolean;
  } | null>(null);
  // The snap candidates currently drawn as the green "connect" indicator. Release
  // commits exactly these (WYSIWYG) rather than recomputing from the pointer at
  // pointerup — on touch the finger rolls as it lifts, firing a final move that
  // would otherwise snap the connection to a different handle than the one shown.
  const liveSnapRef = useRef<SnapCandidate[]>([]);
  // Effective snap radius for the active drag: widened for touch/pen so a fat
  // finger doesn't need pixel-precise aim to catch a handle. null when idle
  // (fall back to metrics.snapRadius). Read in the rAF loop and while rendering
  // the green ring so the drawn catch area matches what actually snaps.
  const dragSnapRadiusRef = useRef<number | null>(null);
  const TOUCH_SNAP_RADIUS_SCALE = 1.6;
  // True once the player has interacted with the board. While false, a viewport
  // resize may safely re-center the starting layout; once true, a resize must
  // leave the in-progress game untouched (never wipe connections/poses).
  const boardTouchedRef = useRef(false);

  function clearCheckResult() {
    setCheckResult(null);
  }

  function restartGame(
    nextSegmentCount = segmentCount,
    nextCanvasSize = canvasSize,
    nextLayoutChrome = layoutChrome,
  ) {
    handleJoinOrderRef.current = new Map();
    if (physicsFrameRef.current !== null) {
      window.cancelAnimationFrame(physicsFrameRef.current);
      physicsFrameRef.current = null;
    }
    physicsRef.current = null;
    gestureRef.current = null;
    boardTouchedRef.current = false;
    const nextGame = createInitialGameState(
      nextSegmentCount,
      nextCanvasSize,
      nextLayoutChrome,
    );
    setSegmentCount(nextSegmentCount);
    setMetrics(nextGame.metrics);
    setSegments(nextGame.segments);
    setConnections(nextGame.connections);
    setSnapCandidates(nextGame.snapCandidates);
    setCapState(nextGame.capState);
    setDisconnectionEffects(nextGame.disconnectionEffects);
    setDragState(nextGame.dragState);
    clearCheckResult();
  }

  useEffect(
    () => () => {
      if (physicsFrameRef.current !== null) {
        window.cancelAnimationFrame(physicsFrameRef.current);
      }
    },
    [],
  );

  useLayoutEffect(() => {
    const game = gameRef.current;
    if (!game) {
      return;
    }

    const measureLayout = () => {
      const gameRect = game.getBoundingClientRect();

      setCanvasSize((current) => {
        const next = getCanvasSize(gameRect.width, gameRect.height);
        if (current.width === next.width && current.height === next.height) {
          return current;
        }
        return next;
      });
      setLayoutChrome((current) => {
        if (
          current.containerHeightPx === gameRect.height &&
          current.containerWidthPx === gameRect.width
        ) {
          return current;
        }
        return {
          topPx: 0,
          containerHeightPx: gameRect.height,
          containerWidthPx: gameRect.width,
        };
      });
    };

    measureLayout();

    const observer = new ResizeObserver(measureLayout);
    observer.observe(game);
    if (chromeRef.current) {
      observer.observe(chromeRef.current);
    }
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    setMetrics(getPuzzleMetrics(segmentCount, canvasSize, layoutChrome));
  }, [canvasSize, layoutChrome]);

  // Rebuild the board ONLY when the piece count changes (a deliberate new
  // puzzle). It must NOT depend on canvas/layout size: a viewport resize — e.g.
  // the mobile toolbar showing/hiding when a fast drag reaches the screen edge —
  // would otherwise wipe connections and the join-order map mid-play. With an
  // empty join-order map, computeHiddenCapKeys can't pick a joint's visible
  // owner, so every joined handle's kernel hides (the "empty handles" bug).
  // Layout is reference-based, so a resize only needs to rescale the SVG, which
  // the metrics effect above already handles without touching game state.
  useEffect(() => {
    const nextGame = createInitialGameState(segmentCount, canvasSize, layoutChrome);
    setMetrics(nextGame.metrics);
    setSegments(nextGame.segments);
    setConnections(nextGame.connections);
    setSnapCandidates(nextGame.snapCandidates);
    setCapState(nextGame.capState);
    setDisconnectionEffects(nextGame.disconnectionEffects);
    setDragState(nextGame.dragState);
    handleJoinOrderRef.current = new Map();
    if (physicsFrameRef.current !== null) {
      window.cancelAnimationFrame(physicsFrameRef.current);
      physicsFrameRef.current = null;
    }
    physicsRef.current = null;
    gestureRef.current = null;
    boardTouchedRef.current = false;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [segmentCount]);

  // Non-destructive re-layout on resize: only while the board is still in its
  // pristine starting state. This re-centers the initial grid once the real
  // viewport is measured (default vs measured differ by the chrome height)
  // without ever disturbing an in-progress game.
  useEffect(() => {
    if (boardTouchedRef.current) {
      return;
    }
    const nextGame = createInitialGameState(segmentCount, canvasSize, layoutChrome);
    setMetrics(nextGame.metrics);
    setSegments(nextGame.segments);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    canvasSize.width,
    canvasSize.height,
    layoutChrome.containerWidthPx,
    layoutChrome.containerHeightPx,
  ]);

  useEffect(() => {
    const needsAnimation = capState.fallenCaps.some(
      (cap) =>
        cap.status === "falling" ||
        cap.status === "returning" ||
        !isCapAtSlot(cap, capState.fallenCaps, metrics),
    );

    if (!needsAnimation) {
      return;
    }

    const frameId = window.requestAnimationFrame((now) => {
      setCapState((currentCapState) => {
        let hiddenCapKeys = currentCapState.hiddenCapKeys;
        const fallenCaps = currentCapState.fallenCaps.flatMap((cap) => {
          if (cap.status === "fallen") {
            const target = getCapPileSlot(cap, currentCapState.fallenCaps, metrics);

            if (getDistance(cap.current, target) < 0.5) {
              return [{ ...cap, current: target, to: target }];
            }

            return [
              {
                ...cap,
                to: target,
                current: {
                  x: lerp(cap.current.x, target.x, CAP_RESTACK_SPEED),
                  y: lerp(cap.current.y, target.y, CAP_RESTACK_SPEED),
                },
              },
            ];
          }

          const duration =
            cap.status === "falling" ? CAP_FALL_DURATION_MS : CAP_RETURN_DURATION_MS;
          const progress = Math.min((now - cap.startedAt) / duration, 1);

          if (cap.status === "falling") {
            const current = animateToward(cap.from, cap.to, progress);

            if (progress >= 1) {
              return [
                {
                  ...cap,
                  current: cap.to,
                  status: "fallen" as const,
                },
              ];
            }

            return [{ ...cap, current }];
          }

          const returnTo = cap.returnTo ?? cap.from;
          const returnFrom = cap.returnFrom ?? cap.current;
          const current = animateToward(returnFrom, returnTo, progress);

          if (progress >= 1) {
            hiddenCapKeys = hiddenCapKeys.filter((key) => key !== cap.key);
            return [];
          }

          return [{ ...cap, current }];
        });

        return {
          hiddenCapKeys,
          fallenCaps,
        };
      });
    });

    return () => {
      window.cancelAnimationFrame(frameId);
    };
  }, [capState.fallenCaps, metrics]);

  function bringDraggedSegmentsToFront(
    grabbedSegmentId: SegmentId,
    componentSegmentIds: SegmentId[],
  ) {
    setSegments((currentSegments) => {
      const component = new Set(componentSegmentIds);
      const others = currentSegments.filter((segment) => !component.has(segment.id));
      const componentSegments = currentSegments.filter(
        (segment) => component.has(segment.id) && segment.id !== grabbedSegmentId,
      );
      const grabbed = currentSegments.filter((segment) => segment.id === grabbedSegmentId);
      return [...others, ...componentSegments, ...grabbed];
    });
  }


  function disconnectSegment(segmentId: SegmentId) {
    const disconnectedConnections = connections.filter(
      (connection) =>
        connection.from.segmentId === segmentId || connection.to.segmentId === segmentId,
    );

    if (disconnectedConnections.length === 0) {
      return;
    }

    const newEffects = disconnectedConnections.flatMap((connection) => {
      const segment = getSegmentById(segments, connection.from.segmentId);
      if (!segment) {
        return [];
      }

      return [
        {
          id: disconnectionEffectIdRef.current++,
          point: getSegmentHandlePoint(
            segment.pose,
            metrics.length,
            connection.from.handle,
          ),
        },
      ];
    });

    setDisconnectionEffects((currentEffects) => [...currentEffects, ...newEffects]);
    for (const effect of newEffects) {
      window.setTimeout(() => {
        setDisconnectionEffects((currentEffects) =>
          currentEffects.filter((currentEffect) => currentEffect.id !== effect.id),
        );
      }, DISCONNECT_ANIMATION_MS);
    }

    const nextConnections = getConnectionsAfterDisconnectingSegment(
      connections,
      segmentId,
    );
    setConnections(nextConnections);
    setCapState((currentCapState) =>
      reconcileCaps(
        segments,
        nextConnections,
        handleJoinOrderRef.current,
        metrics,
        currentCapState,
      ),
    );
  }

  function startBodyDrag(segmentId: SegmentId, event: React.PointerEvent<SVGLineElement>) {
    if (!svgRef.current) {
      return;
    }

    const segment = getSegmentById(segments, segmentId);
    if (!segment) {
      return;
    }

    event.currentTarget.setPointerCapture(event.pointerId);
    bringDraggedSegmentsToFront(segmentId, [segmentId]);
    const nextSnapConnections = getConnectionsAfterDisconnectingSegment(
      connections,
      segmentId,
    );
    disconnectSegment(segmentId);
    setDragState({
      type: "translate",
      segmentId,
      snapConnections: nextSnapConnections,
      pointerStart: getSvgPoint(svgRef.current, event.clientX, event.clientY),
      poseStart: segment.pose,
    });
  }

  function startHandleDrag(
    segmentId: SegmentId,
    draggedHandle: HandleId,
    event: React.PointerEvent<SVGCircleElement>,
  ) {
    const segment = getSegmentById(segments, segmentId);
    if (!segment) {
      return;
    }

    event.currentTarget.setPointerCapture(event.pointerId);
    const fixedHandle = draggedHandle === "start" ? "end" : "start";
    const fixedHandleConnection = connections.find((connection) =>
      isConnectionHandle(connection, segmentId, fixedHandle),
    );
    const nextSnapConnections = fixedHandleConnection
      ? getConnectionsAfterDisconnectingHandle(connections, segmentId, draggedHandle)
      : getConnectionsAfterDisconnectingSegment(connections, segmentId);
    const dragComponentIds = getConnectedComponentIds(nextSnapConnections, segmentId);
    bringDraggedSegmentsToFront(segmentId, dragComponentIds);

    if (!fixedHandleConnection) {
      disconnectSegment(segmentId);
    } else {
      setConnections(nextSnapConnections);
      setCapState((currentCapState) =>
        reconcileCaps(
          segments,
          nextSnapConnections,
          handleJoinOrderRef.current,
          metrics,
          currentCapState,
        ),
      );
    }

    const fixedPoint = getSegmentHandlePoint(
      segment.pose,
      metrics.length,
      fixedHandle,
    );
    setDragState({
      type: "rotate",
      segmentId,
      snapConnections: nextSnapConnections,
      draggedHandle,
      fixedPoint,
      connectedPivotPoint: fixedHandleConnection ? fixedPoint : undefined,
    });
  }

  function continueDrag(event: React.PointerEvent<SVGSVGElement>) {
    if (!dragState || dragState.type === "physics" || !svgRef.current) {
      return;
    }

    const pointer = getSvgPoint(svgRef.current, event.clientX, event.clientY);
    let nextPose: SegmentPose;

    if (dragState.type === "translate") {
      nextPose = {
        ...dragState.poseStart,
        center: {
          x: dragState.poseStart.center.x + pointer.x - dragState.pointerStart.x,
          y: dragState.poseStart.center.y + pointer.y - dragState.pointerStart.y,
        },
      };
    } else {
      nextPose = getPoseFromFixedHandle(
        dragState.fixedPoint,
        pointer,
        dragState.draggedHandle,
        metrics.length,
      );
    }

    setSegments((currentSegments) => {
      const nextSegments = currentSegments.map((segment) =>
        segment.id === dragState.segmentId ? { ...segment, pose: nextPose } : segment,
      );
      setSnapCandidates(
        findSnapCandidates(
          nextSegments,
          dragState.segmentId,
          dragState.snapConnections,
          metrics,
        ),
      );
      return nextSegments;
    });
  }

  function stopDrag() {
    if (dragState?.type === "physics") {
      return;
    }
    if (dragState && snapCandidates.length > 0) {
      // Record join order so kernel ownership lives in the node data structure
      // (target first, then dragged) rather than depending on segment z-index.
      for (const candidate of snapCandidates) {
        recordHandleJoin({
          segmentId: candidate.target.segmentId,
          handle: candidate.target.handle,
        });
        recordHandleJoin({
          segmentId: candidate.dragged.segmentId,
          handle: candidate.dragged.handle,
        });
      }

      const nextConnections = [
        ...dragState.snapConnections,
        ...snapCandidates.map(getConnectionFromSnapCandidate),
      ];
      const fixedHandles =
        dragState.type === "rotate"
          ? [
              {
                segmentId: dragState.segmentId,
                handle: getOppositeHandle(dragState.draggedHandle),
              },
            ]
          : [];

      setSegments((currentSegments) =>
        normalizeConnectedGeometry(currentSegments, nextConnections, metrics, fixedHandles),
      );
      setConnections(nextConnections);
      setCapState((currentCapState) =>
        reconcileCaps(
          segments,
          nextConnections,
          handleJoinOrderRef.current,
          metrics,
          currentCapState,
        ),
      );
    } else if (dragState) {
      setCapState((currentCapState) =>
        reconcileCaps(segments, connections, handleJoinOrderRef.current, metrics, currentCapState),
      );
    }

    setDragState(null);
    setSnapCandidates([]);
  }

  // --- Physics drag mode -------------------------------------------------
  // One unified gesture for body and handle: a position-based constraint pulls
  // the grabbed point toward the pointer (centre grab -> translate, end grab ->
  // rotate), and the connected component moves as one linkage. A short tap with
  // little movement disconnects the segment instead. The classic path above is
  // left untouched so the modes can be compared via the header toggle.

  function buildLiveSegments(runtime: PhysicsRuntime, sourceSegments: PuzzleSegment[]) {
    return sourceSegments.map((segment) => {
      const body = runtime.bodyById.get(segment.id);
      return body ? { ...segment, pose: poseFromBody(body) } : segment;
    });
  }

  function startPhysicsLoop() {
    if (physicsFrameRef.current !== null) {
      return;
    }

    const loopConnections = connections;
    // Use the (possibly touch-widened) snap radius for catch detection.
    const loopMetrics = {
      ...metrics,
      snapRadius: dragSnapRadiusRef.current ?? metrics.snapRadius,
    };
    const loopSegments = segments;

    const frame = () => {
      const runtime = physicsRef.current;
      if (!runtime) {
        physicsFrameRef.current = null;
        return;
      }

      const moving = stepPhysics(runtime);
      setSegments((currentSegments) =>
        currentSegments.map((segment) => {
          const body = runtime.bodyById.get(segment.id);
          return body ? { ...segment, pose: poseFromBody(body) } : segment;
        }),
      );

      if (runtime.mode === "drag") {
        const liveSegments = buildLiveSegments(runtime, loopSegments);
        const grabbedHandle = runtime.grab?.grabbedHandle ?? null;
        const snapResult =
          grabbedHandle && runtime.grab
            ? findPointerHandleSnap(
                liveSegments,
                runtime.grab.segmentId,
                grabbedHandle,
                runtime.pointer,
                loopConnections,
                loopMetrics,
              )
            : findClosestComponentSnap(
                liveSegments,
                [...runtime.bodyById.keys()],
                runtime.pointer,
                loopConnections,
                loopMetrics,
              );
        liveSnapRef.current = snapResult;
        setSnapCandidates(snapResult);
        physicsFrameRef.current = window.requestAnimationFrame(frame);
      } else if (moving) {
        physicsFrameRef.current = window.requestAnimationFrame(frame);
      } else {
        physicsFrameRef.current = null;
        physicsRef.current = null;
      }
    };

    physicsFrameRef.current = window.requestAnimationFrame(frame);
  }

  function stopPhysicsLoop() {
    if (physicsFrameRef.current !== null) {
      window.cancelAnimationFrame(physicsFrameRef.current);
      physicsFrameRef.current = null;
    }
  }

  function startPhysicsDrag(
    segmentId: SegmentId,
    event: React.PointerEvent<SVGElement>,
    grabbedHandle: HandleId | null,
  ) {
    const svg = svgRef.current;
    const segment = getSegmentById(segments, segmentId);
    if (!svg || !segment) {
      return;
    }

    event.currentTarget.setPointerCapture(event.pointerId);
    boardTouchedRef.current = true;
    stopPhysicsLoop();

    const grabPoint = getSvgPoint(svg, event.clientX, event.clientY);
    const componentIds = getConnectedComponentIds(connections, segmentId);
    bringDraggedSegmentsToFront(segmentId, componentIds);
    const component = new Set(componentIds);
    const bodies = segments
      .filter((candidate) => component.has(candidate.id))
      .map((candidate) => createBody(candidate.id, candidate.pose, metrics.length));
    const bodyById = new Map(bodies.map((body) => [body.segmentId, body]));
    const joints = connections
      .filter(
        (connection) =>
          component.has(connection.from.segmentId) &&
          component.has(connection.to.segmentId),
      )
      .map((connection) => ({
        a: { segmentId: connection.from.segmentId, handle: connection.from.handle },
        b: { segmentId: connection.to.segmentId, handle: connection.to.handle },
      }));

    const grabbed = bodyById.get(segmentId);
    if (!grabbed) {
      return;
    }
    const offset = grabOffsetFor(grabbed, grabPoint, metrics.length);

    physicsRef.current = {
      bodies,
      bodyById,
      joints,
      length: metrics.length,
      grab: { segmentId, offset, grabbedHandle },
      pointer: grabPoint,
      mode: "drag",
    };
    liveSnapRef.current = [];
    const isCoarsePointer = event.pointerType === "touch" || event.pointerType === "pen";
    dragSnapRadiusRef.current = isCoarsePointer
      ? metrics.snapRadius * TOUCH_SNAP_RADIUS_SCALE
      : metrics.snapRadius;
    gestureRef.current = {
      startedAt: performance.now(),
      startClient: { x: event.clientX, y: event.clientY },
      moveTolerancePx: isCoarsePointer
        ? PHYSICS.tapMaxMoveTouchPx
        : PHYSICS.tapMaxMoveMousePx,
      moved: false,
    };
    setDragState({ type: "physics", segmentId });
    startPhysicsLoop();
  }

  function continuePhysicsDrag(event: React.PointerEvent<SVGSVGElement>) {
    const svg = svgRef.current;
    const runtime = physicsRef.current;
    if (!svg || !runtime || runtime.mode !== "drag") {
      return;
    }

    const pointer = getSvgPoint(svg, event.clientX, event.clientY);
    runtime.pointer = pointer;

    const gesture = gestureRef.current;
    if (gesture && !gesture.moved) {
      const movedPx = Math.hypot(
        event.clientX - gesture.startClient.x,
        event.clientY - gesture.startClient.y,
      );
      if (movedPx > gesture.moveTolerancePx) {
        gesture.moved = true;
      }
    }
  }

  function stopPhysicsDrag() {
    const runtime = physicsRef.current;
    const gesture = gestureRef.current;
    gestureRef.current = null;
    dragSnapRadiusRef.current = null;

    if (!runtime || runtime.mode !== "drag") {
      setDragState(null);
      setSnapCandidates([]);
      return;
    }

    stopPhysicsLoop();
    const grabbedId = runtime.grab?.segmentId ?? null;
    const isTap =
      gesture !== null &&
      !gesture.moved &&
      performance.now() - gesture.startedAt < PHYSICS.tapMaxMs;
    const liveSegments = buildLiveSegments(runtime, segments);
    physicsRef.current = null;

    setDragState(null);
    setSnapCandidates([]);

    if (isTap && grabbedId !== null) {
      setSegments(liveSegments);
      performTapDisconnect(grabbedId, liveSegments);
      return;
    }

    // Commit exactly the snap the user last saw highlighted. Recomputing here
    // from runtime.pointer would let a touch lift-off wobble retarget the joint.
    const candidates = liveSnapRef.current;
    liveSnapRef.current = [];

    if (candidates.length === 0) {
      // No new connection, but the physics drag can leave joined handles
      // apart. Settle rod lengths on the rigid bodies, then merge joined
      // handles into shared nodes so every joint closes exactly — the rigid
      // solver alone leaves residual gaps on closed loops, which strands
      // kernels on handles that look empty but are still joined.
      setSegments(
        normalizeConnectedGeometry(
          settleGeometry(liveSegments, connections, metrics),
          connections,
          metrics,
        ),
      );
      return;
    }

    for (const candidate of candidates) {
      recordHandleJoin({
        segmentId: candidate.target.segmentId,
        handle: candidate.target.handle,
      });
      recordHandleJoin({
        segmentId: candidate.dragged.segmentId,
        handle: candidate.dragged.handle,
      });
    }

    const nextConnections = [
      ...connections,
      ...candidates.map(getConnectionFromSnapCandidate),
    ];
    setSegments(
      normalizeConnectedGeometry(
        settleGeometry(liveSegments, nextConnections, metrics),
        nextConnections,
        metrics,
      ),
    );
    setConnections(nextConnections);
    setCapState((currentCapState) =>
      reconcileCaps(
        liveSegments,
        nextConnections,
        handleJoinOrderRef.current,
        metrics,
        currentCapState,
      ),
    );
  }

  function performTapDisconnect(segmentId: SegmentId, liveSegments: PuzzleSegment[]) {
    const isConnected = connections.some(
      (connection) =>
        connection.from.segmentId === segmentId || connection.to.segmentId === segmentId,
    );
    if (!isConnected) {
      return;
    }

    disconnectSegment(segmentId);

    const segment = getSegmentById(liveSegments, segmentId);
    if (!segment) {
      return;
    }

    // Little spin + slide so the freed segment visibly pops off the joint.
    const body = createBody(segmentId, segment.pose, metrics.length);
    const sign = Math.random() < 0.5 ? -1 : 1;
    const perpAngle = segment.pose.angle + Math.PI / 2;
    body.omega = PHYSICS.disconnectKickOmega * sign;
    body.vx = Math.cos(perpAngle) * PHYSICS.disconnectKickSpeed * sign;
    body.vy = Math.sin(perpAngle) * PHYSICS.disconnectKickSpeed * sign;

    physicsRef.current = {
      bodies: [body],
      bodyById: new Map([[segmentId, body]]),
      joints: [],
      length: metrics.length,
      grab: null,
      pointer: { ...body.center },
      mode: "settle",
    };
    startPhysicsLoop();
  }

  function handleSegmentPointerDown(segmentId: SegmentId, event: React.PointerEvent<SVGElement>) {
    clearCheckResult();
    if (dragMode === "physics") {
      startPhysicsDrag(segmentId, event, null);
    } else {
      startBodyDrag(segmentId, event as React.PointerEvent<SVGLineElement>);
    }
  }

  function handleSegmentHandlePointerDown(
    segmentId: SegmentId,
    handle: HandleId,
    event: React.PointerEvent<SVGElement>,
  ) {
    clearCheckResult();
    if (dragMode === "physics") {
      startPhysicsDrag(segmentId, event, handle);
    } else {
      startHandleDrag(segmentId, handle, event as React.PointerEvent<SVGCircleElement>);
    }
  }

  function handlePointerMove(event: React.PointerEvent<SVGSVGElement>) {
    if (dragMode === "physics") {
      continuePhysicsDrag(event);
    } else {
      continueDrag(event);
    }
  }

  function handlePointerUp() {
    if (dragMode === "physics") {
      stopPhysicsDrag();
    } else {
      stopDrag();
    }
  }

  // Diagnostic: only when not actively dragging (joints are legitimately open
  // mid-drag). Marks broken handles red and dumps the state to the console.
  const stateProblems =
    SHOW_DIAGNOSTICS && !dragState
      ? findStateProblems(segments, connections, capState.hiddenCapKeys, metrics.length)
      : [];
  const problemSignature = stateProblems.map((problem) => `${problem.key}:${problem.reason}`).join(",");
  useEffect(() => {
    if (problemSignature.length === 0) {
      return;
    }
    // eslint-disable-next-line no-console
    console.warn("[erdos diagnostic] inconsistent state", {
      problems: stateProblems,
      connections,
      hiddenCapKeys: capState.hiddenCapKeys,
      poses: segments.map((segment) => ({ id: segment.id, pose: segment.pose })),
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [problemSignature]);

  // Restart / Check actions, grouped with whichever pieces control is on screen
  // (the dropdown on mobile, the number grid on desktop). Rendered in both
  // placements; only one wrapper is visible per breakpoint.
  const actions = (
    <div className="pointer-events-auto relative w-fit">
      <div className="flex items-center gap-2.5">
        <button
          type="button"
          onClick={() => restartGame(segmentCount)}
          className="inline-flex min-h-[38px] items-center rounded-full px-3.5 text-[13px] tracking-wide text-zinc-500 transition active:scale-[0.97] hover:bg-zinc-100 hover:text-zinc-900"
        >
          Restart
        </button>

        <button
          type="button"
          onClick={() => {
            const dots = capState.fallenCaps.filter(
              (cap) => cap.status !== "returning",
            ).length;
            setCheckResult({ dots, max: getMaxDots(segmentCount) });
          }}
          className="inline-flex min-h-[38px] items-center rounded-full bg-zinc-100 px-4 text-[13px] font-medium tracking-wide text-zinc-700 transition active:scale-[0.97] hover:bg-zinc-200 hover:text-zinc-900"
        >
          Check solution
        </button>
      </div>

      {checkResult && (
        <p className="pointer-events-auto absolute left-1/2 top-full mt-2 -translate-x-1/2 text-[13px] font-light leading-relaxed whitespace-nowrap">
          {checkResult.dots >= checkResult.max ? (
            <span className="text-emerald-700">Solved! You cracked it.</span>
          ) : (
            <span className="text-zinc-500">
              {checkResult.max - checkResult.dots} more{" "}
              {checkResult.max - checkResult.dots === 1 ? "dot" : "dots"} to collect.
            </span>
          )}
          <button
            type="button"
            onClick={() => setCheckResult(null)}
            aria-label="Dismiss check result"
            className="ml-2 text-zinc-400 transition hover:text-zinc-900"
          >
            ×
          </button>
        </p>
      )}
    </div>
  );

  return (
    <main
      ref={mainRef}
      className="flex h-dvh w-full flex-col overflow-hidden bg-white text-zinc-900"
    >
      <div
        ref={chromeRef}
        className="pointer-events-none shrink-0 select-none bg-white px-5 pb-2 pt-[max(1.25rem,env(safe-area-inset-top,0px))] md:px-10 md:pb-3 md:pt-9"
      >
        <div className="flex items-center justify-between gap-4">
          <h1 className="text-[15px] font-medium uppercase tracking-[0.35em] text-zinc-900">
            Erdős
          </h1>

          <label className="pointer-events-auto flex items-center gap-2">
            <span className="text-[10px] font-medium uppercase tracking-[0.2em] text-zinc-400">
              Pieces
            </span>
            <select
              value={segmentCount}
              onChange={(event) => restartGame(Number(event.target.value))}
              className="cursor-pointer rounded-md border border-zinc-200 bg-white px-2 py-1 text-[13px] tabular-nums text-zinc-700 outline-none transition hover:border-zinc-300 focus:border-zinc-400"
            >
              {SEGMENT_COUNT_OPTIONS.map((count) => (
                <option key={count} value={count}>
                  {count}
                </option>
              ))}
            </select>
          </label>
        </div>

        <div className="mt-3 w-full space-y-1.5 text-[12px] font-light leading-relaxed text-zinc-400 md:mt-4 md:text-[13px]">
          <p>Connect two handles to release a dot.</p>
          <p>Quick-tap a piece to disconnect.</p>
          <p>Drag anywhere to move and reshape.</p>
        </div>

        {/* Actions below the instructions, centered horizontally. Same clean
            layout on every breakpoint. */}
        <div className="mt-5 flex justify-center">{actions}</div>
      </div>

      <div ref={gameRef} className="relative min-h-0 w-full flex-1">
        <svg
          ref={svgRef}
          viewBox={`0 0 ${canvasSize.width} ${canvasSize.height}`}
          preserveAspectRatio="xMidYMid meet"
          className="block h-full w-full touch-none"
          onPointerMove={handlePointerMove}
          onPointerUp={handlePointerUp}
          onPointerCancel={handlePointerUp}
        >
          {dragState?.type === "rotate" && dragState.connectedPivotPoint && (
            <g pointerEvents="none">
              <circle
                cx={dragState.connectedPivotPoint.x}
                cy={dragState.connectedPivotPoint.y}
                r={metrics.snapRadius}
                fill="#22c55e"
                opacity={0.14}
              />
              <circle
                cx={dragState.connectedPivotPoint.x}
                cy={dragState.connectedPivotPoint.y}
                r={metrics.handleRadius + 11}
                fill="none"
                stroke="#22c55e"
                strokeWidth={4}
              />
            </g>
          )}

          {snapCandidates.map((snapCandidate) => {
            // Draw the catch area at the same radius the loop is snapping with,
            // so the green halo honestly shows what will connect.
            const ringRadius = dragSnapRadiusRef.current ?? metrics.snapRadius;
            return (
            <g
              key={`${snapCandidate.dragged.handle}-${snapCandidate.target.segmentId}-${snapCandidate.target.handle}`}
              pointerEvents="none"
            >
              <circle
                cx={snapCandidate.target.point.x}
                cy={snapCandidate.target.point.y}
                r={ringRadius}
                fill="#22c55e"
                opacity={0.14}
              />
              <circle
                cx={snapCandidate.target.point.x}
                cy={snapCandidate.target.point.y}
                r={metrics.handleRadius + 11}
                fill="none"
                stroke="#22c55e"
                strokeWidth={4}
              />
              <text
                x={snapCandidate.target.point.x}
                y={snapCandidate.target.point.y - ringRadius - 8}
                fill="#15803d"
                textAnchor="middle"
                className="select-none font-bold"
                fontSize={Math.max(12, metrics.bodyWidth * 0.55)}
              >
                connect
              </text>
            </g>
            );
          })}

          {/* Pass 1: bodies, in segment z-order. */}
          {segments.map((segment) => (
            <Segment
              key={`${segment.id}-body`}
              pose={segment.pose}
              length={metrics.length}
              bodyWidth={metrics.bodyWidth}
              handleRadius={metrics.handleRadius}
              color={segment.color}
              renderBody={true}
              renderHandles={false}
              renderCaps={false}
              onBodyPointerDown={(event) => handleSegmentPointerDown(segment.id, event)}
              onHandlePointerDown={(handle, event) =>
                handleSegmentHandlePointerDown(segment.id, handle, event)
              }
            />
          ))}

          {/* Pass 2: black handle rings, in segment z-order. */}
          {segments.map((segment) => (
            <Segment
              key={`${segment.id}-rings`}
              pose={segment.pose}
              length={metrics.length}
              bodyWidth={metrics.bodyWidth}
              handleRadius={metrics.handleRadius}
              color={segment.color}
              renderBody={false}
              renderHandles={true}
              renderCaps={false}
              onBodyPointerDown={(event) => handleSegmentPointerDown(segment.id, event)}
              onHandlePointerDown={(handle, event) =>
                handleSegmentHandlePointerDown(segment.id, handle, event)
              }
            />
          ))}

          {/* Pass 3: colored kernels, always drawn after all rings so the
              node-owned kernel sits visually on top of any ring stroke at the
              joint. Visibility per handle comes from capState.hiddenCapKeys,
              which is owned by the node data structure (not by z-index). */}
          {segments.map((segment) => (
            <Segment
              key={`${segment.id}-caps`}
              pose={segment.pose}
              length={metrics.length}
              bodyWidth={metrics.bodyWidth}
              handleRadius={metrics.handleRadius}
              color={segment.color}
              renderBody={false}
              renderHandles={false}
              renderCaps={true}
              hiddenCaps={{
                start: capState.hiddenCapKeys.includes(
                  getHandleKey(segment.id, "start"),
                ),
                end: capState.hiddenCapKeys.includes(getHandleKey(segment.id, "end")),
              }}
              onBodyPointerDown={(event) => handleSegmentPointerDown(segment.id, event)}
              onHandlePointerDown={(handle, event) =>
                handleSegmentHandlePointerDown(segment.id, handle, event)
              }
            />
          ))}

          {capState.fallenCaps.map((cap) => (
            <circle
              key={cap.key}
              cx={cap.current.x}
              cy={cap.current.y}
              r={metrics.pileDotRadius}
              fill={cap.color}
              pointerEvents="none"
            />
          ))}

          <text
            x={metrics.pileCenterX}
            y={metrics.pileCounterY}
            textAnchor="middle"
            dominantBaseline="central"
            fontSize={metrics.pileCounterFontSize}
            fontWeight={800}
            fontFamily="system-ui, -apple-system, 'Segoe UI', sans-serif"
            fill="#0f172a"
            pointerEvents="none"
          >
            {capState.fallenCaps.filter((cap) => cap.status !== "returning").length}
          </text>

          {disconnectionEffects.map((effect) => (
            <g key={effect.id} pointerEvents="none">
              <circle
                cx={effect.point.x}
                cy={effect.point.y}
                r={metrics.handleRadius + 10}
                fill="none"
                stroke="#f59e0b"
                strokeWidth={4}
                opacity={0.8}
              >
                <animate
                  attributeName="r"
                  from={metrics.handleRadius + 8}
                  to={metrics.handleRadius + 34}
                  dur={`${DISCONNECT_ANIMATION_MS}ms`}
                  fill="freeze"
                />
                <animate
                  attributeName="opacity"
                  from="0.75"
                  to="0"
                  dur={`${DISCONNECT_ANIMATION_MS}ms`}
                  fill="freeze"
                />
              </circle>
              <circle cx={effect.point.x} cy={effect.point.y} r={4} fill="#fbbf24">
                <animate
                  attributeName="opacity"
                  from="0.7"
                  to="0"
                  dur={`${DISCONNECT_ANIMATION_MS}ms`}
                  fill="freeze"
                />
              </circle>
            </g>
          ))}

          {stateProblems.map((problem, index) => (
            <g key={`diag-${problem.key}-${index}`} pointerEvents="none">
              <circle
                cx={problem.point.x}
                cy={problem.point.y}
                r={metrics.viewHandleRadius + 10}
                fill="none"
                stroke="#ef4444"
                strokeWidth={5}
              />
              <text
                x={problem.point.x}
                y={problem.point.y + metrics.viewHandleRadius + 30}
                fill="#ef4444"
                textAnchor="middle"
                fontSize={22}
                fontWeight={700}
              >
                {problem.reason}
              </text>
            </g>
          ))}

          {stateProblems.length > 0 && (
            <g pointerEvents="none" fontFamily="monospace">
              <text x={24} y={48} fill="#ef4444" fontSize={34} fontWeight={800}>
                DIAGNOSTIC: {stateProblems.length} broken handle(s)
              </text>
              {[
                `conns: ${connections
                  .map(
                    (connection) =>
                      `${connection.from.segmentId}${connection.from.handle[0]}-${connection.to.segmentId}${connection.to.handle[0]}`,
                  )
                  .join(" ")}`,
                `hidden: ${capState.hiddenCapKeys.join(" ")}`,
                ...segments.map(
                  (segment) =>
                    `#${segment.id} ${Math.round(segment.pose.center.x)},${Math.round(
                      segment.pose.center.y,
                    )} ${Math.round((segment.pose.angle * 180) / Math.PI)}d`,
                ),
              ].map((line, index) => (
                <text key={`dump-${index}`} x={24} y={92 + index * 34} fill="#ef4444" fontSize={26}>
                  {line}
                </text>
              ))}
            </g>
          )}
        </svg>
      </div>
    </main>
  );
}
