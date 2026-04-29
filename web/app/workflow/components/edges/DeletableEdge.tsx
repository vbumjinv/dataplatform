'use client';

import React, { useMemo, useState } from "react";
import { EdgeLabelRenderer, EdgeProps, getBezierPath } from "reactflow";

type DeleteHandler = (edgeId: string) => void;
export function DeletableEdge({
  id,
  sourceX,
  sourceY,
  targetX,
  targetY,
  sourcePosition,
  targetPosition,
  markerEnd,
  style,
  data,
}: EdgeProps<{
  onDeleteEdge?: DeleteHandler;
}>) {
  const [hovered, setHovered] = useState(false);
  const [edgePath, labelX, labelY] = useMemo(
    () =>
      getBezierPath({
        sourceX,
        sourceY,
        targetX,
        targetY,
        sourcePosition,
        targetPosition,
      }),
    [sourcePosition, sourceX, sourceY, targetPosition, targetX, targetY],
  );

  return (
    <>
      <path
        d={edgePath}
        fill="none"
        stroke="transparent"
        strokeWidth={12}
        onMouseEnter={() => setHovered(true)}
        onMouseLeave={() => setHovered(false)}
      />
      <path
        className="react-flow__edge-path"
        d={edgePath}
        markerEnd={markerEnd}
        style={style}
        onMouseEnter={() => setHovered(true)}
        onMouseLeave={() => setHovered(false)}
      />
      <EdgeLabelRenderer>
        <div
          className="nodrag nopan"
          style={{
            position: "absolute",
            transform: `translate(-50%, -50%) translate(${labelX}px, ${labelY - 8}px)`,
            pointerEvents: "all",
          }}
          onMouseEnter={() => setHovered(true)}
          onMouseLeave={() => setHovered(false)}
        >
          <button
            type="button"
            onClick={() => data?.onDeleteEdge?.(id)}
            className={`flex h-4 w-4 cursor-pointer items-center justify-center rounded-full border border-slate-200 bg-white text-[9px] font-semibold text-slate-500 shadow-sm transition hover:border-slate-300 hover:bg-rose-50 hover:text-rose-600 hover:shadow ${
              hovered ? "opacity-100" : "opacity-0"
            }`}
            aria-label="Delete edge"
          >
            ×
          </button>
        </div>
      </EdgeLabelRenderer>
    </>
  );
}
