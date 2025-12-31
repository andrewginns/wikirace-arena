"use client";

import { useRef } from "react";
import { cn } from "@/lib/utils";

export default function ResizeHandle({
  axis,
  onDelta,
  className,
  onDoubleClick,
}: {
  axis: "x" | "y";
  onDelta: (deltaPx: number) => void;
  className?: string;
  onDoubleClick?: () => void;
}) {
  const pointerIdRef = useRef<number | null>(null);
  const lastPosRef = useRef<number | null>(null);
  const prevCursorRef = useRef<string | null>(null);
  const prevUserSelectRef = useRef<string | null>(null);

  const endDrag = () => {
    pointerIdRef.current = null;
    lastPosRef.current = null;

    if (prevCursorRef.current !== null) {
      document.body.style.cursor = prevCursorRef.current;
      prevCursorRef.current = null;
    }
    if (prevUserSelectRef.current !== null) {
      document.body.style.userSelect = prevUserSelectRef.current;
      prevUserSelectRef.current = null;
    }
  };

  const isX = axis === "x";

  return (
    <div
      role="separator"
      tabIndex={0}
      aria-orientation={isX ? "vertical" : "horizontal"}
      onDoubleClick={onDoubleClick}
      onPointerDown={(e) => {
        pointerIdRef.current = e.pointerId;
        lastPosRef.current = isX ? e.clientX : e.clientY;

        prevCursorRef.current = document.body.style.cursor;
        prevUserSelectRef.current = document.body.style.userSelect;

        document.body.style.cursor = isX ? "col-resize" : "row-resize";
        document.body.style.userSelect = "none";

        (e.currentTarget as HTMLDivElement).setPointerCapture(e.pointerId);
      }}
      onPointerMove={(e) => {
        if (pointerIdRef.current !== e.pointerId) return;
        if (lastPosRef.current === null) return;
        const pos = isX ? e.clientX : e.clientY;
        const delta = pos - lastPosRef.current;
        lastPosRef.current = pos;
        onDelta(delta);
      }}
      onPointerUp={endDrag}
      onPointerCancel={endDrag}
      className={cn(
        "touch-none select-none rounded-sm bg-border/40 hover:bg-border/70",
        isX ? "cursor-col-resize" : "cursor-row-resize",
        className
      )}
    />
  );
}

