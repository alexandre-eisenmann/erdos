import type { Point, SegmentPose } from "./Segment";

// ---------------------------------------------------------------------------
// Mini rigid-body solver for the "physics" drag mode.
//
// Each segment is a uniform rod (mass 1) treated as a rigid body. Dragging is a
// position-based constraint that pulls the grabbed point toward the pointer; the
// torque produced by the lever arm between the grab point and the rod's centre
// of mass is what makes a centre-grab translate and an end-grab rotate. The same
// positional-correction math drives the pin joints, so a connected assembly
// reorganises as one linkage. Velocities are only used for the little spin
// injected when a segment is tapped free.
//
// This whole file is self-contained so the mode can be toggled or removed
// without touching the classic drag path.
// ---------------------------------------------------------------------------

export const PHYSICS = {
  substeps: 6,
  jointIterations: 8,
  // How aggressively the grabbed point chases the pointer each substep (1 = all
  // the way in one shot, before joints pull back).
  mouseStrength: 1,
  // Velocity integration (used only while a tapped-free segment settles).
  dt: 1 / 60,
  linearDamping: 6,
  angularDamping: 7,
  settleSpeed: 2,
  settleOmega: 0.05,
  // Tap-to-disconnect gesture thresholds. Movement is measured in real screen
  // pixels (not SVG units) so the gesture behaves the same regardless of how far
  // the SVG viewBox is scaled — on a phone the board shrinks ~3×, so an
  // SVG-space threshold would make a finger's natural jitter read as a drag and
  // silently break tap-to-disconnect. Touch gets a looser tolerance than a mouse
  // because fingers are imprecise and skin contact shifts as it lifts.
  tapMaxMs: 250,
  tapMaxMoveMousePx: 5,
  tapMaxMoveTouchPx: 14,
  // Spin (rad/s) and slide (px/s) given to a segment tapped free of its joints.
  disconnectKickOmega: 3,
  disconnectKickSpeed: 36,
} as const;

export type HandleId = "start" | "end";

export type PhysicsBody = {
  segmentId: number;
  center: Point;
  angle: number;
  vx: number;
  vy: number;
  omega: number;
  invMass: number;
  invInertia: number;
};

export type PhysicsJoint = {
  a: { segmentId: number; handle: HandleId };
  b: { segmentId: number; handle: HandleId };
};

export type PhysicsRuntime = {
  bodies: PhysicsBody[];
  bodyById: Map<number, PhysicsBody>;
  joints: PhysicsJoint[];
  length: number;
  // grabbedHandle is set when the user pressed on a free handle (vs the body),
  // marking that handle as the explicit snap source for the duration of the drag.
  grab: { segmentId: number; offset: number; grabbedHandle: HandleId | null } | null;
  pointer: Point;
  mode: "drag" | "settle";
};

export function createBody(
  segmentId: number,
  pose: SegmentPose,
  length: number,
): PhysicsBody {
  return {
    segmentId,
    center: { x: pose.center.x, y: pose.center.y },
    angle: pose.angle,
    vx: 0,
    vy: 0,
    omega: 0,
    invMass: 1,
    // Uniform rod about its centre: I = m·L²/12.
    invInertia: 12 / (length * length),
  };
}

export function poseFromBody(body: PhysicsBody): SegmentPose {
  return { center: { x: body.center.x, y: body.center.y }, angle: body.angle };
}

function bodyHandlePoint(body: PhysicsBody, handle: HandleId, length: number): Point {
  const direction = handle === "start" ? -1 : 1;
  const half = (length / 2) * direction;
  return {
    x: body.center.x + Math.cos(body.angle) * half,
    y: body.center.y + Math.sin(body.angle) * half,
  };
}

// Signed distance, along the body axis, from the centre to a grabbed point.
// ±length/2 at the handles, 0 at the centre of mass.
export function grabOffsetFor(body: PhysicsBody, grabPoint: Point, length: number): number {
  const ax = Math.cos(body.angle);
  const ay = Math.sin(body.angle);
  const projection = (grabPoint.x - body.center.x) * ax + (grabPoint.y - body.center.y) * ay;
  const half = length / 2;
  return Math.max(-half, Math.min(half, projection));
}

// Positional correction so the grabbed point moves toward `target`. With a zero
// lever arm this is pure translation; off-centre it splits into translation plus
// rotation, exactly like pulling a stick by one end.
function solveMouse(body: PhysicsBody, offset: number, target: Point, strength: number) {
  const ax = Math.cos(body.angle);
  const ay = Math.sin(body.angle);
  const px = body.center.x + ax * offset;
  const py = body.center.y + ay * offset;

  const dx = target.x - px;
  const dy = target.y - py;
  const dist = Math.hypot(dx, dy);
  if (dist < 1e-6) {
    return;
  }

  const nx = dx / dist;
  const ny = dy / dist;
  const rx = px - body.center.x;
  const ry = py - body.center.y;
  const cross = rx * ny - ry * nx;
  const w = body.invMass + body.invInertia * cross * cross;
  if (w <= 0) {
    return;
  }

  const lambda = (strength * dist) / w;
  body.center.x += body.invMass * lambda * nx;
  body.center.y += body.invMass * lambda * ny;
  body.angle += body.invInertia * lambda * cross;
}

// Pin-joint correction pulling two handles together, distributed across both
// bodies by inverse mass / inverse inertia. Static bodies (invMass 0) don't move.
function solveJoint(a: PhysicsBody, b: PhysicsBody, joint: PhysicsJoint, length: number) {
  const pa = bodyHandlePoint(a, joint.a.handle, length);
  const pb = bodyHandlePoint(b, joint.b.handle, length);

  const dx = pb.x - pa.x;
  const dy = pb.y - pa.y;
  const dist = Math.hypot(dx, dy);
  if (dist < 1e-6) {
    return;
  }

  const nx = dx / dist;
  const ny = dy / dist;
  const rax = pa.x - a.center.x;
  const ray = pa.y - a.center.y;
  const rbx = pb.x - b.center.x;
  const rby = pb.y - b.center.y;
  const crossA = rax * ny - ray * nx;
  const crossB = rbx * ny - rby * nx;

  const wA = a.invMass + a.invInertia * crossA * crossA;
  const wB = b.invMass + b.invInertia * crossB * crossB;
  const w = wA + wB;
  if (w <= 0) {
    return;
  }

  const lambda = dist / w;
  a.center.x += a.invMass * lambda * nx;
  a.center.y += a.invMass * lambda * ny;
  a.angle += a.invInertia * lambda * crossA;
  b.center.x -= b.invMass * lambda * nx;
  b.center.y -= b.invMass * lambda * ny;
  b.angle -= b.invInertia * lambda * crossB;
}

function integrate(body: PhysicsBody, dt: number) {
  body.center.x += body.vx * dt;
  body.center.y += body.vy * dt;
  body.angle += body.omega * dt;
  const linearFactor = Math.max(0, 1 - PHYSICS.linearDamping * dt);
  const angularFactor = Math.max(0, 1 - PHYSICS.angularDamping * dt);
  body.vx *= linearFactor;
  body.vy *= linearFactor;
  body.omega *= angularFactor;
}

// Advances one rendered frame. Returns true while a settling body is still
// moving (the drag loop ignores this and runs until the pointer is released).
export function stepPhysics(runtime: PhysicsRuntime): boolean {
  const { bodies, bodyById, joints, length, grab, pointer, mode } = runtime;
  const subDt = PHYSICS.dt / PHYSICS.substeps;
  const grabbed = grab ? bodyById.get(grab.segmentId) : undefined;

  for (let step = 0; step < PHYSICS.substeps; step += 1) {
    if (mode === "settle") {
      for (const body of bodies) {
        integrate(body, subDt);
      }
    }

    if (grabbed && grab) {
      solveMouse(grabbed, grab.offset, pointer, PHYSICS.mouseStrength);
    }

    for (let iteration = 0; iteration < PHYSICS.jointIterations; iteration += 1) {
      for (const joint of joints) {
        const a = bodyById.get(joint.a.segmentId);
        const b = bodyById.get(joint.b.segmentId);
        if (a && b) {
          solveJoint(a, b, joint, length);
        }
      }
    }
  }

  if (mode === "settle") {
    return bodies.some(
      (body) =>
        Math.hypot(body.vx, body.vy) > PHYSICS.settleSpeed ||
        Math.abs(body.omega) > PHYSICS.settleOmega,
    );
  }
  return true;
}

// Pulls all joints tight on the given rigid bodies using only the positional
// joint solver. Each body stays a rod of exactly `length`, so settling joints
// this way can never shorten a segment — unlike a node-based re-solve, which can
// settle two of a segment's nodes closer than the rod and strand its kernel
// mid-body. Used to clean up joint slack when a drag is released.
export function settleConnectedSegments(
  segments: { id: number; pose: SegmentPose }[],
  connections: { from: { segmentId: number; handle: HandleId }; to: { segmentId: number; handle: HandleId } }[],
  length: number,
  iterations = 200,
): Map<number, SegmentPose> {
  const bodyById = new Map(
    segments.map((segment) => [segment.id, createBody(segment.id, segment.pose, length)]),
  );
  const joints = connections.map((connection) => ({
    a: { segmentId: connection.from.segmentId, handle: connection.from.handle },
    b: { segmentId: connection.to.segmentId, handle: connection.to.handle },
  }));

  for (let iteration = 0; iteration < iterations; iteration += 1) {
    for (const joint of joints) {
      const a = bodyById.get(joint.a.segmentId);
      const b = bodyById.get(joint.b.segmentId);
      if (a && b) {
        solveJoint(a, b, joint, length);
      }
    }
  }

  const poseById = new Map<number, SegmentPose>();
  for (const [id, body] of bodyById) {
    poseById.set(id, poseFromBody(body));
  }
  return poseById;
}
