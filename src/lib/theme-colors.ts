const DEFAULT_CHART_PALETTE = [
  "#2563eb", // chart-1 (brand.primary)
  "#db2777", // chart-2 (brand.secondary / competitive)
  "#16a34a", // chart-3 (brand.accent)
  "#0ea5e9", // chart-4 (brand.highlight)
  "#f59e0b", // chart-5
] as const;

const DEFAULT_STATUS_COLORS = {
  running: "#0ea5e9",
  finished: "#22c55e",
  active: "#f59e0b",
  error: "#ef4444",
} as const;

function normalizeVarName(varName: string) {
  return varName.startsWith("--") ? varName : `--${varName}`;
}

function readCssVar(varName: string) {
  if (typeof window === "undefined" || typeof document === "undefined") return null;

  const name = normalizeVarName(varName);
  const value = window
    .getComputedStyle(document.documentElement)
    .getPropertyValue(name)
    .trim();
  return value.length > 0 ? value : null;
}

/**
 * Returns a browser-resolved CSS color string (usually `rgb(...)`).
 *
 * This is safer than consuming raw CSS vars because some themes use `oklch(...)`.
 */
export function resolveCssColor(varName: string, fallback: string) {
  if (typeof window === "undefined" || typeof document === "undefined") return fallback;

  const raw = readCssVar(varName);
  const value = raw ?? fallback;

  // Use a temporary element so the browser resolves modern color syntaxes to `rgb(...)`.
  const el = document.createElement("span");
  el.style.position = "absolute";
  el.style.left = "-9999px";
  el.style.top = "0";
  el.style.color = value;

  // In some early init phases, `document.body` can be null.
  if (!document.body) return value;

  document.body.appendChild(el);
  const computed = window.getComputedStyle(el).color;
  el.remove();

  return computed || value;
}

export function getChartPalette() {
  return [
    resolveCssColor("--chart-1", DEFAULT_CHART_PALETTE[0]),
    resolveCssColor("--chart-2", DEFAULT_CHART_PALETTE[1]),
    resolveCssColor("--chart-3", DEFAULT_CHART_PALETTE[2]),
    resolveCssColor("--chart-4", DEFAULT_CHART_PALETTE[3]),
    resolveCssColor("--chart-5", DEFAULT_CHART_PALETTE[4]),
  ];
}

export function getStatusColors() {
  return {
    running: resolveCssColor("--status-running", DEFAULT_STATUS_COLORS.running),
    finished: resolveCssColor(
      "--status-finished",
      DEFAULT_STATUS_COLORS.finished
    ),
    active: resolveCssColor("--status-active", DEFAULT_STATUS_COLORS.active),
    error: resolveCssColor("--status-error", DEFAULT_STATUS_COLORS.error),
  };
}
