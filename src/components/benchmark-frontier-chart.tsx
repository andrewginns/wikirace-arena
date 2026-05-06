import { useMemo } from "react";
import { cn } from "@/lib/utils";

export type BenchmarkFrontierPoint = {
  id: string;
  label: string;
  x: number;
  y: number;
  tone?: "default" | "hovered" | "left" | "right";
};

function clampNumber(value: number, min: number, max: number) {
  return Math.max(min, Math.min(max, value));
}

function formatAxisValue(value: number) {
  if (value >= 1000) {
    return new Intl.NumberFormat(undefined, { maximumFractionDigits: 1 }).format(value);
  }
  if (value >= 10) return value.toFixed(0);
  return value.toFixed(2);
}

export default function BenchmarkFrontierChart({
  title,
  subtitle,
  xLabel,
  yLabel = "Pass %",
  points,
  formatXValue = formatAxisValue,
  className,
  dataTestId,
}: {
  title: string;
  subtitle?: string;
  xLabel: string;
  yLabel?: string;
  points: BenchmarkFrontierPoint[];
  formatXValue?: (value: number) => string;
  className?: string;
  dataTestId?: string;
}) {
  const chart = useMemo(() => {
    const valid = points.filter((point) => Number.isFinite(point.x) && Number.isFinite(point.y));
    if (valid.length === 0) return null;

    const width = 360;
    const height = 220;
    const margin = { top: 16, right: 18, bottom: 40, left: 42 };
    const innerWidth = width - margin.left - margin.right;
    const innerHeight = height - margin.top - margin.bottom;

    const xs = valid.map((point) => point.x);
    const ys = valid.map((point) => point.y);
    const xMinRaw = Math.min(...xs);
    const xMaxRaw = Math.max(...xs);
    const yMinRaw = Math.min(...ys);
    const yMaxRaw = Math.max(...ys);

    const xPad = xMinRaw === xMaxRaw ? Math.max(1, Math.abs(xMinRaw) * 0.1 || 1) : (xMaxRaw - xMinRaw) * 0.08;
    const yPad = yMinRaw === yMaxRaw ? 0.02 : (yMaxRaw - yMinRaw) * 0.12;

    let xMin = xMinRaw - xPad;
    let xMax = xMaxRaw + xPad;
    if (xMinRaw >= 0) {
      xMin = Math.max(0, xMin);
    }
    if (xMax <= xMin) {
      xMax = xMin + Math.max(1, Math.abs(xMaxRaw) * 0.1 || 1);
    }
    const yMin = clampNumber(yMinRaw - yPad, 0, 1);
    const yMax = clampNumber(yMaxRaw + yPad, yMin + 0.01, 1);

    const toX = (value: number) =>
      margin.left + ((value - xMin) / Math.max(1e-9, xMax - xMin)) * innerWidth;
    const toY = (value: number) =>
      margin.top + innerHeight - ((value - yMin) / Math.max(1e-9, yMax - yMin)) * innerHeight;

    const frontier = [...valid].sort((left, right) => left.x - right.x);
    const pareto: BenchmarkFrontierPoint[] = [];
    let bestY = -1;
    for (const point of frontier) {
      if (point.y > bestY) {
        pareto.push(point);
        bestY = point.y;
      }
    }

    return {
      width,
      height,
      margin,
      innerWidth,
      innerHeight,
      xMin,
      xMax,
      yMin,
      yMax,
      toX,
      toY,
      points: valid,
      pareto,
    };
  }, [points]);

  if (!chart) {
    return (
      <div className={cn("rounded-md border bg-muted/20 p-3 text-xs text-muted-foreground", className)}>
        No points available for this view.
      </div>
    );
  }

  const xTicks = [chart.xMin, (chart.xMin + chart.xMax) / 2, chart.xMax];
  const yTicks = [chart.yMin, (chart.yMin + chart.yMax) / 2, chart.yMax];
  const paretoPath = chart.pareto
    .map((point, idx) => `${idx === 0 ? "M" : "L"} ${chart.toX(point.x)} ${chart.toY(point.y)}`)
    .join(" ");

  return (
    <div className={cn("rounded-md border bg-background/60 p-3", className)} data-testid={dataTestId}>
      <div className="space-y-1">
        <div className="text-sm font-medium">{title}</div>
        {subtitle ? <div className="text-xs text-muted-foreground">{subtitle}</div> : null}
      </div>

      <svg
        viewBox={`0 0 ${chart.width} ${chart.height}`}
        className="mt-3 h-56 w-full"
        role="img"
        aria-label={`${title} frontier chart`}
      >
        <title>{title}</title>

        <line
          x1={chart.margin.left}
          y1={chart.margin.top + chart.innerHeight}
          x2={chart.margin.left + chart.innerWidth}
          y2={chart.margin.top + chart.innerHeight}
          className="stroke-border"
          strokeWidth="1"
        />
        <line
          x1={chart.margin.left}
          y1={chart.margin.top}
          x2={chart.margin.left}
          y2={chart.margin.top + chart.innerHeight}
          className="stroke-border"
          strokeWidth="1"
        />

        {yTicks.map((tick) => {
          const y = chart.toY(tick);
          return (
            <g key={`y-${tick}`}>
              <line
                x1={chart.margin.left}
                y1={y}
                x2={chart.margin.left + chart.innerWidth}
                y2={y}
                className="stroke-muted/40"
                strokeDasharray="3 3"
                strokeWidth="1"
              />
              <text
                x={chart.margin.left - 8}
                y={y + 4}
                textAnchor="end"
                className="fill-muted-foreground text-[10px]"
              >
                {(tick * 100).toFixed(0)}
              </text>
            </g>
          );
        })}

        {xTicks.map((tick) => {
          const x = chart.toX(tick);
          return (
            <g key={`x-${tick}`}>
              <line
                x1={x}
                y1={chart.margin.top}
                x2={x}
                y2={chart.margin.top + chart.innerHeight}
                className="stroke-muted/25"
                strokeDasharray="3 3"
                strokeWidth="1"
              />
              <text
                x={x}
                y={chart.margin.top + chart.innerHeight + 16}
                textAnchor="middle"
                className="fill-muted-foreground text-[10px]"
              >
                {formatXValue(tick)}
              </text>
            </g>
          );
        })}

        {chart.pareto.length >= 2 ? (
          <path
            d={paretoPath}
            fill="none"
            stroke="currentColor"
            strokeWidth="1.5"
            className="text-muted-foreground/50"
          />
        ) : null}

        {chart.points.map((point) => {
          const cx = chart.toX(point.x);
          const cy = chart.toY(point.y);
          const tone = point.tone ?? "default";
          return (
            <g key={point.id}>
              <circle
                cx={cx}
                cy={cy}
                r={tone === "hovered" ? 5.5 : tone === "left" || tone === "right" ? 5 : 3.5}
                className={cn(
                  tone === "hovered" && "fill-foreground",
                  tone === "left" && "fill-sky-500",
                  tone === "right" && "fill-emerald-500",
                  tone === "default" && "fill-primary/70"
                )}
              />
              <title>
                {point.label}: {xLabel} {formatXValue(point.x)}, {(point.y * 100).toFixed(2)}%
              </title>
            </g>
          );
        })}

        <text
          x={chart.margin.left + chart.innerWidth / 2}
          y={chart.height - 8}
          textAnchor="middle"
          className="fill-muted-foreground text-[11px]"
        >
          {xLabel}
        </text>
        <text
          x={12}
          y={chart.margin.top + chart.innerHeight / 2}
          textAnchor="middle"
          transform={`rotate(-90 12 ${chart.margin.top + chart.innerHeight / 2})`}
          className="fill-muted-foreground text-[11px]"
        >
          {yLabel}
        </text>
      </svg>
    </div>
  );
}
