"use client";

import { useMemo } from "react";
import { cn } from "@/lib/utils";

function clampNumber(value: number, min: number, max: number) {
  return Math.max(min, Math.min(max, value));
}

export default function HopsSparkline({
  values,
  width = 84,
  height = 16,
  bins = 12,
  className,
}: {
  values: number[];
  width?: number;
  height?: number;
  bins?: number;
  className?: string;
}) {
  const data = useMemo(() => {
    const cleaned = values.filter((v) => Number.isFinite(v) && v >= 0);
    if (cleaned.length === 0) return null;

    const min = Math.min(...cleaned);
    const max = Math.max(...cleaned);
    const effectiveBins = clampNumber(bins, 4, 24);

    if (min === max) {
      return {
        min,
        max,
        counts: [cleaned.length],
      };
    }

    const range = max - min;
    const step = range / effectiveBins;
    const counts = new Array(effectiveBins).fill(0);
    for (const v of cleaned) {
      const raw = Math.floor((v - min) / step);
      const idx = clampNumber(raw, 0, effectiveBins - 1);
      counts[idx] += 1;
    }

    return { min, max, counts };
  }, [bins, values]);

  if (!data) return null;

  const maxCount = Math.max(...data.counts);
  const barWidth = width / data.counts.length;
  const padding = 1;

  return (
    <svg
      width={width}
      height={height}
      viewBox={`0 0 ${width} ${height}`}
      className={cn("text-muted-foreground", className)}
      role="img"
      aria-label={`Hop distribution (min ${data.min}, max ${data.max})`}
    >
      <title>
        Hop distribution (min {data.min}, max {data.max})
      </title>
      {data.counts.map((count, idx) => {
        const h = maxCount > 0 ? (count / maxCount) * height : 0;
        const x = idx * barWidth;
        const y = height - h;
        return (
          <rect
            key={idx}
            x={x + padding / 2}
            y={y}
            width={Math.max(1, barWidth - padding)}
            height={Math.max(1, h)}
            rx={1}
            fill="currentColor"
            opacity={0.7}
          />
        );
      })}
    </svg>
  );
}

