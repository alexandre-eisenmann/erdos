export type Point = {
  x: number;
  y: number;
};

export type SegmentPose = {
  center: Point;
  angle: number;
};

type SegmentProps = {
  pose: SegmentPose;
  length: number;
  bodyWidth: number;
  handleRadius: number;
  color: string;
  hiddenCaps?: Partial<Record<"start" | "end", boolean>>;
  renderCaps?: boolean;
  renderBody?: boolean;
  renderHandles?: boolean;
  onBodyPointerDown: (event: React.PointerEvent<SVGLineElement>) => void;
  onHandlePointerDown: (
    handle: "start" | "end",
    event: React.PointerEvent<SVGCircleElement>,
  ) => void;
};

export function getSegmentHandlePoint(
  pose: SegmentPose,
  length: number,
  handle: "start" | "end",
): Point {
  const direction = handle === "start" ? -1 : 1;
  const halfLength = length / 2;

  return {
    x: pose.center.x + Math.cos(pose.angle) * halfLength * direction,
    y: pose.center.y + Math.sin(pose.angle) * halfLength * direction,
  };
}

export function Segment({
  pose,
  length,
  bodyWidth,
  handleRadius,
  color,
  hiddenCaps = {},
  renderCaps = true,
  renderBody = true,
  renderHandles = true,
  onBodyPointerDown,
  onHandlePointerDown,
}: SegmentProps) {
  const halfLength = length / 2;
  const borderWidth = 3;
  const viewHandleRadius = handleRadius + 7;
  const bodyHalfLength = halfLength - viewHandleRadius - bodyWidth;
  const outlineWidth = bodyWidth + borderWidth * 2;
  const connectorHalfLength = halfLength - viewHandleRadius;

  return (
    <g
      transform={`translate(${pose.center.x} ${pose.center.y}) rotate(${(pose.angle * 180) / Math.PI})`}
    >
      {renderBody && (
        <>
          <line
            x1={-connectorHalfLength}
            y1={0}
            x2={connectorHalfLength}
            y2={0}
            stroke="#262626"
            strokeWidth={borderWidth}
            strokeLinecap="round"
            pointerEvents="none"
          />
          <line
            x1={-bodyHalfLength}
            y1={0}
            x2={bodyHalfLength}
            y2={0}
            stroke="#262626"
            strokeWidth={outlineWidth}
            strokeLinecap="round"
            className="cursor-grab"
            onPointerDown={onBodyPointerDown}
          />
          <line
            x1={-bodyHalfLength}
            y1={0}
            x2={bodyHalfLength}
            y2={0}
            stroke={color}
            strokeWidth={bodyWidth}
            strokeLinecap="round"
            pointerEvents="none"
          />
        </>
      )}

      {renderHandles &&
        (["start", "end"] as const).map((handle) => {
          const x = handle === "start" ? -halfLength : halfLength;

          return (
            <circle
              key={handle}
              cx={x}
              cy={0}
              r={viewHandleRadius}
              fill="transparent"
              stroke="#262626"
              strokeWidth={borderWidth}
              className="cursor-grab"
              onPointerDown={(event) => onHandlePointerDown(handle, event)}
            />
          );
        })}

      {renderCaps &&
        (["start", "end"] as const).map((handle) => {
          if (hiddenCaps[handle]) {
            return null;
          }
          const x = handle === "start" ? -halfLength : halfLength;

          return (
            <circle
              key={handle}
              cx={x}
              cy={0}
              r={handleRadius}
              fill={color}
              pointerEvents="none"
            />
          );
        })}
    </g>
  );
}
