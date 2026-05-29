import { useEffect, useRef, useState } from "react";
import { getSegmentHandlePoint, Segment, type Point, type SegmentPose } from "./Segment";
import {
  createBody,
  grabOffsetFor,
  PHYSICS,
  poseFromBody,
  stepPhysics,
  type PhysicsRuntime,
} from "./dragPhysics";

type DragMode = "classic" | "physics";

const DISCONNECT_ANIMATION_MS = 700;
const CAP_FALL_DURATION_MS = 520;
const CAP_RETURN_DURATION_MS = 480;
const CAP_RESTACK_SPEED = 0.2;
const CANVAS_WIDTH = 1200;
const CANVAS_MIN_HEIGHT = 720;

type CanvasSize = {
  width: number;
  height: number;
};

function getCanvasSize(containerWidth: number, containerHeight: number): CanvasSize {
  const width = CANVAS_WIDTH;
  const height = Math.max(
    CANVAS_MIN_HEIGHT,
    Math.round(width * (containerHeight / Math.max(containerWidth, 1))),
  );

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
    return { topPx: 140, containerHeightPx: CANVAS_MIN_HEIGHT };
  }

  return { topPx: 140, containerHeightPx: window.innerHeight };
}
const MIN_SEGMENT_COUNT = 3;
const MAX_SEGMENT_COUNT = 57;
const DEFAULT_SEGMENT_COUNT = 5;

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
  layoutMinY: number;
  layoutMaxY: number;
  layoutMargin: number;
  layoutCols: number;
};

type LayoutChrome = {
  topPx: number;
  containerHeightPx: number;
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

// Largest 45° segment length, and the column count, that packs `segmentCount`
// diagonal segments into the play area. A 45° segment occupies a square
// bounding box of side L/√2 + 2·viewHandleRadius; spacing grid cells one box
// (plus a separation gap) apart keeps neighbouring boxes from touching, so the
// segments inside them can never overlap — no collision testing required. We
// scan every column count and keep the one yielding the largest fitting
// segment (which naturally balances the grid to the play area's aspect ratio).
function chooseDiagonalGrid(
  segmentCount: number,
  playWidth: number,
  playHeight: number,
  viewHandleRadius: number,
  separation: number,
  maxLength: number,
) {
  let best = { length: 0, cols: 1 };

  for (let cols = 1; cols <= segmentCount; cols += 1) {
    const rows = Math.ceil(segmentCount / cols);
    const boxByWidth = (playWidth - (cols - 1) * separation) / cols;
    const boxByHeight = (playHeight - (rows - 1) * separation) / rows;
    const box = Math.min(boxByWidth, boxByHeight);
    const length = Math.SQRT2 * (box - 2 * viewHandleRadius);
    if (length > best.length) {
      best = { length, cols };
    }
  }

  return { length: Math.min(maxLength, Math.max(0, best.length)), cols: best.cols };
}

function getPuzzleMetrics(
  segmentCount: number,
  canvas: CanvasSize,
  chrome: LayoutChrome = {
    topPx: 0,
    containerHeightPx: canvas.height,
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
  const pileDotRadius = Math.max(10, Math.min(18, Math.round(canvas.height * 0.022)));
  const pileCounterFontSize = Math.max(
    56,
    Math.min(104, Math.round(canvas.height * 0.11)),
  );
  const bottomInset = Math.max(28, Math.round(canvas.height * 0.035));
  const pileToCounterGap = Math.max(14, Math.round(pileDotRadius * 1.5));
  const pileCounterY = canvas.height - bottomInset - pileCounterFontSize * 0.32;
  const pileBaseY =
    pileCounterY - pileCounterFontSize * 0.48 - pileToCounterGap - pileDotRadius;
  const pileStep = pileDotRadius * 2 + 6;
  const capStackReserve = pileStep * 5;
  const topInsetSvg = Math.round(
    (chrome.topPx / Math.max(chrome.containerHeightPx, 1)) * canvas.height,
  );
  const layoutMinY = topInsetSvg + Math.round(layoutMargin * 0.35);
  const layoutMaxY = pileBaseY - capStackReserve - viewHandleRadius;
  const playWidth = canvas.width - layoutMargin * 2;
  const playHeight = layoutMaxY - layoutMinY;
  const minSegmentSeparation = Math.round(lerp(28, 8, t));
  const bodyHalfWidth = (bodyWidth + 6) / 2;
  const collisionRadius = Math.max(bodyHalfWidth, viewHandleRadius) + 8;
  const layout = chooseDiagonalGrid(
    segmentCount,
    playWidth,
    playHeight,
    viewHandleRadius,
    minSegmentSeparation,
    280,
  );
  const length = layout.length;
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
  const pitch = boxSide + metrics.minSegmentSeparation;
  const playWidth = metrics.canvasWidth - metrics.layoutMargin * 2;
  const playHeight = metrics.layoutMaxY - metrics.layoutMinY;
  const gridHeight = (rows - 1) * pitch + boxSide;
  const startY = metrics.layoutMinY + (playHeight - gridHeight) / 2 + boxSide / 2;
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

function getCapKeysToRestore(
  connections: Connection[],
  hiddenCapKeys: string[],
  joinOrder: Map<string, number>,
) {
  const connectionHandles = connections.flatMap((connection) => [
    connection.from,
    connection.to,
  ]);
  const visited = new Set<string>();
  const keysToRestore: string[] = [];

  for (const handle of connectionHandles) {
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

    const hasVisibleCap = members.some(
      (member) => !hiddenCapKeys.includes(getHandleKey(member.segmentId, member.handle)),
    );
    if (hasVisibleCap) {
      continue;
    }

    const restoreHandle = [...members].sort((first, second) => {
      const firstOrder =
        joinOrder.get(getHandleKey(first.segmentId, first.handle)) ??
        Number.POSITIVE_INFINITY;
      const secondOrder =
        joinOrder.get(getHandleKey(second.segmentId, second.handle)) ??
        Number.POSITIVE_INFINITY;
      return firstOrder - secondOrder;
    })[0];

    if (restoreHandle) {
      keysToRestore.push(getHandleKey(restoreHandle.segmentId, restoreHandle.handle));
    }
  }

  return keysToRestore;
}

function reconcileCapState(
  segments: PuzzleSegment[],
  connections: Connection[],
  capState: CapState,
  joinOrder: Map<string, number>,
  metrics: PuzzleMetrics,
): CapState {
  const keysToRestore = getCapKeysToRestore(
    connections,
    capState.hiddenCapKeys,
    joinOrder,
  );

  if (keysToRestore.length === 0) {
    return capState;
  }

  const now = performance.now();
  const capByKey = new Map(capState.fallenCaps.map((cap) => [cap.key, cap]));
  const keysWithoutFallenCap = keysToRestore.filter((key) => !capByKey.has(key));

  return {
    hiddenCapKeys: capState.hiddenCapKeys.filter(
      (key) => !keysWithoutFallenCap.includes(key),
    ),
    fallenCaps: capState.fallenCaps.map((cap) => {
      if (!keysToRestore.includes(cap.key)) {
        return cap;
      }

      const handle = parseHandleKey(cap.key);
      const returnTo = getHandlePoint(segments, handle, metrics.length);
      if (!returnTo) {
        return cap;
      }

      return {
        ...cap,
        status: "returning",
        startedAt: now,
        returnFrom: cap.current,
        returnTo,
      };
    }),
  };
}

export default function App() {
  const svgRef = useRef<SVGSVGElement | null>(null);
  const mainRef = useRef<HTMLElement | null>(null);
  const leftChromeRef = useRef<HTMLDivElement | null>(null);
  const rightChromeRef = useRef<HTMLDivElement | null>(null);
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
  const gestureRef = useRef<{ startedAt: number; start: Point; moved: boolean } | null>(null);

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
    setCheckResult(null);
  }

  useEffect(
    () => () => {
      if (physicsFrameRef.current !== null) {
        window.cancelAnimationFrame(physicsFrameRef.current);
      }
    },
    [],
  );

  useEffect(() => {
    const main = mainRef.current;
    if (!main) {
      return;
    }

    const measureLayout = () => {
      const mainRect = main.getBoundingClientRect();
      const leftRect = leftChromeRef.current?.getBoundingClientRect();
      const rightRect = rightChromeRef.current?.getBoundingClientRect();
      const chromeBottom = Math.max(
        leftRect?.bottom ?? mainRect.top,
        rightRect?.bottom ?? mainRect.top,
      );
      const topPx = Math.max(0, chromeBottom - mainRect.top + 20);

      setCanvasSize((current) => {
        const next = getCanvasSize(mainRect.width, mainRect.height);
        if (current.width === next.width && current.height === next.height) {
          return current;
        }
        return next;
      });
      setLayoutChrome((current) => {
        if (
          current.topPx === topPx &&
          current.containerHeightPx === mainRect.height
        ) {
          return current;
        }
        return { topPx, containerHeightPx: mainRect.height };
      });
    };

    measureLayout();

    const observer = new ResizeObserver(measureLayout);
    observer.observe(main);
    if (leftChromeRef.current) {
      observer.observe(leftChromeRef.current);
    }
    if (rightChromeRef.current) {
      observer.observe(rightChromeRef.current);
    }
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    setMetrics(getPuzzleMetrics(segmentCount, canvasSize, layoutChrome));
  }, [canvasSize, segmentCount, layoutChrome]);

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

  useEffect(() => {
    if (dragState || capState.hiddenCapKeys.length === 0) {
      return;
    }

    const returningCapKeys = new Set(
      capState.fallenCaps
        .filter((cap) => cap.status === "returning")
        .map((cap) => cap.key),
    );
    const disconnectedCapKeys = capState.hiddenCapKeys.filter((key) => {
      if (returningCapKeys.has(key)) {
        return false;
      }

      const handle = parseHandleKey(key);
      return !isHandleConnected(connections, handle.segmentId, handle.handle);
    });

    if (disconnectedCapKeys.length === 0) {
      return;
    }

    setCapState((currentCapState) => {
      const now = performance.now();
      const fallenCapByKey = new Map(
        currentCapState.fallenCaps.map((cap) => [cap.key, cap]),
      );

      return {
        hiddenCapKeys: currentCapState.hiddenCapKeys.filter((key) => {
          if (!disconnectedCapKeys.includes(key)) {
            return true;
          }

          return fallenCapByKey.has(key);
        }),
        fallenCaps: currentCapState.fallenCaps.map((cap) => {
          if (!disconnectedCapKeys.includes(cap.key)) {
            return cap;
          }

          const returnTo = getHandlePoint(segments, parseHandleKey(cap.key), metrics.length);

          return {
            ...cap,
            status: "returning",
            startedAt: now,
            returnFrom: cap.current,
            returnTo: returnTo ?? cap.from,
          };
        }),
      };
    });
  }, [capState.fallenCaps, capState.hiddenCapKeys, connections, dragState, metrics.length, segments]);

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

  function getCapStateWithHiddenDraggedCaps(
    currentCapState: CapState,
    candidates: SnapCandidate[],
  ): CapState {
    const hiddenCapKeys = [
      ...currentCapState.hiddenCapKeys,
      ...candidates
        .map((candidate) =>
          getHandleKey(candidate.dragged.segmentId, candidate.dragged.handle),
        )
        .filter((key) => !currentCapState.hiddenCapKeys.includes(key)),
    ];
    const capsByKey = new Map(
      currentCapState.fallenCaps.map((cap) => [cap.key, cap]),
    );
    const now = performance.now();

    for (const candidate of candidates) {
      const key = getHandleKey(candidate.dragged.segmentId, candidate.dragged.handle);
      if (capsByKey.has(key)) {
        continue;
      }

      const color = getSegmentColor(segments, candidate.dragged.segmentId);
      const pileIndex = [...capsByKey.values()].filter(
        (cap) => cap.status !== "returning",
      ).length;
      const slot = getPilePosition(pileIndex, pileIndex + 1, metrics);

      capsByKey.set(key, {
        key,
        color,
        from: candidate.dragged.point,
        to: slot,
        current: candidate.dragged.point,
        status: "falling",
        startedAt: now,
      });
    }

    return {
      hiddenCapKeys,
      fallenCaps: [...capsByKey.values()],
    };
  }

  function restoreReleasedCaps(segmentId: SegmentId) {
    const segmentCapKeys = (["start", "end"] as const).map((handle) =>
      getHandleKey(segmentId, handle),
    );

    setCapState((currentCapState) =>
      reconcileCapState(
        segments,
        connections,
        {
          ...currentCapState,
          hiddenCapKeys: currentCapState.hiddenCapKeys.filter((key) => {
            if (!segmentCapKeys.includes(key)) {
              return true;
            }

            const handle = parseHandleKey(key);
            if (isHandleConnected(connections, handle.segmentId, handle.handle)) {
              return true;
            }

            return currentCapState.fallenCaps.some((cap) => cap.key === key);
          }),
          fallenCaps: currentCapState.fallenCaps.map((cap) => {
            if (!segmentCapKeys.includes(cap.key)) {
              return cap;
            }

            const handle = parseHandleKey(cap.key);
            if (isHandleConnected(connections, handle.segmentId, handle.handle)) {
              return cap;
            }

            const returnTo = getHandlePoint(segments, handle, metrics.length);

            return {
              ...cap,
              status: "returning",
              startedAt: performance.now(),
              returnFrom: cap.current,
              returnTo: returnTo ?? cap.from,
            };
          }),
        },
        handleJoinOrderRef.current,
        metrics,
      ),
    );
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
      reconcileCapState(
        segments,
        nextConnections,
        currentCapState,
        handleJoinOrderRef.current,
        metrics,
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
        reconcileCapState(
          segments,
          nextSnapConnections,
          currentCapState,
          handleJoinOrderRef.current,
          metrics,
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
        reconcileCapState(
          segments,
          nextConnections,
          getCapStateWithHiddenDraggedCaps(currentCapState, snapCandidates),
          handleJoinOrderRef.current,
          metrics,
        ),
      );
    } else if (dragState) {
      restoreReleasedCaps(dragState.segmentId);
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
    const loopMetrics = metrics;
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
    gestureRef.current = { startedAt: performance.now(), start: grabPoint, moved: false };
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
    if (gesture && !gesture.moved && getDistance(pointer, gesture.start) > PHYSICS.tapMaxMovePx) {
      gesture.moved = true;
    }
  }

  function stopPhysicsDrag() {
    const runtime = physicsRef.current;
    const gesture = gestureRef.current;
    gestureRef.current = null;

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

    const componentIds = [...runtime.bodyById.keys()];
    const grabbedHandle = runtime.grab?.grabbedHandle ?? null;
    const candidates =
      grabbedHandle && runtime.grab
        ? findPointerHandleSnap(
            liveSegments,
            runtime.grab.segmentId,
            grabbedHandle,
            runtime.pointer,
            connections,
            metrics,
          )
        : findClosestComponentSnap(
            liveSegments,
            componentIds,
            runtime.pointer,
            connections,
            metrics,
          );

    if (candidates.length === 0) {
      // No new connection, but the physics drag (mouse constraint vs. joints)
      // can leave joined handles slightly apart — a connected handle stranded
      // away from its node, its rod then drawn longer than the node gap so the
      // kernel sits mid-body. Re-normalize against the existing connections to
      // pull every joint back to clean, equal-length geometry.
      setSegments(normalizeConnectedGeometry(liveSegments, connections, metrics));
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
    setSegments(normalizeConnectedGeometry(liveSegments, nextConnections, metrics));
    setConnections(nextConnections);
    setCapState((currentCapState) =>
      reconcileCapState(
        liveSegments,
        nextConnections,
        getCapStateWithHiddenDraggedCaps(currentCapState, candidates),
        handleJoinOrderRef.current,
        metrics,
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

  return (
    <main
      ref={mainRef}
      className="relative h-screen w-screen overflow-hidden bg-white text-zinc-900"
    >
      <svg
        ref={svgRef}
        viewBox={`0 0 ${canvasSize.width} ${canvasSize.height}`}
        className="h-full w-full touch-none"
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

          {snapCandidates.map((snapCandidate) => (
            <g
              key={`${snapCandidate.dragged.handle}-${snapCandidate.target.segmentId}-${snapCandidate.target.handle}`}
              pointerEvents="none"
            >
              <circle
                cx={snapCandidate.target.point.x}
                cy={snapCandidate.target.point.y}
                r={metrics.snapRadius}
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
                y={snapCandidate.target.point.y - metrics.snapRadius - 8}
                fill="#15803d"
                textAnchor="middle"
                className="select-none font-bold"
                fontSize={Math.max(12, metrics.bodyWidth * 0.55)}
              >
                connect
              </text>
            </g>
          ))}

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
        </svg>

        <div
          ref={leftChromeRef}
          className="pointer-events-none absolute left-10 top-9 z-10 select-none"
        >
          <h1 className="text-[15px] font-medium uppercase tracking-[0.35em] text-zinc-900">
            Erdős
          </h1>
          <div className="mt-4 space-y-1.5 text-[13px] font-light leading-relaxed text-zinc-400">
            <p>Connect two handles to release a dot.</p>
            <p>Quick-tap a piece to disconnect.</p>
            <p>Drag anywhere to move and reshape.</p>
          </div>
        </div>

        <div
          ref={rightChromeRef}
          className="pointer-events-none absolute right-10 top-9 z-10 text-[13px] font-light text-zinc-400"
        >
          <div className="flex items-center gap-5">
            <label className="pointer-events-auto flex items-center gap-2">
              <span className="tracking-wide">Pieces</span>
              <select
                value={segmentCount}
                onChange={(event) => restartGame(Number(event.target.value))}
                className="cursor-pointer rounded-md border border-zinc-200 bg-white px-2 py-1 text-zinc-700 outline-none transition hover:border-zinc-300 focus:border-zinc-400"
              >
                {Array.from(
                  { length: MAX_SEGMENT_COUNT - MIN_SEGMENT_COUNT + 1 },
                  (_, index) => MIN_SEGMENT_COUNT + index,
                ).map((count) => (
                  <option key={count} value={count}>
                    {count}
                  </option>
                ))}
              </select>
            </label>

            <button
              type="button"
              onClick={() => restartGame(segmentCount)}
              className="pointer-events-auto tracking-wide underline-offset-4 transition hover:text-zinc-900 hover:underline"
            >
              Restart
            </button>

            <button
              type="button"
              onClick={() => {
                const dots = capState.fallenCaps.filter((cap) => cap.status !== "returning").length;
                setCheckResult({ dots, max: getMaxDots(segmentCount) });
              }}
              className="pointer-events-auto tracking-wide underline-offset-4 transition hover:text-zinc-900 hover:underline"
            >
              Check
            </button>
          </div>

          {checkResult && (
            <div className="pointer-events-auto mt-3 flex items-center justify-end gap-3">
              {checkResult.dots >= checkResult.max ? (
                <span className="font-medium text-emerald-600">Solved! You cracked it 🎉</span>
              ) : (
                <span className="text-zinc-700">
                  Not solved yet — {checkResult.max - checkResult.dots} more{" "}
                  {checkResult.max - checkResult.dots === 1 ? "dot" : "dots"} to go.
                </span>
              )}
              <button
                type="button"
                onClick={() => setCheckResult(null)}
                className="text-zinc-400 transition hover:text-zinc-900"
              >
                ×
              </button>
            </div>
          )}
        </div>
    </main>
  );
}
