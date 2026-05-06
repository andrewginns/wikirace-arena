import { type ReactNode, useEffect, useMemo, useState } from "react";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { ErrorCallout } from "@/components/ui/callouts";
import { cn } from "@/lib/utils";
import { addViewerDataset, selectViewerDataset } from "@/lib/viewer-datasets";
import {
  firstPricing,
  benchmarkBucketForSlice,
  benchmarkEntryDisplayLabel,
  firstBudgets,
  firstModelSettings,
  isBenchmarkLeaderboardV2,
  isLegacyLeaderboardV1,
  LegacyLeaderboardBucketV1,
  LegacyLeaderboardEntryV1,
  LegacyLeaderboardFileV1,
  LegacyLeaderboardSummaryV1,
  lexicographicCompareBuckets,
  BenchmarkBucketV2,
  BenchmarkBehaviorAnalysis,
  BenchmarkBehaviorExample,
  BenchmarkDiagnosticAnalysis,
  BenchmarkLeaderboardEntryV2,
  BenchmarkLeaderboardFileV2,
  BenchmarkModelSettings,
  BenchmarkBudgets,
  BenchmarkModelNarrative,
  BenchmarkPairwiseNarrative,
} from "@/lib/benchmark-leaderboard";
import { loadViewerTraceDataset } from "@/lib/viewer-trace-loader";
import BenchmarkFrontierChart from "@/components/benchmark-frontier-chart";
import {
  ArrowDown,
  ArrowRightLeft,
  ArrowUp,
  ArrowUpDown,
  ChevronDown,
  Coins,
  ExternalLink,
  Gauge,
  RefreshCw,
  Search,
  Trophy,
  Zap,
} from "lucide-react";

const DEFAULT_LEADERBOARD_URL = "/benchmarks/leaderboard.json";
const OVERALL_BUCKET_ID = "__overall__";
const PASS_RATE_SNAPSHOT_MAX_ROWS = 18;
const PREFERRED_CANONICAL_DATASET_ID = "matchups/frontier_local_simplewiki_standard_v1/all";

const SLICE_LABELS: Record<string, string> = {
  core_rank_v1: "Core tasks",
  diag_bridge_pressure_v1: "Bottleneck links (v1)",
  diag_bridge_pressure_v2: "Bottleneck links (v2)",
  diag_canonical_target_v1: "Canonical page title",
  diag_dead_end_prone_v1: "Dead ends (v1)",
  diag_dead_end_prone_v2: "Dead ends (v2)",
  diag_hub_escape_v1: "Getting off broad pages",
  diag_hub_seek_v1: "Moving toward broad pages",
  diag_target_rarity_v1: "Hard-to-find targets",
  diag_wide_choice_v1: "Many choices",
  route_fragility_v1: "Easy-to-break routes",
  target_rarity_coupled_v1: "Hard-to-find targets under pressure",
};

const PUBLIC_FAMILY_LABELS: Record<string, string> = {
  core_navigation: "Core tasks",
  bridge_pressure: "Bottleneck links",
  dead_end_pressure: "Dead ends",
  route_fragility: "Easy-to-break routes",
  target_rarity: "Hard-to-find targets",
};

type SortDir = "asc" | "desc";
type SortKey =
  | "rank"
  | "model"
  | "score_sum"
  | "win_rate"
  | "wins"
  | "total_runs"
  | "median_hops"
  | "median_hops_over_shortest"
  | "median_tokens"
  | "median_duration_ms"
  | "median_latency_ms"
  | "mean_estimated_cost_usd_all"
  | "mean_loss_cost_usd";

type LeaderboardData = LegacyLeaderboardFileV1 | BenchmarkLeaderboardFileV2;

type TableRow = {
  key: string;
  label: string;
  model: string;
  source: string | null;
  datasetIds: string[];
  suiteIds: string[];
  setupIds: string[];
  bucket: LegacyLeaderboardBucketV1 | BenchmarkBucketV2 | null;
  rank: number | null;
  scoreSum: number | null;
  scoreMean: number | null;
  winRate: number | null;
  wins: number | null;
  totalRuns: number | null;
  medianHops: number | null;
  medianHopsOverShortest: number | null;
  medianTokens: number | null;
  medianDurationMs: number | null;
  medianLatencyMs: number | null;
  meanTokensAll: number | null;
  meanLatencyMsAll: number | null;
  medianEstimatedCostUsd: number | null;
  meanEstimatedCostUsdAll: number | null;
  meanEstimatedCostUsdLoss: number | null;
  scorePerMillionTokens: number | null;
  scorePerDollar: number | null;
  scorePerSecond: number | null;
  meanLossTokens: number | null;
  meanLossLatencyMs: number | null;
  lossReasonText: string;
  configBadges: string[];
  viewerUrl: string | null;
  viewerDatasetName: string;
  viewerSliceId: string | null;
  runKind: "human" | "llm" | null;
  behavior: BenchmarkBehaviorAnalysis | null;
  diagnostics: BenchmarkDiagnosticAnalysis | null;
  pricingSourceUrl: string | null;
  pricingCapturedAt: string | null;
};

type PairwiseMetricRow = {
  key: string;
  label: string;
  left: number | null;
  right: number | null;
  better: "higher" | "lower";
  format: "percent" | "number" | "duration" | "usd";
  digits?: number;
};

type FrontierPointRow = {
  id: string;
  label: string;
  tokens: number | null;
  priceUsd: number | null;
  latencyMs: number | null;
  winRate: number | null;
  tone: "default" | "hovered" | "left" | "right";
};

type KpiCardTone = "quality" | "tokens" | "price" | "speed";

type GroupedFamilyCount = {
  key: string;
  label: string;
  count: number;
};

type CompositionCount = {
  key: string;
  label: string;
  count: number;
};

type LossReasonCount = {
  key: string;
  label: string;
  count: number;
  share: number;
};

type BenchmarkExampleTask = {
  suiteId: string;
  start: string;
  target: string;
  sliceId: string;
  shortestPath: string[];
  modelExample?: {
    modelLabel: string;
    result: "win" | "lose";
    stepCount: number;
    path: string[];
  };
};

const BEHAVIOR_METRIC_ROWS: Array<{
  key: keyof BenchmarkBehaviorAnalysis;
  label: string;
}> = [
  { key: "mean_attempt_count", label: "Average tries" },
  { key: "retry_step_rate", label: "Retry rate" },
  { key: "revisit_rate", label: "Backtrack rate" },
  { key: "hub_move_rate", label: "Moves to broad pages" },
  { key: "dead_end_move_rate", label: "Moves into dead ends" },
  { key: "bad_answer_step_rate", label: "Invalid answer rate" },
];

const BENCHMARK_EXAMPLE_TASKS: Record<string, BenchmarkExampleTask> = {
  frontier_local_simplewiki_standard_v1: {
    suiteId: "frontier_local_simplewiki_standard_v1",
    start: "Fort Mitchell, Alabama",
    target: "Sho (letter)",
    sliceId: "core_rank_v1",
    shortestPath: [
      "Fort Mitchell, Alabama",
      "United States",
      "American English",
      "English alphabet",
      "Thorn (letter)",
      "Sho (letter)",
    ],
    modelExample: {
      modelLabel: "gpt-5.1 low",
      result: "lose",
      stepCount: 20,
      path: [
        "Fort Mitchell, Alabama",
        "United States",
        "Asia",
        "Georgia (country)",
        "Georgian alphabet",
        "Georgian language",
        "Indo-European languages",
        "Latin script",
        "Cyrillic script",
        "Short I",
        "List of Cyrillic-script letters",
        "Sha (Cyrillic)",
        "List of Cyrillic-script letters",
        "Cyrillic script",
        "Short I",
        "Cyrillic script",
        "Yo (Cyrillic)",
        "List of Cyrillic-script letters",
        "Sha (Cyrillic)",
        "Hebrew language",
      ],
    },
  },
};

function safeNumber(value: unknown): number | null {
  if (typeof value !== "number") return null;
  if (!Number.isFinite(value)) return null;
  return value;
}

function safeString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value : null;
}

function formatNumber(value: number | null, digits: number = 0) {
  if (typeof value !== "number") return "—";
  return new Intl.NumberFormat(undefined, { maximumFractionDigits: digits }).format(
    value
  );
}

function formatPercent(rate: number | null) {
  if (typeof rate !== "number") return "—";
  return `${(rate * 100).toFixed(1)}%`;
}

function formatDurationMs(ms: number | null) {
  if (typeof ms !== "number") return "—";
  if (ms < 1000) return `${formatNumber(ms, 0)}ms`;
  return `${formatNumber(ms / 1000, 0)}s`;
}

function formatUsd(value: number | null) {
  if (typeof value !== "number") return "—";
  const digits = value >= 1 ? 2 : value >= 0.1 ? 3 : 4;
  return new Intl.NumberFormat(undefined, {
    style: "currency",
    currency: "USD",
    maximumFractionDigits: digits,
    minimumFractionDigits: value < 1 ? Math.min(digits, 2) : 2,
  }).format(value);
}

function formatCompactUsd(value: number | null) {
  if (typeof value !== "number") return "—";
  const digits = value >= 1 ? 2 : value >= 0.1 ? 3 : 4;
  return new Intl.NumberFormat(undefined, {
    style: "currency",
    currency: "USD",
    maximumFractionDigits: digits,
  }).format(value);
}

function formatSignedNumber(value: number | null, digits: number = 1) {
  if (typeof value !== "number") return "—";
  const sign = value > 0 ? "+" : "";
  return `${sign}${value.toFixed(digits)}`;
}

function formatSignedPercentPoints(value: number | null) {
  if (typeof value !== "number") return "—";
  const sign = value > 0 ? "+" : "";
  return `${sign}${(value * 100).toFixed(1)} pts`;
}

function formatSignedUsd(value: number | null) {
  if (typeof value !== "number") return "—";
  const sign = value > 0 ? "+" : "";
  return `${sign}${formatCompactUsd(Math.abs(value))}`;
}

function formatSignedDurationMs(value: number | null) {
  if (typeof value !== "number") return "—";
  const sign = value > 0 ? "+" : "";
  if (Math.abs(value) < 1000) return `${sign}${Math.round(value)}ms`;
  return `${sign}${(value / 1000).toFixed(1)}s`;
}

function formatRatio(value: number | null) {
  if (typeof value !== "number") return "—";
  return `${value.toFixed(value >= 10 ? 1 : 2)}x`;
}

function formatDateLabel(value: string | null) {
  if (!value) return null;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
  }).format(date);
}

function displaySliceLabel(sliceId: string | null | undefined) {
  if (!sliceId) return "—";
  return SLICE_LABELS[sliceId] || sliceId;
}

function safeDivide(numerator: number | null, denominator: number | null) {
  if (typeof numerator !== "number" || typeof denominator !== "number") return null;
  if (!Number.isFinite(numerator) || !Number.isFinite(denominator) || denominator <= 0) return null;
  return numerator / denominator;
}

function publicFamilyKey(sliceId: string) {
  if (sliceId === "core_rank_v1") return "core_navigation";
  if (sliceId.startsWith("diag_bridge_pressure_")) return "bridge_pressure";
  if (sliceId.startsWith("diag_dead_end_prone_")) return "dead_end_pressure";
  if (sliceId === "route_fragility_v1") return "route_fragility";
  if (sliceId === "diag_target_rarity_v1" || sliceId === "target_rarity_coupled_v1") {
    return "target_rarity";
  }
  return sliceId;
}

function groupedFamilyCounts(
  value: Record<string, number> | null | undefined
): GroupedFamilyCount[] {
  if (!value || typeof value !== "object") return [];
  const counts = new Map<string, number>();
  for (const [sliceId, rawCount] of Object.entries(value)) {
    if (typeof rawCount !== "number" || !Number.isFinite(rawCount) || rawCount <= 0) continue;
    const key = publicFamilyKey(sliceId);
    counts.set(key, (counts.get(key) ?? 0) + rawCount);
  }
  return [...counts.entries()]
    .map(([key, count]) => ({
      key,
      label: PUBLIC_FAMILY_LABELS[key] || displaySliceLabel(key),
      count,
    }))
    .sort((left, right) => right.count - left.count || left.label.localeCompare(right.label));
}

function compositionLabel(key: string) {
  if (key === "hard99") return "Hard99 controller-hard";
  if (key === "companion101") return "Companion101 structural";
  return key.replaceAll("_", " ");
}

function compositionCounts(
  value: Record<string, number> | null | undefined
): CompositionCount[] {
  if (!value || typeof value !== "object") return [];
  return Object.entries(value)
    .filter(([, rawCount]) => typeof rawCount === "number" && Number.isFinite(rawCount) && rawCount > 0)
    .map(([key, count]) => ({
      key,
      label: compositionLabel(key),
      count,
    }))
    .sort((left, right) => right.count - left.count || left.label.localeCompare(right.label));
}

function lossReasonLabel(reason: string) {
  if (reason === "max_steps") return "Step limit";
  if (reason === "llm_error") return "LLM error";
  return reason.replaceAll("_", " ");
}

function formatPathSequence(path: string[], head: number = 6, tail: number = 2) {
  if (path.length <= head + tail) return path.join(" → ");
  return [...path.slice(0, head), "…", ...path.slice(-tail)].join(" → ");
}

function humanizeUiCopy(value: string | null | undefined) {
  if (!value) return value || "";
  return [
    ["Loop and wrong-basin recovery", "Recovering from wrong turns"],
    ["Bridge pressure", "Bottleneck links"],
    ["Route fragility", "Easy-to-break routes"],
    ["Target rarity under pressure", "Hard-to-find targets under pressure"],
    ["Dead-end management", "Handling dead ends"],
    ["bounded search control", "staying on track within the step limit"],
    ["wrong local node", "wrong nearby page"],
    ["choke, corridor, and recovery failures", "bottlenecks, narrow routes, and recovery failures"],
    ["fragile routes", "easy-to-break routes"],
    ["bridge pressure", "bottleneck links"],
    ["dead-end pressure", "dead ends"],
    ["wrong-basin", "wrong topic area"],
    ["exact target closure", "reaching the exact target"],
    ["LLM latency", "model response time"],
    ["slice breakdowns", "task-group breakdowns"],
    ["slice profile", "task-group profile"],
    ["current slice", "current view"],
    ["slices", "task groups"],
    ["slice", "task group"],
    ["revisit", "backtrack"],
    ["pass rate", "success rate"],
    ["win rate", "success rate"],
  ].reduce((out, [from, to]) => out.replaceAll(from, to), value);
}

function normalizePairwiseModels(left: string, right: string) {
  return [left, right].sort((a, b) => a.localeCompare(b)).join("::");
}

function getPairwiseNarrative(
  value: BenchmarkPairwiseNarrative[] | null | undefined,
  leftModel: string,
  rightModel: string
) {
  if (!Array.isArray(value)) return null;
  const targetKey = normalizePairwiseModels(leftModel, rightModel);
  return (
    value.find((item) => {
      const models = Array.isArray(item?.models)
        ? item.models.filter((model): model is string => typeof model === "string" && model.trim().length > 0)
        : [];
      if (models.length !== 2) return false;
      return normalizePairwiseModels(models[0]!, models[1]!) === targetKey;
    }) ?? null
  );
}

function defaultSortDir(sortKey: SortKey): SortDir {
  switch (sortKey) {
    case "rank":
    case "model":
    case "median_hops":
    case "median_hops_over_shortest":
    case "median_tokens":
    case "median_duration_ms":
    case "median_latency_ms":
    case "mean_estimated_cost_usd_all":
    case "mean_loss_cost_usd":
      return "asc";
    default:
      return "desc";
  }
}

function toggleSort(nextKey: SortKey, currentKey: SortKey, currentDir: SortDir): SortDir {
  if (nextKey !== currentKey) return defaultSortDir(nextKey);
  return currentDir === "desc" ? "asc" : "desc";
}

function compareNullableNumbers(a: number | null, b: number | null, dir: SortDir) {
  const aVal = typeof a === "number" ? a : null;
  const bVal = typeof b === "number" ? b : null;
  if (aVal === null && bVal === null) return 0;
  if (aVal === null) return 1;
  if (bVal === null) return -1;
  return dir === "desc" ? bVal - aVal : aVal - bVal;
}

function sortIcon(isActive: boolean, dir: SortDir) {
  if (!isActive) return <ArrowUpDown className="h-4 w-4 text-muted-foreground" />;
  return dir === "desc" ? (
    <ArrowDown className="h-4 w-4" />
  ) : (
    <ArrowUp className="h-4 w-4" />
  );
}

function metricMedian(metric: { median?: number | null } | null | undefined) {
  return typeof metric?.median === "number" ? metric.median : null;
}

function extractLegacyDatasetIds(entry: LegacyLeaderboardEntryV1): string[] {
  const ids = entry.summary?.meta?.dataset_ids;
  return Array.isArray(ids) ? ids.filter((v) => typeof v === "string" && v.trim()) : [];
}

function extractV2DatasetIds(entry: BenchmarkLeaderboardEntryV2): string[] {
  const ids = entry.summary?.meta?.dataset_ids;
  return Array.isArray(ids) ? ids.filter((v) => typeof v === "string" && v.trim()) : [];
}

function extractV2SetupIds(entry: BenchmarkLeaderboardEntryV2): string[] {
  const ids = entry.summary?.meta?.setup_ids;
  return Array.isArray(ids) ? ids.filter((v) => typeof v === "string" && v.trim()) : [];
}

function getLegacyBucket(summary: LegacyLeaderboardSummaryV1, bucketId: string) {
  if (bucketId === OVERALL_BUCKET_ID) return summary.overall;
  return summary.tiers?.[bucketId] || null;
}

function buildConfigBadges({
  modelSettings,
  budgets,
}: {
  modelSettings: BenchmarkModelSettings | null;
  budgets: BenchmarkBudgets | null;
}): string[] {
  const out: string[] = [];

  if (modelSettings?.run_kind === "human") out.push("human");

  const effort = safeString(modelSettings?.openai_reasoning_effort);
  if (effort) out.push(`effort:${effort}`);

  const setupMode = safeString(modelSettings?.openai_api_mode);
  if (setupMode) out.push(`api_mode:${setupMode}`);

  const maxLinks = safeNumber(budgets?.max_links);
  if (typeof maxLinks === "number") out.push(`links:${formatNumber(maxLinks)}`);

  const maxTokens = safeNumber(budgets?.max_tokens);
  if (typeof maxTokens === "number") out.push(`tokens:${formatNumber(maxTokens)}`);

  const apiBase = safeString(modelSettings?.api_base);
  if (apiBase) out.push("api_base");

  return out;
}

function topRowsByWinRate(rows: TableRow[]) {
  return [...rows]
    .sort((left, right) => {
      const winDiff = (right.winRate ?? 0) - (left.winRate ?? 0);
      if (Math.abs(winDiff) > 1e-12) return winDiff;
      const rankDiff = (left.rank ?? Number.POSITIVE_INFINITY) - (right.rank ?? Number.POSITIVE_INFINITY);
      if (rankDiff !== 0) return rankDiff;
      return left.label.localeCompare(right.label);
    })
    .slice(0, PASS_RATE_SNAPSHOT_MAX_ROWS);
}

function formatExamplePreview(value: string | null | undefined) {
  if (!value) return "—";
  const compact = value.replace(/\s+/g, " ").trim();
  return compact.length > 220 ? `${compact.slice(0, 220)}…` : compact;
}

function compareRows(a: TableRow, b: TableRow, sortKey: SortKey, sortDir: SortDir) {
  let cmp = 0;
  switch (sortKey) {
    case "rank":
      cmp = compareNullableNumbers(a.rank, b.rank, sortDir);
      break;
    case "model":
      cmp = a.model.localeCompare(b.model);
      if (sortDir === "desc") cmp *= -1;
      break;
    case "score_sum":
      cmp = compareNullableNumbers(a.scoreSum, b.scoreSum, sortDir);
      break;
    case "win_rate":
      cmp = compareNullableNumbers(a.winRate, b.winRate, sortDir);
      break;
    case "wins":
      cmp = compareNullableNumbers(a.wins, b.wins, sortDir);
      break;
    case "total_runs":
      cmp = compareNullableNumbers(a.totalRuns, b.totalRuns, sortDir);
      break;
    case "median_hops":
      cmp = compareNullableNumbers(a.medianHops, b.medianHops, sortDir);
      break;
    case "median_hops_over_shortest":
      cmp = compareNullableNumbers(a.medianHopsOverShortest, b.medianHopsOverShortest, sortDir);
      break;
    case "median_tokens":
      cmp = compareNullableNumbers(a.medianTokens, b.medianTokens, sortDir);
      break;
    case "median_duration_ms":
      cmp = compareNullableNumbers(a.medianDurationMs, b.medianDurationMs, sortDir);
      break;
    case "median_latency_ms":
      cmp = compareNullableNumbers(a.medianLatencyMs, b.medianLatencyMs, sortDir);
      break;
    case "mean_estimated_cost_usd_all":
      cmp = compareNullableNumbers(a.meanEstimatedCostUsdAll, b.meanEstimatedCostUsdAll, sortDir);
      break;
    case "mean_loss_cost_usd":
      cmp = compareNullableNumbers(a.meanEstimatedCostUsdLoss, b.meanEstimatedCostUsdLoss, sortDir);
      break;
    default:
      cmp = 0;
  }
  if (cmp !== 0) return cmp;
  const aRank = a.rank ?? Number.POSITIVE_INFINITY;
  const bRank = b.rank ?? Number.POSITIVE_INFINITY;
  if (aRank !== bRank) return aRank - bRank;
  return a.model.localeCompare(b.model);
}

function toneClassNames(tone: KpiCardTone) {
  switch (tone) {
    case "quality":
      return "border-sky-200 bg-sky-50/80 text-sky-950";
    case "tokens":
      return "border-teal-200 bg-teal-50/80 text-teal-950";
    case "price":
      return "border-emerald-200 bg-emerald-50/80 text-emerald-950";
    case "speed":
      return "border-amber-200 bg-amber-50/80 text-amber-950";
    default:
      return "border-border bg-background text-foreground";
  }
}

function KpiCard({
  label,
  model,
  value,
  caption,
  tone,
  icon,
}: {
  label: string;
  model: string;
  value: string;
  caption: string;
  tone: KpiCardTone;
  icon: ReactNode;
}) {
  return (
    <div className={cn("rounded-xl border p-4 shadow-sm", toneClassNames(tone))}>
      <div className="flex items-start justify-between gap-3">
        <div>
          <div className="text-[11px] font-semibold uppercase tracking-[0.18em] text-current/70">
            {label}
          </div>
          <div className="mt-2 text-base font-semibold">{model}</div>
        </div>
        <div className="rounded-full border border-current/15 bg-white/70 p-2 text-current">
          {icon}
        </div>
      </div>
      <div className="mt-6 font-mono text-2xl font-semibold">{value}</div>
      <div className="mt-1 text-xs text-current/75">{caption}</div>
    </div>
  );
}

function PairwiseDeltaCard({
  label,
  delta,
  body,
  tone,
}: {
  label: string;
  delta: string;
  body: string;
  tone: "neutral" | "left" | "right";
}) {
  return (
    <div
      className={cn(
        "rounded-xl border p-3",
        tone === "left" && "border-sky-200 bg-sky-50/70",
        tone === "right" && "border-emerald-200 bg-emerald-50/70",
        tone === "neutral" && "border-border bg-muted/20"
      )}
    >
      <div className="text-[11px] uppercase tracking-[0.16em] text-muted-foreground">{label}</div>
      <div className="mt-2 font-mono text-xl font-semibold">{delta}</div>
      <div className="mt-1 text-xs text-muted-foreground">{body}</div>
    </div>
  );
}

function pickBestRow(rows: TableRow[], selector: (row: TableRow) => number | null) {
  return [...rows]
    .filter((row) => typeof selector(row) === "number")
    .sort((left, right) => (selector(right) ?? Number.NEGATIVE_INFINITY) - (selector(left) ?? Number.NEGATIVE_INFINITY))[0] ?? null;
}

function pairwiseWinner(
  left: number | null,
  right: number | null,
  better: "higher" | "lower"
): "left" | "right" | "tie" | null {
  if (typeof left !== "number" || typeof right !== "number") return null;
  if (Math.abs(left - right) < 1e-12) return "tie";
  if (better === "higher") return left > right ? "left" : "right";
  return left < right ? "left" : "right";
}

export default function LeaderboardTab({
  onOpenViewer,
}: {
  onOpenViewer?: () => void;
}) {
  const [status, setStatus] = useState<"idle" | "loading" | "loaded" | "error">("idle");
  const [loadToken, setLoadToken] = useState(0);
  const [data, setData] = useState<LeaderboardData | null>(null);
  const [error, setError] = useState<string | null>(null);

  const [datasetFilter, setDatasetFilter] = useState<string>("__all__");
  const [bucketFilter, setBucketFilter] = useState<string>(OVERALL_BUCKET_ID);
  const [setupFilter, setSetupFilter] = useState<string>("__all__");
  const [query, setQuery] = useState("");

  const [sortKey, setSortKey] = useState<SortKey>("rank");
  const [sortDir, setSortDir] = useState<SortDir>("asc");
  const [hoveredRowKey, setHoveredRowKey] = useState<string | null>(null);
  const [selectedRowKey, setSelectedRowKey] = useState<string | null>(null);
  const [compareLeftKey, setCompareLeftKey] = useState<string | null>(null);
  const [compareRightKey, setCompareRightKey] = useState<string | null>(null);
  const [viewerLoadingKey, setViewerLoadingKey] = useState<string | null>(null);
  const [viewerError, setViewerError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    const controller = new AbortController();

    async function load() {
      setStatus("loading");
      setError(null);
      try {
        const res = await fetch(DEFAULT_LEADERBOARD_URL, { signal: controller.signal });
        if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
        const raw = (await res.json()) as unknown;
        if (!isBenchmarkLeaderboardV2(raw) && !isLegacyLeaderboardV1(raw)) {
          throw new Error("Invalid leaderboard JSON");
        }
        if (cancelled) return;

        setData(raw);
        setStatus("loaded");
        setViewerError(null);

        const datasetIds = isBenchmarkLeaderboardV2(raw)
          ? raw.available_dataset_ids ?? []
          : [...new Set(raw.entries.flatMap((entry) => extractLegacyDatasetIds(entry)))].sort();
        const preferredDataset =
          safeString(raw.dataset_filter) ||
          (datasetIds.includes(PREFERRED_CANONICAL_DATASET_ID)
            ? PREFERRED_CANONICAL_DATASET_ID
            : datasetIds.includes("matchups/v1")
              ? "matchups/v1"
              : datasetIds[0] || "__all__");
        setDatasetFilter(preferredDataset || "__all__");

        if (isBenchmarkLeaderboardV2(raw)) {
          setBucketFilter(OVERALL_BUCKET_ID);
          const setupIds = raw.available_setup_ids ?? [];
          setSetupFilter(setupIds.length > 1 ? "__all__" : setupIds[0] || "__all__");
          setSortKey("rank");
          setSortDir("asc");
        } else {
          setBucketFilter(OVERALL_BUCKET_ID);
          setSetupFilter("__all__");
          setSortKey("rank");
          setSortDir("asc");
        }
      } catch (e) {
        if (cancelled) return;
        setStatus("error");
        setError(e instanceof Error ? e.message : "Failed to load leaderboard");
      }
    }

    load();
    return () => {
      cancelled = true;
      controller.abort();
    };
  }, [loadToken]);

  const isV2 = isBenchmarkLeaderboardV2(data);

  const availableBucketChoices = useMemo(() => {
    if (!data) return [];
    if (isBenchmarkLeaderboardV2(data)) {
      const sliceIds = data.available_slice_ids ?? [];
      return [{ value: OVERALL_BUCKET_ID, label: "Overall" }].concat(
        sliceIds.map((sliceId) => ({ value: sliceId, label: displaySliceLabel(sliceId) }))
      );
    }

    const legacyTierIds = data.entries.flatMap((entry) => Object.keys(entry.summary?.tiers ?? {}));
    const deduped = [...new Set(legacyTierIds)].sort();
    return [{ value: OVERALL_BUCKET_ID, label: "Overall" }].concat(
      deduped.map((tierId) => ({ value: tierId, label: tierId }))
    );
  }, [data]);

  const availableSetupIds = useMemo(() => {
    if (!data || !isBenchmarkLeaderboardV2(data)) return [];
    return data.available_setup_ids ?? [];
  }, [data]);

  const suiteDetails = useMemo(() => {
    if (!data || !isBenchmarkLeaderboardV2(data)) return {};
    return data.suite_details ?? {};
  }, [data]);

  const rows = useMemo(() => {
    if (!data) return [];
    const q = query.trim().toLowerCase();

    if (isBenchmarkLeaderboardV2(data)) {
      const selectedSliceId = bucketFilter === OVERALL_BUCKET_ID ? null : bucketFilter;
      const filteredEntries = data.entries.filter((entry) => {
        const datasetIds = extractV2DatasetIds(entry);
        if (datasetFilter !== "__all__" && !datasetIds.includes(datasetFilter)) return false;

        const setupIds = extractV2SetupIds(entry);
        if (setupFilter !== "__all__" && !setupIds.includes(setupFilter)) return false;

        if (!q) return true;
        const source = safeString(entry.source_jsonl)?.toLowerCase() || "";
        const model = benchmarkEntryDisplayLabel(entry).toLowerCase();
        return model.includes(q) || source.includes(q);
      });

      const rankingRows = filteredEntries
        .map((entry, idx) => {
          const label = benchmarkEntryDisplayLabel(entry);
          const entryKey = `${safeString(entry.source_jsonl) || label}:${idx}`;
          const bucket = benchmarkBucketForSlice(entry.summary, selectedSliceId);
          return {
            entry,
            label,
            entryKey,
            bucket,
          };
        })
        .filter(
          (
            item
          ): item is {
            entry: BenchmarkLeaderboardEntryV2;
            label: string;
            entryKey: string;
            bucket: NonNullable<ReturnType<typeof benchmarkBucketForSlice>>;
          } => item.bucket !== null
        )
        .sort((left, right) =>
          lexicographicCompareBuckets(left.bucket, right.bucket, left.label, right.label)
        );

      const rankByKey = new Map<string, number>();
      for (let i = 0; i < rankingRows.length; i += 1) {
        rankByKey.set(rankingRows[i]!.entryKey, i + 1);
      }

      const resultRows = rankingRows.map(({ entry, label, entryKey, bucket }) => {
        const settings = firstModelSettings(entry.summary?.meta?.model_settings);
        const budgets = firstBudgets(entry.summary?.meta?.budgets);
        const pricing = firstPricing(entry.summary?.meta?.pricing);
        const lossReasons = bucket.loss_reasons ?? {};
        const lossReasonText =
          Object.entries(lossReasons)
            .map(([reason, count]) => `${reason}=${count}`)
            .join(", ") || "—";
        const scoreMean = safeNumber(bucket.legacy_score_v1_mean ?? bucket.score_mean ?? null);
        const meanTokensAll = safeNumber(bucket.mean_total_tokens_all ?? null);
        const meanLatencyMsAll = safeNumber(bucket.mean_llm_latency_ms_all ?? null);
        const medianEstimatedCostUsd = metricMedian(bucket.estimated_cost_usd_win);
        const meanEstimatedCostUsdAll = safeNumber(bucket.mean_estimated_cost_usd_all ?? null);
        const meanEstimatedCostUsdLoss = safeNumber(bucket.mean_estimated_cost_usd_loss ?? null);

        return {
          key: entryKey,
          label,
          model: label,
          source: safeString(entry.source_jsonl) || null,
          datasetIds: extractV2DatasetIds(entry),
          suiteIds:
            Array.isArray(entry.summary?.meta?.suite_ids)
              ? entry.summary.meta.suite_ids.filter((value): value is string => typeof value === "string" && value.trim().length > 0)
              : [],
          setupIds: extractV2SetupIds(entry),
          bucket,
          rank: rankByKey.get(entryKey) ?? null,
          scoreSum: safeNumber(bucket.legacy_score_v1_sum ?? bucket.score_sum ?? null),
          scoreMean,
          winRate: safeNumber(bucket.win_rate),
          wins: safeNumber(bucket.wins),
          totalRuns: safeNumber(bucket.total_runs),
          medianHops: metricMedian(bucket.hops_win),
          medianHopsOverShortest: metricMedian(bucket.hops_over_shortest_win),
          medianTokens: metricMedian(bucket.total_tokens_win),
          medianDurationMs: metricMedian(bucket.duration_ms_win),
          medianLatencyMs: metricMedian(bucket.llm_latency_ms_win),
          meanTokensAll,
          meanLatencyMsAll,
          medianEstimatedCostUsd,
          meanEstimatedCostUsdAll,
          meanEstimatedCostUsdLoss,
          scorePerMillionTokens: safeDivide(
            typeof scoreMean === "number" ? scoreMean * 1_000_000 : null,
            meanTokensAll
          ),
          scorePerDollar: safeDivide(scoreMean, meanEstimatedCostUsdAll),
          scorePerSecond: safeDivide(
            scoreMean,
            typeof meanLatencyMsAll === "number" ? meanLatencyMsAll / 1000 : null
          ),
          meanLossTokens: safeNumber(bucket.mean_total_tokens_loss ?? null),
          meanLossLatencyMs: safeNumber(bucket.mean_llm_latency_ms_loss ?? null),
          lossReasonText,
          configBadges: buildConfigBadges({ modelSettings: settings, budgets }),
          viewerUrl: safeString(entry.viewer_url) || null,
          viewerDatasetName:
            bucketFilter === OVERALL_BUCKET_ID
              ? `${label} benchmark runs`
              : `${label} ${bucketFilter} runs`,
          viewerSliceId: selectedSliceId,
          runKind: settings?.run_kind === "human" || settings?.run_kind === "llm" ? settings.run_kind : null,
          behavior:
            bucketFilter === OVERALL_BUCKET_ID
              ? entry.summary?.analysis?.overall ?? null
              : entry.summary?.analysis?.slices?.[bucketFilter] ?? null,
          diagnostics: entry.summary?.analysis?.diagnostics ?? null,
          pricingSourceUrl: safeString(pricing?.source_url) || null,
          pricingCapturedAt: safeString(pricing?.captured_at) || null,
        } satisfies TableRow;
      });

      return [...resultRows].sort((left, right) => compareRows(left, right, sortKey, sortDir));
    }

    const filtered = data.entries.filter((entry) => {
      const datasetIds = extractLegacyDatasetIds(entry);
      if (datasetFilter !== "__all__" && !datasetIds.includes(datasetFilter)) return false;
      if (!q) return true;
      const model =
        safeString(entry.summary?.meta?.model_settings?.model)?.toLowerCase() ||
        entry.label.toLowerCase();
      const source = safeString(entry.summary?.source_jsonl)?.toLowerCase() || "";
      return model.includes(q) || source.includes(q);
    });

    const resultRows = filtered.map((entry, idx) => {
      const bucket = getLegacyBucket(entry.summary, bucketFilter);
      const modelSettings = entry.summary?.meta?.model_settings ?? null;
      const budgets = entry.summary?.meta?.budgets ?? null;
      const label =
        safeString(modelSettings?.model) || safeString(entry.label) || `entry-${idx + 1}`;

      return {
        key: `${safeString(entry.summary?.source_jsonl) || label}:${idx}`,
        label,
        model: label,
        source: safeString(entry.summary?.source_jsonl) || null,
        datasetIds: extractLegacyDatasetIds(entry),
        suiteIds: [],
        setupIds: [],
        bucket,
        rank: safeNumber(entry.rank) ?? null,
        scoreSum: safeNumber(bucket?.score_sum),
        scoreMean: safeNumber(bucket?.score_mean),
        winRate: safeNumber(bucket?.win_rate),
        wins: safeNumber(bucket?.wins),
        totalRuns: safeNumber(bucket?.total_runs),
        medianHops: metricMedian(bucket?.hops_win),
        medianHopsOverShortest: null,
        medianTokens: metricMedian(bucket?.total_tokens_win),
        medianDurationMs: metricMedian(bucket?.duration_ms_win),
        medianLatencyMs: null,
        meanTokensAll: null,
        meanLatencyMsAll: null,
        medianEstimatedCostUsd: null,
        meanEstimatedCostUsdAll: null,
        meanEstimatedCostUsdLoss: null,
        scorePerMillionTokens: null,
        scorePerDollar: null,
        scorePerSecond: null,
        meanLossTokens: null,
        meanLossLatencyMs: null,
        lossReasonText: "—",
        configBadges: buildConfigBadges({ modelSettings, budgets }),
        viewerUrl: null,
        viewerDatasetName: label,
        viewerSliceId: null,
        runKind: null,
        behavior: null,
        diagnostics: null,
        pricingSourceUrl: null,
        pricingCapturedAt: null,
      } satisfies TableRow;
    });

    return [...resultRows].sort((left, right) => compareRows(left, right, sortKey, sortDir));
  }, [bucketFilter, data, datasetFilter, query, setupFilter, sortDir, sortKey]);

  const topPassRows = useMemo(() => topRowsByWinRate(rows), [rows]);

  useEffect(() => {
    if (rows.length === 0) {
      setSelectedRowKey(null);
      return;
    }
    if (selectedRowKey && rows.some((row) => row.key === selectedRowKey)) return;
    setSelectedRowKey(rows[0]?.key ?? null);
  }, [rows, selectedRowKey]);

  useEffect(() => {
    if (rows.length === 0) {
      setCompareLeftKey(null);
      setCompareRightKey(null);
      return;
    }
    const nextLeft =
      compareLeftKey && rows.some((row) => row.key === compareLeftKey)
        ? compareLeftKey
        : rows[0]?.key ?? null;
    let nextRight =
      compareRightKey && rows.some((row) => row.key === compareRightKey)
        ? compareRightKey
        : rows.find((row) => row.key !== nextLeft)?.key ?? rows[0]?.key ?? null;
    if (nextRight === nextLeft) {
      nextRight = rows.find((row) => row.key !== nextLeft)?.key ?? nextLeft;
    }

    if (nextLeft !== compareLeftKey) setCompareLeftKey(nextLeft);
    if (nextRight !== compareRightKey) setCompareRightKey(nextRight);
  }, [compareLeftKey, compareRightKey, rows]);

  const focusedRow = useMemo(() => {
    const hovered = hoveredRowKey ? rows.find((row) => row.key === hoveredRowKey) : null;
    if (hovered) return hovered;
    const selected = selectedRowKey ? rows.find((row) => row.key === selectedRowKey) : null;
    if (selected) return selected;
    return rows[0] ?? null;
  }, [hoveredRowKey, rows, selectedRowKey]);

  const focusedDiagnosticSlices = useMemo(
    () =>
      ((focusedRow?.diagnostics?.slices ?? {}) as Record<
        string,
        { win_rate?: number | null; delta_vs_core?: number | null }
      >),
    [focusedRow]
  );

  const focusedExamples = useMemo(
    () =>
      ((focusedRow?.behavior?.examples ?? {}) as Record<
        string,
        BenchmarkBehaviorExample
      >),
    [focusedRow]
  );

  const focusedSuiteDetail = useMemo(() => {
    const suiteId = focusedRow?.suiteIds?.[0] || Object.keys(suiteDetails)[0];
    if (!suiteId) return null;
    return suiteDetails[suiteId] ?? null;
  }, [focusedRow, suiteDetails]);

  const focusedSuiteId = useMemo(
    () => focusedRow?.suiteIds?.[0] || Object.keys(suiteDetails)[0] || null,
    [focusedRow, suiteDetails]
  );

  const focusedSuiteStatus = useMemo(() => {
    if (!focusedSuiteDetail) return null;
    return focusedSuiteDetail.is_seeded_fallback ? "provisional" : "graph-native";
  }, [focusedSuiteDetail]);

  const focusedSuiteFamilies = useMemo(
    () => groupedFamilyCounts(focusedSuiteDetail?.family_counts),
    [focusedSuiteDetail]
  );

  const focusedSuiteComposition = useMemo(
    () => compositionCounts(focusedSuiteDetail?.composition),
    [focusedSuiteDetail]
  );

  const focusedModelSummaries = useMemo(
    () =>
      ((focusedSuiteDetail?.model_summaries ?? {}) as Record<string, BenchmarkModelNarrative>),
    [focusedSuiteDetail]
  );

  const benchmarkExampleTask = useMemo(() => {
    if (!focusedSuiteId) return null;
    return BENCHMARK_EXAMPLE_TASKS[focusedSuiteId] ?? null;
  }, [focusedSuiteId]);

  const compareLeftRow = useMemo(
    () => (compareLeftKey ? rows.find((row) => row.key === compareLeftKey) ?? null : null),
    [compareLeftKey, rows]
  );

  const compareRightRow = useMemo(
    () => (compareRightKey ? rows.find((row) => row.key === compareRightKey) ?? null : null),
    [compareRightKey, rows]
  );

  const comparePairwiseNarrative = useMemo(() => {
    if (!compareLeftRow || !compareRightRow) return null;
    return getPairwiseNarrative(
      focusedSuiteDetail?.pairwise_summaries,
      compareLeftRow.model,
      compareRightRow.model
    );
  }, [compareLeftRow, compareRightRow, focusedSuiteDetail]);

  const frontierPoints = useMemo<FrontierPointRow[]>(() => {
    return rows.map((row) => {
      const tone: FrontierPointRow["tone"] =
        hoveredRowKey === row.key
          ? "hovered"
          : compareLeftKey === row.key
            ? "left"
            : compareRightKey === row.key
              ? "right"
              : "default";

      return {
        id: row.key,
        label: row.label,
        tokens: row.medianTokens,
        priceUsd: row.meanEstimatedCostUsdAll,
        latencyMs: row.medianLatencyMs,
        winRate: row.winRate,
        tone,
      };
    });
  }, [compareLeftKey, compareRightKey, hoveredRowKey, rows]);

  const lossSpendRows = useMemo(() => {
    return [...rows]
      .filter((row) => typeof row.meanEstimatedCostUsdLoss === "number")
      .sort(
        (left, right) =>
          (right.meanEstimatedCostUsdLoss ?? 0) - (left.meanEstimatedCostUsdLoss ?? 0)
      )
      .slice(0, 6);
  }, [rows]);

  const lossReasonSummary = useMemo(() => {
    const counts = new Map<string, number>();
    for (const row of rows) {
      const lossReasons =
        row.bucket && "loss_reasons" in row.bucket ? row.bucket.loss_reasons : {};
      for (const [reason, rawCount] of Object.entries(lossReasons)) {
        if (typeof rawCount !== "number" || !Number.isFinite(rawCount) || rawCount <= 0) continue;
        counts.set(reason, (counts.get(reason) ?? 0) + rawCount);
      }
    }

    const total = [...counts.values()].reduce((sum, value) => sum + value, 0);
    const reasons: LossReasonCount[] = [...counts.entries()]
      .map(([key, count]) => ({
        key,
        label: lossReasonLabel(key),
        count,
        share: total > 0 ? count / total : 0,
      }))
      .sort((left, right) => right.count - left.count || left.label.localeCompare(right.label));

    return {
      total,
      reasons,
      dominant: reasons[0] ?? null,
    };
  }, [rows]);

  const hasPricingData = useMemo(
    () =>
      rows.some(
        (row) =>
          typeof row.meanEstimatedCostUsdAll === "number" ||
          typeof row.meanEstimatedCostUsdLoss === "number" ||
          typeof row.medianEstimatedCostUsd === "number"
      ),
    [rows]
  );

  const kpiRows = useMemo(
    () => ({
      quality: topRowsByWinRate(rows)[0] ?? null,
      tokens: pickBestRow(rows, (row) => row.scorePerMillionTokens),
      price: hasPricingData ? pickBestRow(rows, (row) => row.scorePerDollar) : null,
      speed: pickBestRow(rows, (row) => row.scorePerSecond),
    }),
    [hasPricingData, rows]
  );

  const pricingReferenceRow = useMemo(
    () => rows.find((row) => row.pricingSourceUrl || row.pricingCapturedAt) ?? null,
    [rows]
  );

  const pairwiseMetricRows = useMemo<PairwiseMetricRow[]>(() => {
    if (!compareLeftRow || !compareRightRow) return [];
    const metrics: PairwiseMetricRow[] = [
      {
        key: "win-rate",
        label: "Success rate",
        left: compareLeftRow.winRate,
        right: compareRightRow.winRate,
        better: "higher",
        format: "percent",
      },
      {
        key: "score-mean",
        label: "Score mean",
        left: compareLeftRow.scoreMean,
        right: compareRightRow.scoreMean,
        better: "higher",
        format: "number",
        digits: 1,
      },
      {
        key: "median-tokens",
        label: "Median tokens on successful runs",
        left: compareLeftRow.medianTokens,
        right: compareRightRow.medianTokens,
        better: "lower",
        format: "number",
      },
      {
        key: "latency-all",
        label: "Mean model response time",
        left: compareLeftRow.meanLatencyMsAll,
        right: compareRightRow.meanLatencyMsAll,
        better: "lower",
        format: "duration",
      },
      {
        key: "hop-gap",
        label: "Extra clicks vs shortest path",
        left: compareLeftRow.medianHopsOverShortest,
        right: compareRightRow.medianHopsOverShortest,
        better: "lower",
        format: "number",
        digits: 1,
      },
    ];
    if (hasPricingData) {
      metrics.splice(3, 0, {
        key: "cost-all",
        label: "Mean run cost",
        left: compareLeftRow.meanEstimatedCostUsdAll,
        right: compareRightRow.meanEstimatedCostUsdAll,
        better: "lower",
        format: "usd",
      });
    }
    return metrics;
  }, [compareLeftRow, compareRightRow, hasPricingData]);

  const pairwiseVerdict = useMemo(() => {
    if (!compareLeftRow || !compareRightRow) return null;
    const winDelta =
      typeof compareLeftRow.winRate === "number" && typeof compareRightRow.winRate === "number"
        ? compareLeftRow.winRate - compareRightRow.winRate
        : null;
    const costRatio = safeDivide(
      compareLeftRow.meanEstimatedCostUsdAll,
      compareRightRow.meanEstimatedCostUsdAll
    );
    const latencyRatio = safeDivide(compareLeftRow.meanLatencyMsAll, compareRightRow.meanLatencyMsAll);
    const tokenRatio = safeDivide(compareLeftRow.meanTokensAll, compareRightRow.meanTokensAll);
    const qualityWinner = pairwiseWinner(compareLeftRow.winRate, compareRightRow.winRate, "higher");

    const leader =
      qualityWinner === "left"
        ? compareLeftRow
        : qualityWinner === "right"
          ? compareRightRow
          : null;
    const trailer =
      qualityWinner === "left"
        ? compareRightRow
        : qualityWinner === "right"
          ? compareLeftRow
          : null;

    const headline = leader && trailer
      ? `${leader.model} leads this task group by ${formatSignedPercentPoints(
          Math.abs(winDelta ?? 0)
        ).replace("+", "")}.`
      : `${compareLeftRow.model} and ${compareRightRow.model} are effectively tied on success rate.`;

    const tradeoffBits = [
      hasPricingData && typeof costRatio === "number"
        ? `${compareLeftRow.model} costs ${formatRatio(costRatio)} of ${compareRightRow.model}`
        : null,
      typeof latencyRatio === "number"
        ? `${compareLeftRow.model} has ${formatRatio(latencyRatio)} the response time`
        : null,
      typeof tokenRatio === "number"
        ? `${compareLeftRow.model} uses ${formatRatio(tokenRatio)} the tokens`
        : null,
    ].filter(Boolean);

    return {
      headline,
      detail: tradeoffBits.join(" • "),
      winners: {
        quality: pairwiseWinner(compareLeftRow.winRate, compareRightRow.winRate, "higher"),
        tokens: pairwiseWinner(compareLeftRow.meanTokensAll, compareRightRow.meanTokensAll, "lower"),
        price: hasPricingData
          ? pairwiseWinner(
              compareLeftRow.meanEstimatedCostUsdAll,
              compareRightRow.meanEstimatedCostUsdAll,
              "lower"
            )
          : null,
        speed: pairwiseWinner(compareLeftRow.meanLatencyMsAll, compareRightRow.meanLatencyMsAll, "lower"),
      },
      costRatio,
      latencyRatio,
    };
  }, [compareLeftRow, compareRightRow, hasPricingData]);

  const pairwiseSliceRows = useMemo(() => {
    if (!compareLeftRow || !compareRightRow) return [];
    const leftSlices = compareLeftRow.diagnostics?.slices ?? {};
    const rightSlices = compareRightRow.diagnostics?.slices ?? {};
    const keys = [...new Set([...Object.keys(leftSlices), ...Object.keys(rightSlices)])];
    return keys
      .map((key) => {
        const leftValue = safeNumber(leftSlices[key]?.win_rate ?? null);
        const rightValue = safeNumber(rightSlices[key]?.win_rate ?? null);
        return {
          key,
          left: leftValue,
          right: rightValue,
          delta:
            typeof leftValue === "number" && typeof rightValue === "number"
              ? leftValue - rightValue
              : null,
        };
      })
      .sort((left, right) => Math.abs(right.delta ?? 0) - Math.abs(left.delta ?? 0))
      .slice(0, 6);
  }, [compareLeftRow, compareRightRow]);

  const pairwiseBehaviorRows = useMemo(() => {
    if (!compareLeftRow || !compareRightRow) return [];
    return BEHAVIOR_METRIC_ROWS.map(({ key, label }) => {
      const left = safeNumber(compareLeftRow.behavior?.[key] ?? null);
      const right = safeNumber(compareRightRow.behavior?.[key] ?? null);
      return {
        key,
        label,
        left,
        right,
        delta:
          typeof left === "number" && typeof right === "number" ? left - right : null,
      };
    }).sort((left, right) => Math.abs(right.delta ?? 0) - Math.abs(left.delta ?? 0));
  }, [compareLeftRow, compareRightRow]);

  const pairwiseExampleRows = useMemo(() => {
    if (!compareLeftRow || !compareRightRow) return [];
    const leftExamples = compareLeftRow.behavior?.examples ?? {};
    const rightExamples = compareRightRow.behavior?.examples ?? {};
    const keys = [...new Set([...Object.keys(leftExamples), ...Object.keys(rightExamples)])];
    return keys
      .sort((leftKey, rightKey) => {
        const leftScore = (leftExamples[leftKey] ? 1 : 0) + (rightExamples[leftKey] ? 1 : 0);
        const rightScore = (leftExamples[rightKey] ? 1 : 0) + (rightExamples[rightKey] ? 1 : 0);
        return rightScore - leftScore || leftKey.localeCompare(rightKey);
      })
      .slice(0, 3)
      .map((key) => ({
        key,
        left: leftExamples[key] ?? null,
        right: rightExamples[key] ?? null,
      }));
  }, [compareLeftRow, compareRightRow]);

  const compareLeftNarrative = useMemo(
    () => (compareLeftRow ? focusedModelSummaries[compareLeftRow.model] ?? null : null),
    [compareLeftRow, focusedModelSummaries]
  );

  const compareRightNarrative = useMemo(
    () => (compareRightRow ? focusedModelSummaries[compareRightRow.model] ?? null : null),
    [compareRightRow, focusedModelSummaries]
  );

  const compareLeftNarrativeSummary = useMemo(() => {
    if (!compareLeftRow) return "—";
    return humanizeUiCopy(
      compareLeftNarrative?.summary ||
      `Published ${formatPercent(compareLeftRow.winRate)} success rate on the current Frontier 200 view.`
    );
  }, [compareLeftNarrative, compareLeftRow]);

  const compareRightNarrativeSummary = useMemo(() => {
    if (!compareRightRow) return "—";
    return humanizeUiCopy(
      compareRightNarrative?.summary ||
      `Published ${formatPercent(compareRightRow.winRate)} success rate on the current Frontier 200 view.`
    );
  }, [compareRightNarrative, compareRightRow]);

  const compareNarrativeBullets = useMemo(() => {
    if (comparePairwiseNarrative?.differences?.length) {
      return comparePairwiseNarrative.differences.map((item) => humanizeUiCopy(item));
    }
    const out: string[] = [];
    const strongestSlice = pairwiseSliceRows[0];
    if (strongestSlice && typeof strongestSlice.delta === "number") {
      const winner =
        strongestSlice.delta > 0 ? compareLeftRow?.model : compareRightRow?.model;
      const loser =
        strongestSlice.delta > 0 ? compareRightRow?.model : compareLeftRow?.model;
      if (winner && loser) {
        out.push(
          `${winner} does best on ${displaySliceLabel(strongestSlice.key)} relative to ${loser}.`
        );
      }
    }
    const strongestBehavior = pairwiseBehaviorRows[0];
    if (strongestBehavior && typeof strongestBehavior.delta === "number") {
      const lowerIsBetter = strongestBehavior.key !== "mean_attempt_count";
      const winner =
        lowerIsBetter
          ? strongestBehavior.delta < 0
            ? compareLeftRow?.model
            : compareRightRow?.model
          : strongestBehavior.delta > 0
            ? compareLeftRow?.model
            : compareRightRow?.model;
      if (winner) {
        out.push(`${winner} shows the cleaner ${strongestBehavior.label.toLowerCase()} profile in this view.`);
      }
    }
    if (
      hasPricingData &&
      compareLeftRow &&
      compareRightRow &&
      typeof compareLeftRow.meanEstimatedCostUsdAll === "number" &&
      typeof compareRightRow.meanEstimatedCostUsdAll === "number"
    ) {
      const cheaper =
        compareLeftRow.meanEstimatedCostUsdAll <= compareRightRow.meanEstimatedCostUsdAll
          ? compareLeftRow.model
          : compareRightRow.model;
      out.push(`${cheaper} is the cheaper model to run on the current benchmark view.`);
    }
    return out.slice(0, 3);
  }, [
    compareLeftRow,
    comparePairwiseNarrative,
    compareRightRow,
    hasPricingData,
    pairwiseBehaviorRows,
    pairwiseSliceRows,
  ]);

  async function openViewer(entry: TableRow) {
    if (!entry.viewerUrl) return;
    setViewerError(null);
    setViewerLoadingKey(entry.key);
    try {
      const dataset = await loadViewerTraceDataset({
        url: entry.viewerUrl,
        name: entry.viewerDatasetName,
        sliceId: entry.viewerSliceId,
      });
      const record = addViewerDataset({
        name: dataset.name,
        data: dataset.data,
      });
      selectViewerDataset(record.id);
      onOpenViewer?.();
    } catch (e) {
      setViewerError(e instanceof Error ? e.message : "Failed to load run trace data");
    } finally {
      setViewerLoadingKey(null);
    }
  }

  const currentViewLabel =
    bucketFilter === OVERALL_BUCKET_ID ? "Overall" : displaySliceLabel(bucketFilter);
  const leaderboardColumnCount = !isV2 ? 8 : hasPricingData ? 11 : 10;

  return (
    <div className="grid grid-cols-1 gap-4 p-2">
      <Card className="overflow-hidden border-slate-200/80 bg-white/85 p-4 shadow-[var(--shadow-card)] backdrop-blur">
        <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
          <div className="max-w-3xl space-y-2">
            <div className="text-2xl font-semibold tracking-tight">
              {isV2 && focusedSuiteDetail?.benchmark_label
                ? focusedSuiteDetail.benchmark_label
                : "Leaderboard"}
            </div>
            <div className="text-sm leading-6 text-muted-foreground">
              {isV2
                ? focusedSuiteDetail?.benchmark_description ||
                  "Frontier 200 is the standard benchmark for separating frontier models on Simple Wikipedia graph navigation."
                : "Compare models across a benchmark suite."}
            </div>
          </div>

          <div className="flex items-center gap-2">
            <Button
              size="sm"
              variant="outline"
              className="h-8 px-2"
              onClick={() => setLoadToken((t) => t + 1)}
            >
              <RefreshCw className="h-4 w-4" />
              <span className="ml-2 hidden sm:inline">Reload</span>
            </Button>
          </div>
        </div>

        {status === "error" && (
          <div className="mt-3">
            <ErrorCallout
              right={
                <Button size="sm" variant="outline" onClick={() => setLoadToken((t) => t + 1)}>
                  Retry
                </Button>
              }
            >
              <div className="space-y-1">
                <div className="font-medium">Failed to load leaderboard JSON.</div>
                <div className="text-xs text-muted-foreground font-mono">{error || "Unknown error"}</div>
                <div className="text-xs text-muted-foreground">
                  Expected at <span className="font-mono">{DEFAULT_LEADERBOARD_URL}</span>.
                  This file is generated locally and git-ignored.
                </div>
                <div className="text-xs text-muted-foreground">
                  Generate it with{" "}
                  <span className="font-mono">.venv/bin/python scripts/publish_frontier_standard_bundle.py</span>.
                </div>
              </div>
            </ErrorCallout>
          </div>
        )}

        {status === "loading" && (
          <div className="mt-3 text-sm text-muted-foreground">Loading leaderboard…</div>
        )}

        {status === "loaded" && data && (
          <div className="mt-3 space-y-4">
            {viewerError ? (
              <ErrorCallout size="xs">
                <div className="font-medium">Failed to open run trace data.</div>
                <div className="text-xs text-muted-foreground font-mono">{viewerError}</div>
              </ErrorCallout>
            ) : null}

            {isV2 && focusedSuiteDetail?.benchmark_label ? (
              <div
                className="space-y-3"
                data-testid="benchmark-composition"
              >
                <div className="rounded-xl border border-slate-200/80 bg-slate-50/80 p-4">
                  <div className="text-[11px] font-semibold uppercase tracking-[0.16em] text-muted-foreground">
                    What It Tests
                  </div>
                  <div className="mt-2 text-sm text-foreground">
                    {humanizeUiCopy(
                      focusedSuiteDetail.benchmark_description ||
                        "Simple Wikipedia graph navigation under wrong turns, bridge pressure, fragile routes, and exact target closure."
                    )}
                  </div>
                  <div className="mt-3 flex flex-wrap gap-2 text-[11px]">
                    <Badge variant="outline" className="font-mono">
                      view:{currentViewLabel}
                    </Badge>
                    {focusedSuiteDetail.focus_areas?.slice(0, 2).map((item) => (
                      <Badge key={`focus-pill-${item}`} variant="outline" className="text-[11px]">
                        {humanizeUiCopy(item)}
                      </Badge>
                    ))}
                  </div>
                </div>

                <details className="group rounded-xl border border-slate-200/80 bg-white/80 p-4">
                  <summary className="flex cursor-pointer list-none items-center gap-3">
                    <ChevronDown className="h-4 w-4 flex-shrink-0 text-muted-foreground transition-transform group-open:rotate-180" />
                    <div className="text-sm font-medium text-foreground">
                      Task details: example task, ground truth, and model trace
                    </div>
                  </summary>
                  {benchmarkExampleTask ? (
                    <>
                      <div className="mt-4 text-sm text-foreground">
                        Start at{" "}
                        <span className="font-medium">{benchmarkExampleTask.start}</span> and reach{" "}
                        <span className="font-medium">{benchmarkExampleTask.target}</span> by following live links only.
                      </div>
                      <div className="mt-3 grid gap-3 lg:grid-cols-[1fr,1fr]">
                        <div className="rounded-lg border bg-muted/20 px-3 py-3">
                          <div className="text-[11px] text-muted-foreground">
                            Ground truth shortest path ({formatNumber(benchmarkExampleTask.shortestPath.length - 1)} hops)
                          </div>
                          <div className="mt-1 font-mono text-[11px] leading-5 text-foreground/85">
                            {formatPathSequence(benchmarkExampleTask.shortestPath)}
                          </div>
                        </div>
                        <div className="rounded-lg border bg-muted/20 px-3 py-3">
                          <div className="text-[11px] text-muted-foreground">
                            Real model trace ({benchmarkExampleTask.modelExample?.modelLabel || "published model"},{" "}
                            {benchmarkExampleTask.modelExample?.result === "win" ? "win" : "loss"})
                          </div>
                          <div className="mt-1 font-mono text-[11px] leading-5 text-foreground/85">
                            {benchmarkExampleTask.modelExample
                              ? formatPathSequence(benchmarkExampleTask.modelExample.path)
                              : "No example model trace available."}
                          </div>
                        </div>
                      </div>
                      <div className="mt-3 flex flex-wrap gap-2 text-[11px]">
                        <Badge variant="outline" className="font-mono">
                          task-group:{displaySliceLabel(benchmarkExampleTask.sliceId)}
                        </Badge>
                        {typeof focusedSuiteDetail.item_count === "number" ? (
                          <Badge variant="outline" className="font-mono">
                            ground-truth-items:{formatNumber(focusedSuiteDetail.item_count)}
                          </Badge>
                        ) : null}
                        {benchmarkExampleTask.modelExample ? (
                          <Badge variant="outline" className="font-mono">
                            model-steps:{formatNumber(benchmarkExampleTask.modelExample.stepCount)}
                          </Badge>
                        ) : null}
                      </div>
                      <div className="mt-3 text-sm text-foreground">
                        {humanizeUiCopy(
                          focusedSuiteDetail.methodology_notes?.[0] ||
                            "Each task has an exact shortest-path ground truth on a frozen Simple Wikipedia graph snapshot."
                        )}
                      </div>
                    </>
                  ) : (
                    <div className="mt-4 text-sm text-muted-foreground">
                      {humanizeUiCopy(
                        "Each task has an exact shortest-path ground truth on a frozen Simple Wikipedia graph snapshot."
                      )}
                    </div>
                  )}
                </details>
              </div>
            ) : null}

              <Card
                className="border-slate-200/80 bg-white/80 p-4"
              >
                <div className="flex flex-col gap-3 lg:flex-row lg:items-start lg:justify-between">
                  <div className="space-y-1">
                    <div className="text-sm font-medium">Published models</div>
                    <div className="text-xs text-muted-foreground">
                      Sorted by success rate, then extra clicks vs shortest path, tokens, and
                      model response time within the current view.
                    </div>
                  </div>
                  <div className="flex flex-wrap gap-2 text-[11px]">
                    <Badge variant="outline" className="font-mono">
                      view:{currentViewLabel}
                    </Badge>
                    <Badge variant="outline" className="font-mono">
                      models:{formatNumber(rows.length)}
                    </Badge>
                  </div>
                </div>

                <div className="mt-4 flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
                  <div className="flex flex-wrap items-center gap-2">
                    <div className="flex-shrink-0">
                      <Select value={bucketFilter} onValueChange={setBucketFilter}>
                        <SelectTrigger className="h-9 w-[220px]">
                          <SelectValue placeholder={isV2 ? "Task group" : "View"} />
                        </SelectTrigger>
                        <SelectContent>
                          {availableBucketChoices.map((choice) => (
                            <SelectItem key={choice.value} value={choice.value}>
                              {choice.label}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    </div>

                    {isV2 && availableSetupIds.length > 1 ? (
                      <div className="flex-shrink-0">
                        <Select value={setupFilter} onValueChange={setSetupFilter}>
                          <SelectTrigger className="h-9 w-[220px]">
                            <SelectValue placeholder="Setup" />
                          </SelectTrigger>
                          <SelectContent>
                            <SelectItem value="__all__">All setups</SelectItem>
                            {availableSetupIds.map((id) => (
                              <SelectItem key={id} value={id}>
                                {id}
                              </SelectItem>
                            ))}
                          </SelectContent>
                        </Select>
                      </div>
                    ) : null}
                  </div>

                  <div className="relative w-full lg:w-[320px]">
                    <Search className="absolute left-2 top-2.5 h-4 w-4 text-muted-foreground" />
                    <Input
                      value={query}
                      onChange={(e) => setQuery(e.target.value)}
                      placeholder="Filter models…"
                      className="h-9 pl-8"
                    />
                  </div>
                </div>

                <div className="mt-4 rounded-md border overflow-hidden">
                  <div className="overflow-x-auto">
                    <table className="w-full text-sm">
                      <thead className="bg-muted/40">
                        <tr className="text-xs text-muted-foreground">
                          <th className="px-3 py-2 text-left font-medium">
                            <button
                              className="inline-flex items-center gap-1 hover:text-foreground"
                              onClick={() => {
                                const nextDir = toggleSort("rank", sortKey, sortDir);
                                setSortKey("rank");
                                setSortDir(nextDir);
                              }}
                            >
                              Rank {sortIcon(sortKey === "rank", sortDir)}
                            </button>
                          </th>
                          <th className="min-w-[240px] px-3 py-2 text-left font-medium">
                            <button
                              className="inline-flex items-center gap-1 hover:text-foreground"
                              onClick={() => {
                                const nextDir = toggleSort("model", sortKey, sortDir);
                                setSortKey("model");
                                setSortDir(nextDir);
                              }}
                            >
                              Model {sortIcon(sortKey === "model", sortDir)}
                            </button>
                          </th>
                          {!isV2 ? (
                            <th className="px-3 py-2 text-right font-medium">
                              <button
                                className="inline-flex items-center gap-1 hover:text-foreground"
                                onClick={() => {
                                  const nextDir = toggleSort("score_sum", sortKey, sortDir);
                                  setSortKey("score_sum");
                                  setSortDir(nextDir);
                                }}
                              >
                                Score {sortIcon(sortKey === "score_sum", sortDir)}
                              </button>
                            </th>
                          ) : null}
                          <th className="px-3 py-2 text-right font-medium">
                            <button
                              className="inline-flex items-center gap-1 hover:text-foreground"
                              onClick={() => {
                                const nextDir = toggleSort("win_rate", sortKey, sortDir);
                                setSortKey("win_rate");
                                setSortDir(nextDir);
                              }}
                            >
                              Success rate {sortIcon(sortKey === "win_rate", sortDir)}
                            </button>
                          </th>
                          <th className="px-3 py-2 text-right font-medium">
                            <button
                              className="inline-flex items-center gap-1 hover:text-foreground"
                              onClick={() => {
                                const nextDir = toggleSort("wins", sortKey, sortDir);
                                setSortKey("wins");
                                setSortDir(nextDir);
                              }}
                            >
                              Wins {sortIcon(sortKey === "wins", sortDir)}
                            </button>
                          </th>
                          <th className="px-3 py-2 text-right font-medium">
                            <button
                              className="inline-flex items-center gap-1 hover:text-foreground"
                              onClick={() => {
                                const nextDir = toggleSort("total_runs", sortKey, sortDir);
                                setSortKey("total_runs");
                                setSortDir(nextDir);
                              }}
                            >
                              Runs {sortIcon(sortKey === "total_runs", sortDir)}
                            </button>
                          </th>
                          <th className="px-3 py-2 text-right font-medium">
                            <button
                              className="inline-flex items-center gap-1 hover:text-foreground"
                              onClick={() => {
                                const nextDir = toggleSort("median_hops", sortKey, sortDir);
                                setSortKey("median_hops");
                                setSortDir(nextDir);
                              }}
                            >
                              Median hops {sortIcon(sortKey === "median_hops", sortDir)}
                            </button>
                          </th>
                          {isV2 ? (
                            <th className="px-3 py-2 text-right font-medium">
                              <button
                                className="inline-flex items-center gap-1 hover:text-foreground"
                                onClick={() => {
                                  const nextDir = toggleSort(
                                    "median_hops_over_shortest",
                                    sortKey,
                                    sortDir
                                  );
                                  setSortKey("median_hops_over_shortest");
                                  setSortDir(nextDir);
                                }}
                              >
                                Extra clicks vs shortest path{" "}
                                {sortIcon(sortKey === "median_hops_over_shortest", sortDir)}
                              </button>
                            </th>
                          ) : null}
                          <th className="px-3 py-2 text-right font-medium">
                            <button
                              className="inline-flex items-center gap-1 hover:text-foreground"
                              onClick={() => {
                                const nextDir = toggleSort("median_tokens", sortKey, sortDir);
                                setSortKey("median_tokens");
                                setSortDir(nextDir);
                              }}
                            >
                              Median tokens {sortIcon(sortKey === "median_tokens", sortDir)}
                            </button>
                          </th>
                          <th className="px-3 py-2 text-right font-medium">
                            <button
                              className="inline-flex items-center gap-1 hover:text-foreground"
                              onClick={() => {
                                const nextDir = toggleSort(
                                  isV2 ? "median_latency_ms" : "median_duration_ms",
                                  sortKey,
                                  sortDir
                                );
                                setSortKey(isV2 ? "median_latency_ms" : "median_duration_ms");
                                setSortDir(nextDir);
                              }}
                            >
                              {isV2 ? "Median model response time" : "Median time"}{" "}
                              {sortIcon(
                                sortKey === (isV2 ? "median_latency_ms" : "median_duration_ms"),
                                sortDir
                              )}
                            </button>
                          </th>
                          {isV2 ? (
                            <th className="px-3 py-2 text-right font-medium">
                              <button
                                className="inline-flex items-center gap-1 hover:text-foreground"
                                onClick={() => {
                                  const nextDir = toggleSort(
                                    "mean_estimated_cost_usd_all",
                                    sortKey,
                                    sortDir
                                  );
                                  setSortKey("mean_estimated_cost_usd_all");
                                  setSortDir(nextDir);
                                }}
                              >
                                Mean run cost{" "}
                                {sortIcon(sortKey === "mean_estimated_cost_usd_all", sortDir)}
                              </button>
                            </th>
                          ) : null}
                          {isV2 ? (
                            <th className="min-w-[140px] px-3 py-2 text-left font-medium">
                              Run trace
                            </th>
                          ) : null}
                        </tr>
                      </thead>
                      <tbody>
                        {rows.length === 0 ? (
                          <tr>
                            <td
                              colSpan={leaderboardColumnCount}
                              className="px-3 py-6 text-center text-sm text-muted-foreground"
                            >
                              No entries match the current filters.
                            </td>
                          </tr>
                        ) : (
                          rows.map((row) => {
                            const isHighlighted = hoveredRowKey === row.key;
                            const isCompareLeft = compareLeftKey === row.key;
                            const isCompareRight = compareRightKey === row.key;
                            return (
                              <tr
                                key={row.key}
                                className={cn(
                                  "border-t",
                                  row.rank === 1 && "bg-status-active/5",
                                  (isHighlighted || selectedRowKey === row.key) && "bg-primary/5",
                                  isCompareLeft && "bg-sky-50/70",
                                  isCompareRight && "bg-emerald-50/70"
                                )}
                                onMouseEnter={() => setHoveredRowKey(row.key)}
                                onMouseLeave={() =>
                                  setHoveredRowKey((current) => (current === row.key ? null : current))
                                }
                                onClick={() => setSelectedRowKey(row.key)}
                              >
                                <td className="px-3 py-2 font-mono text-xs text-muted-foreground">
                                  {row.rank !== null ? formatNumber(row.rank) : "—"}
                                </td>
                                <td className="px-3 py-2">
                                  <div className="flex flex-wrap items-center gap-2">
                                    <div className="font-medium">{row.model}</div>
                                    {isCompareLeft ? (
                                      <Badge
                                        className="border-sky-200 bg-sky-50 text-[11px] text-sky-800"
                                        variant="outline"
                                      >
                                        A
                                      </Badge>
                                    ) : null}
                                    {isCompareRight ? (
                                      <Badge
                                        className="border-emerald-200 bg-emerald-50 text-[11px] text-emerald-800"
                                        variant="outline"
                                      >
                                        B
                                      </Badge>
                                    ) : null}
                                  </div>
                                  {row.configBadges.length > 0 ? (
                                    <div className="mt-1 flex flex-wrap gap-1">
                                      {row.configBadges.map((badge) => (
                                        <Badge
                                          key={`${row.key}-${badge}`}
                                          variant="outline"
                                          className="text-[11px] font-mono"
                                        >
                                          {badge}
                                        </Badge>
                                      ))}
                                    </div>
                                  ) : null}
                                </td>
                                {!isV2 ? (
                                  <td className="px-3 py-2 text-right font-mono text-xs">
                                    {formatNumber(row.scoreSum, 1)}
                                  </td>
                                ) : null}
                                <td className="px-3 py-2 text-right font-mono text-xs">
                                  {formatPercent(row.winRate)}
                                </td>
                                <td className="px-3 py-2 text-right font-mono text-xs">
                                  {formatNumber(row.wins)}
                                </td>
                                <td className="px-3 py-2 text-right font-mono text-xs">
                                  {formatNumber(row.totalRuns)}
                                </td>
                                <td className="px-3 py-2 text-right font-mono text-xs">
                                  {formatNumber(row.medianHops, 1)}
                                </td>
                                {isV2 ? (
                                  <td className="px-3 py-2 text-right font-mono text-xs">
                                    {formatNumber(row.medianHopsOverShortest, 1)}
                                  </td>
                                ) : null}
                                <td className="px-3 py-2 text-right font-mono text-xs">
                                  {formatNumber(row.medianTokens)}
                                </td>
                                <td className="px-3 py-2 text-right font-mono text-xs">
                                  {formatDurationMs(isV2 ? row.medianLatencyMs : row.medianDurationMs)}
                                </td>
                                {isV2 && hasPricingData ? (
                                  <td className="px-3 py-2 text-right font-mono text-xs">
                                    {formatUsd(row.meanEstimatedCostUsdAll)}
                                  </td>
                                ) : null}
                                {isV2 ? (
                                  <td className="px-3 py-2">
                                    {row.viewerUrl ? (
                                      <Button
                                        size="sm"
                                        variant="outline"
                                        className="h-8 gap-2"
                                        onClick={() => void openViewer(row)}
                                        disabled={viewerLoadingKey === row.key}
                                      >
                                        <ExternalLink className="h-4 w-4" />
                                        {viewerLoadingKey === row.key ? "Loading…" : "Open run trace"}
                                      </Button>
                                    ) : (
                                      <span className="text-xs text-muted-foreground">—</span>
                                    )}
                                  </td>
                                ) : null}
                              </tr>
                            );
                          })
                        )}
                      </tbody>
                    </table>
                  </div>
                </div>

                <div className="mt-3 text-xs text-muted-foreground">
                  Open run trace to inspect the exact traces behind each published row.
                </div>
              </Card>

            {isV2 && focusedSuiteDetail?.benchmark_label ? (
              <details className="rounded-xl border border-slate-200/80 bg-white/80 p-4">
                <summary className="cursor-pointer list-none text-sm font-medium">
                  About Frontier 200
                </summary>
                <div className="mt-4 space-y-4">
                  <div className="flex flex-wrap gap-2 text-[11px]">
                    {focusedSuiteComposition.map((item) => (
                      <Badge
                        key={`composition-detail-${item.key}`}
                        variant="outline"
                        className="font-mono"
                      >
                        {item.key}:{formatNumber(item.count)}
                      </Badge>
                    ))}
                    <Badge variant="outline" className="font-mono">
                      models:{formatNumber(rows.length)}
                    </Badge>
                    {safeString(data.generated_at) ? (
                      <Badge variant="outline" className="font-mono">
                        updated:{formatDateLabel(data.generated_at) || data.generated_at}
                      </Badge>
                    ) : null}
                  </div>

                  {focusedSuiteFamilies.length > 0 ? (
                    <div>
                      <div className="text-[11px] uppercase tracking-[0.16em] text-muted-foreground">
                        Family mix
                      </div>
                      <div className="mt-2 flex flex-wrap gap-2">
                        {focusedSuiteFamilies.map((family) => (
                          <Badge
                            key={`family-detail-${family.key}`}
                            variant="outline"
                            className="text-[11px]"
                          >
                            {family.label}:{" "}
                            <span className="ml-1 font-mono">{formatNumber(family.count)}</span>
                          </Badge>
                        ))}
                      </div>
                    </div>
                  ) : null}

                  {focusedSuiteDetail.focus_areas?.length ? (
                    <div>
                      <div className="text-[11px] uppercase tracking-[0.16em] text-muted-foreground">
                        Focus areas
                      </div>
                      <div className="mt-2 flex flex-wrap gap-2">
                        {focusedSuiteDetail.focus_areas.map((item) => (
                          <Badge key={`focus-detail-${item}`} variant="outline" className="text-[11px]">
                            {humanizeUiCopy(item)}
                          </Badge>
                        ))}
                      </div>
                    </div>
                  ) : null}

                  {focusedSuiteDetail.coverage_notes?.length ? (
                    <div>
                        <div className="text-[11px] uppercase tracking-[0.16em] text-muted-foreground">
                          Interpretation
                        </div>
                        <ul className="mt-2 space-y-1 text-sm text-muted-foreground">
                          {focusedSuiteDetail.coverage_notes.map((note) => (
                            <li key={`coverage-detail-${note}`}>{humanizeUiCopy(note)}</li>
                          ))}
                        </ul>
                      </div>
                  ) : null}

                  <div>
                    <div className="text-[11px] uppercase tracking-[0.16em] text-muted-foreground">
                      Aggregated failure profile
                    </div>
                    <div className="mt-2 space-y-2">
                      {lossReasonSummary.reasons.slice(0, 4).map((reason) => (
                        <div key={`loss-detail-${reason.key}`} className="space-y-1">
                          <div className="flex items-center justify-between gap-3 text-xs">
                            <span className="text-foreground">{reason.label}</span>
                            <span className="font-mono text-muted-foreground">
                              {formatNumber(reason.count)} · {formatPercent(reason.share)}
                            </span>
                          </div>
                          <div className="h-2 rounded-full bg-muted">
                            <div
                              className="h-2 rounded-full bg-amber-400"
                              style={{ width: `${Math.max(6, reason.share * 100)}%` }}
                            />
                          </div>
                        </div>
                      ))}
                      {lossReasonSummary.reasons.length === 0 ? (
                        <div className="rounded-md border bg-muted/20 px-3 py-4 text-xs text-muted-foreground">
                          No loss reasons are available for the current filters.
                        </div>
                      ) : null}
                    </div>
                  </div>
                </div>
              </details>
            ) : null}

            {isV2 && compareLeftRow && compareRightRow ? (
              <Card
                className="border-slate-200/80 bg-white/80 p-4"
                data-testid="pairwise-panel"
              >
                <div className="flex flex-col gap-3 lg:flex-row lg:items-start lg:justify-between">
                  <div className="space-y-1">
                    <div className="flex items-center gap-2 text-sm font-medium">
                      <ArrowRightLeft className="h-4 w-4 text-muted-foreground" />
                      Compare models
                    </div>
                    <div className="text-xs text-muted-foreground">
                      Use the summary first, then open the detailed comparison only when you need
                      the underlying task-group or navigation evidence.
                    </div>
                  </div>
                  <div className="grid gap-2 sm:grid-cols-2 lg:min-w-[32rem]">
                    <Select value={compareLeftKey ?? ""} onValueChange={setCompareLeftKey}>
                      <SelectTrigger className="h-9 bg-sky-50/70">
                        <SelectValue placeholder="Model A" />
                      </SelectTrigger>
                      <SelectContent>
                        {rows.map((row) => (
                          <SelectItem key={`compare-left-${row.key}`} value={row.key}>
                            A · {row.model}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                    <Select value={compareRightKey ?? ""} onValueChange={setCompareRightKey}>
                      <SelectTrigger className="h-9 bg-emerald-50/70">
                        <SelectValue placeholder="Model B" />
                      </SelectTrigger>
                      <SelectContent>
                        {rows.map((row) => (
                          <SelectItem key={`compare-right-${row.key}`} value={row.key}>
                            B · {row.model}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>
                </div>

                <div className="mt-4 rounded-2xl border border-slate-200/80 bg-[linear-gradient(135deg,rgba(14,165,233,0.06),rgba(34,197,94,0.08))] p-4">
                  <div className="flex flex-col gap-3 lg:flex-row lg:items-start lg:justify-between">
                    <div className="max-w-3xl">
                      <div className="text-base font-semibold text-foreground">
                        {humanizeUiCopy(comparePairwiseNarrative?.headline || pairwiseVerdict?.headline)}
                      </div>
                      <div className="mt-1 text-sm text-muted-foreground">
                        {humanizeUiCopy(
                          comparePairwiseNarrative?.summary ||
                            pairwiseVerdict?.detail ||
                            (hasPricingData
                              ? "Quality, cost, and speed tradeoffs will appear here when both models have data."
                              : "Quality, token, and speed tradeoffs will appear here when both models have data.")
                        )}
                      </div>
                    </div>

                    <div className="flex flex-wrap gap-2">
                      <Button
                        size="sm"
                        variant="outline"
                        className="gap-2 border-sky-200 bg-sky-50/70"
                        data-testid="open-viewer-primary"
                        onClick={() => void openViewer(compareLeftRow)}
                        disabled={!compareLeftRow.viewerUrl || viewerLoadingKey === compareLeftRow.key}
                      >
                        <ExternalLink className="h-4 w-4" />
                        Open A run trace
                      </Button>
                      <Button
                        size="sm"
                        variant="outline"
                        className="gap-2 border-emerald-200 bg-emerald-50/70"
                        data-testid="open-viewer-secondary"
                        onClick={() => void openViewer(compareRightRow)}
                        disabled={!compareRightRow.viewerUrl || viewerLoadingKey === compareRightRow.key}
                      >
                        <ExternalLink className="h-4 w-4" />
                        Open B run trace
                      </Button>
                    </div>
                  </div>

                  {compareNarrativeBullets.length > 0 ? (
                    <ul className="mt-4 space-y-1 text-sm text-foreground/90">
                      {compareNarrativeBullets.map((bullet) => (
                        <li key={`compare-bullet-${bullet}`}>{bullet}</li>
                      ))}
                    </ul>
                  ) : null}
                </div>

                <div className="mt-4 grid grid-cols-1 gap-4 xl:grid-cols-2">
                  <div className="rounded-xl border border-sky-200 bg-sky-50/40 p-4">
                    <div className="flex items-start justify-between gap-3">
                      <div>
                        <div className="text-sm font-medium text-sky-950">{compareLeftRow.model}</div>
                        <div className="mt-1 text-xs text-sky-900/75">
                          {humanizeUiCopy(compareLeftNarrative?.headline || "Published Frontier 200 profile")}
                        </div>
                      </div>
                      <div className="flex flex-wrap gap-1.5 text-[11px]">
                        <Badge variant="outline" className="border-sky-300 bg-white font-mono">
                          success:{formatPercent(compareLeftRow.winRate)}
                        </Badge>
                        {hasPricingData ? (
                          <Badge variant="outline" className="border-sky-300 bg-white font-mono">
                            cost:{formatUsd(compareLeftRow.meanEstimatedCostUsdAll)}
                          </Badge>
                        ) : null}
                        <Badge variant="outline" className="border-sky-300 bg-white font-mono">
                          response:{formatDurationMs(compareLeftRow.meanLatencyMsAll)}
                        </Badge>
                      </div>
                    </div>
                    <div className="mt-3 text-sm text-sky-950/85">{compareLeftNarrativeSummary}</div>
                    {compareLeftNarrative?.strengths?.length ? (
                      <div className="mt-4">
                        <div className="text-[11px] uppercase tracking-[0.16em] text-sky-900/70">
                          Tends to do well at
                        </div>
                        <ul className="mt-2 space-y-1 text-sm text-sky-950/85">
                          {compareLeftNarrative.strengths.map((item) => (
                            <li key={`left-strength-${item}`}>{humanizeUiCopy(item)}</li>
                          ))}
                        </ul>
                      </div>
                    ) : null}
                    {compareLeftNarrative?.watchouts?.length ? (
                      <div className="mt-4">
                        <div className="text-[11px] uppercase tracking-[0.16em] text-sky-900/70">
                          Watch for
                        </div>
                        <ul className="mt-2 space-y-1 text-sm text-sky-950/85">
                          {compareLeftNarrative.watchouts.map((item) => (
                            <li key={`left-watchout-${item}`}>{humanizeUiCopy(item)}</li>
                          ))}
                        </ul>
                      </div>
                    ) : null}
                  </div>

                  <div className="rounded-xl border border-emerald-200 bg-emerald-50/40 p-4">
                    <div className="flex items-start justify-between gap-3">
                      <div>
                        <div className="text-sm font-medium text-emerald-950">{compareRightRow.model}</div>
                        <div className="mt-1 text-xs text-emerald-900/75">
                          {humanizeUiCopy(compareRightNarrative?.headline || "Published Frontier 200 profile")}
                        </div>
                      </div>
                      <div className="flex flex-wrap gap-1.5 text-[11px]">
                        <Badge variant="outline" className="border-emerald-300 bg-white font-mono">
                          success:{formatPercent(compareRightRow.winRate)}
                        </Badge>
                        {hasPricingData ? (
                          <Badge variant="outline" className="border-emerald-300 bg-white font-mono">
                            cost:{formatUsd(compareRightRow.meanEstimatedCostUsdAll)}
                          </Badge>
                        ) : null}
                        <Badge variant="outline" className="border-emerald-300 bg-white font-mono">
                          response:{formatDurationMs(compareRightRow.meanLatencyMsAll)}
                        </Badge>
                      </div>
                    </div>
                    <div className="mt-3 text-sm text-emerald-950/85">{compareRightNarrativeSummary}</div>
                    {compareRightNarrative?.strengths?.length ? (
                      <div className="mt-4">
                        <div className="text-[11px] uppercase tracking-[0.16em] text-emerald-900/70">
                          Tends to do well at
                        </div>
                        <ul className="mt-2 space-y-1 text-sm text-emerald-950/85">
                          {compareRightNarrative.strengths.map((item) => (
                            <li key={`right-strength-${item}`}>{humanizeUiCopy(item)}</li>
                          ))}
                        </ul>
                      </div>
                    ) : null}
                    {compareRightNarrative?.watchouts?.length ? (
                      <div className="mt-4">
                        <div className="text-[11px] uppercase tracking-[0.16em] text-emerald-900/70">
                          Watch for
                        </div>
                        <ul className="mt-2 space-y-1 text-sm text-emerald-950/85">
                          {compareRightNarrative.watchouts.map((item) => (
                            <li key={`right-watchout-${item}`}>{humanizeUiCopy(item)}</li>
                          ))}
                        </ul>
                      </div>
                    ) : null}
                  </div>
                </div>

                <details className="mt-4 rounded-xl border bg-muted/20 p-4">
                  <summary className="cursor-pointer list-none text-sm font-medium">
                    Show detailed comparison
                  </summary>
                  <div className="mt-4 space-y-4">
                    <div className="text-xs text-muted-foreground">
                      These lower-level details are useful when the summary above is not enough:
                      task-group differences compare benchmark groups, navigation pattern
                      differences compare retry and backtrack patterns, and example decisions show
                      real step choices from the captured traces.
                    </div>

                    <div className="grid grid-cols-1 gap-3 md:grid-cols-2 xl:grid-cols-3">
                      {pairwiseMetricRows.map((metric) => {
                        const delta =
                          typeof metric.left === "number" && typeof metric.right === "number"
                            ? metric.left - metric.right
                            : null;
                        const winner = pairwiseWinner(metric.left, metric.right, metric.better);
                        const tone =
                          winner === "left" ? "left" : winner === "right" ? "right" : "neutral";
                        const deltaLabel =
                          metric.format === "percent"
                            ? formatSignedPercentPoints(delta)
                            : metric.format === "usd"
                              ? formatSignedUsd(delta)
                              : metric.format === "duration"
                                ? formatSignedDurationMs(delta)
                                : formatSignedNumber(delta, metric.digits ?? 1);
                        const body =
                          metric.format === "percent"
                            ? `${formatPercent(metric.left)} vs ${formatPercent(metric.right)}`
                            : metric.format === "usd"
                              ? `${formatUsd(metric.left)} vs ${formatUsd(metric.right)}`
                              : metric.format === "duration"
                                ? `${formatDurationMs(metric.left)} vs ${formatDurationMs(metric.right)}`
                                : `${formatNumber(metric.left, metric.digits ?? 1)} vs ${formatNumber(metric.right, metric.digits ?? 1)}`;

                        return (
                          <PairwiseDeltaCard
                            key={`pairwise-metric-${metric.key}`}
                            label={metric.label}
                            delta={deltaLabel}
                            body={body}
                            tone={tone}
                          />
                        );
                      })}
                    </div>

                    <div className="grid grid-cols-1 gap-4 xl:grid-cols-3">
                      <div className="rounded-xl border bg-white/80 p-4">
                        <div className="text-sm font-medium">Task-group differences</div>
                        <div className="mt-1 text-xs text-muted-foreground">
                          The largest success-rate differences across the benchmark task groups.
                        </div>
                        <div className="mt-3 space-y-2">
                          {pairwiseSliceRows.map((sliceRow) => (
                            <div
                              key={`pairwise-slice-${sliceRow.key}`}
                              className="rounded-lg border bg-muted/20 px-3 py-2"
                            >
                              <div className="flex items-center justify-between gap-2 text-xs">
                                <span className="text-foreground">{displaySliceLabel(sliceRow.key)}</span>
                                <span className="font-mono text-muted-foreground">
                                  {formatSignedPercentPoints(sliceRow.delta)}
                                </span>
                              </div>
                              <div className="mt-2 flex items-center justify-between gap-3 text-[11px] text-muted-foreground">
                                <span className="rounded-full bg-sky-50 px-2 py-1 font-mono text-sky-800">
                                  A {formatPercent(sliceRow.left)}
                                </span>
                                <span className="rounded-full bg-emerald-50 px-2 py-1 font-mono text-emerald-800">
                                  B {formatPercent(sliceRow.right)}
                                </span>
                              </div>
                            </div>
                          ))}
                        </div>
                      </div>

                      <div className="rounded-xl border bg-white/80 p-4">
                        <div className="text-sm font-medium">Navigation pattern differences</div>
                        <div className="mt-1 text-xs text-muted-foreground">
                          Largest navigation gaps across retry, backtrack, broad-page, and dead-end
                          signals.
                        </div>
                        <div className="mt-3 space-y-2">
                          {pairwiseBehaviorRows.map((row) => (
                            <div
                              key={`pairwise-behavior-${row.key}`}
                              className="rounded-lg border bg-muted/20 px-3 py-2"
                            >
                              <div className="flex items-center justify-between gap-2 text-xs">
                                <span className="text-foreground">{row.label}</span>
                                <span className="font-mono text-muted-foreground">
                                  {row.key === "mean_attempt_count"
                                    ? formatSignedNumber(row.delta, 2)
                                    : formatSignedPercentPoints(row.delta)}
                                </span>
                              </div>
                              <div className="mt-2 flex items-center justify-between gap-3 text-[11px] text-muted-foreground">
                                <span className="rounded-full bg-sky-50 px-2 py-1 font-mono text-sky-800">
                                  A {row.key === "mean_attempt_count" ? formatNumber(row.left, 2) : formatPercent(row.left)}
                                </span>
                                <span className="rounded-full bg-emerald-50 px-2 py-1 font-mono text-emerald-800">
                                  B {row.key === "mean_attempt_count" ? formatNumber(row.right, 2) : formatPercent(row.right)}
                                </span>
                              </div>
                            </div>
                          ))}
                        </div>
                      </div>

                      <div className="rounded-xl border bg-white/80 p-4">
                        <div className="text-sm font-medium">Example decisions</div>
                        <div className="mt-1 text-xs text-muted-foreground">
                          Side-by-side evidence from the captured example traces.
                        </div>
                        <div className="mt-3 space-y-3">
                          {pairwiseExampleRows.map((exampleRow) => (
                            <div
                              key={`pairwise-example-${exampleRow.key}`}
                              className="rounded-lg border bg-muted/20 p-3"
                            >
                              <div className="text-xs font-medium capitalize text-foreground">
                                {exampleRow.key.replaceAll("_", " ")}
                              </div>
                              <div className="mt-3 grid gap-3 sm:grid-cols-2">
                                <div className="rounded-lg border border-sky-200 bg-sky-50/70 p-3">
                                  <div className="text-[11px] uppercase tracking-[0.16em] text-sky-800">
                                    A
                                  </div>
                                  <div className="mt-1 text-[11px] font-mono text-sky-900">
                                    {exampleRow.left?.current_article || "—"} → {exampleRow.left?.selected_title || "—"}
                                  </div>
                                  <div className="mt-2 text-xs text-sky-900/80">
                                    {formatExamplePreview(exampleRow.left?.preview)}
                                  </div>
                                </div>
                                <div className="rounded-lg border border-emerald-200 bg-emerald-50/70 p-3">
                                  <div className="text-[11px] uppercase tracking-[0.16em] text-emerald-800">
                                    B
                                  </div>
                                  <div className="mt-1 text-[11px] font-mono text-emerald-900">
                                    {exampleRow.right?.current_article || "—"} → {exampleRow.right?.selected_title || "—"}
                                  </div>
                                  <div className="mt-2 text-xs text-emerald-900/80">
                                    {formatExamplePreview(exampleRow.right?.preview)}
                                  </div>
                                </div>
                              </div>
                            </div>
                          ))}
                        </div>
                      </div>
                    </div>
                  </div>
                </details>
              </Card>
            ) : null}

            {isV2 ? (
              <details className="rounded-xl border border-slate-200/80 bg-white/80 p-4">
                <summary className="cursor-pointer list-none text-sm font-medium">
                  Show detailed analysis
                </summary>
                <div className="mt-4 space-y-4">
                  <div className="space-y-4" data-testid="leaderboard-overview">
                    <div
                      className={cn(
                        "grid grid-cols-1 gap-3 md:grid-cols-2",
                        hasPricingData ? "xl:grid-cols-4" : "xl:grid-cols-3"
                      )}
                    >
                      <KpiCard
                        label="Top quality"
                        model={kpiRows.quality?.model || "—"}
                        value={formatPercent(kpiRows.quality?.winRate ?? null)}
                        caption={
                          kpiRows.quality
                            ? `Rank ${formatNumber(kpiRows.quality.rank)} in the current view`
                            : "No data for the current filters"
                        }
                        tone="quality"
                        icon={<Trophy className="h-4 w-4" />}
                      />
                      <KpiCard
                        label="Best token efficiency"
                        model={kpiRows.tokens?.model || "—"}
                        value={
                          typeof kpiRows.tokens?.scorePerMillionTokens === "number"
                            ? `${formatNumber(kpiRows.tokens.scorePerMillionTokens, 1)} score / 1M`
                            : "—"
                        }
                        caption={
                          kpiRows.tokens
                            ? `${formatNumber(kpiRows.tokens.meanTokensAll)} mean tokens per run`
                            : "No efficiency signal"
                        }
                        tone="tokens"
                        icon={<Zap className="h-4 w-4" />}
                      />
                      {hasPricingData ? (
                        <KpiCard
                          label="Best value"
                          model={kpiRows.price?.model || "—"}
                          value={
                            typeof kpiRows.price?.scorePerDollar === "number"
                              ? `${formatNumber(kpiRows.price.scorePerDollar, 0)} score / $`
                              : "—"
                          }
                          caption={
                            kpiRows.price
                              ? `${formatCompactUsd(kpiRows.price.meanEstimatedCostUsdAll)} mean run cost`
                              : "No cost data"
                          }
                          tone="price"
                          icon={<Coins className="h-4 w-4" />}
                        />
                      ) : null}
                      <KpiCard
                        label="Best speed"
                        model={kpiRows.speed?.model || "—"}
                        value={
                          typeof kpiRows.speed?.scorePerSecond === "number"
                            ? `${formatNumber(kpiRows.speed.scorePerSecond, 1)} score / s`
                            : "—"
                        }
                        caption={
                          kpiRows.speed
                            ? `${formatDurationMs(kpiRows.speed.meanLatencyMsAll)} mean model response time`
                            : "No response-time signal"
                        }
                        tone="speed"
                        icon={<Gauge className="h-4 w-4" />}
                      />
                    </div>

                    <div className="grid grid-cols-1 gap-4 xl:grid-cols-12" data-testid="tradeoff-frontiers">
                      <Card className="border-slate-200/80 bg-white/80 p-4 xl:col-span-3">
                        <div className="space-y-2">
                          <div className="text-sm font-medium">Success-rate snapshot</div>
                          <div className="text-xs text-muted-foreground">
                            Highest-quality rows in the current view, with compare picks highlighted.
                          </div>
                        </div>
                        <div className="mt-3 max-h-[28rem] space-y-2 overflow-y-auto pr-1">
                          {topPassRows.length === 0 ? (
                            <div className="text-xs text-muted-foreground">No rows for the current filters.</div>
                          ) : (
                            topPassRows.map((row) => {
                              const width = Math.max(0, Math.min(100, (row.winRate ?? 0) * 100));
                              const isHovered = hoveredRowKey === row.key;
                              const isCompareLeft = compareLeftKey === row.key;
                              const isCompareRight = compareRightKey === row.key;
                              return (
                                <div
                                  key={`pass-${row.key}`}
                                  className={cn(
                                    "rounded-xl border px-3 py-2 transition-colors",
                                    isHovered && "border-primary/40 bg-primary/5",
                                    isCompareLeft && "border-sky-300 bg-sky-50/80",
                                    isCompareRight && "border-emerald-300 bg-emerald-50/80",
                                    !isHovered && !isCompareLeft && !isCompareRight && "bg-muted/20"
                                  )}
                                  onMouseEnter={() => setHoveredRowKey(row.key)}
                                  onMouseLeave={() =>
                                    setHoveredRowKey((current) => (current === row.key ? null : current))
                                  }
                                >
                                  <div className="flex items-center justify-between gap-2 text-xs">
                                    <div className="truncate font-medium text-foreground">{row.label}</div>
                                    <div className="font-mono text-muted-foreground">
                                      {formatPercent(row.winRate)}
                                    </div>
                                  </div>
                                  <div className="mt-2 flex items-center justify-between gap-2 text-[11px] text-muted-foreground">
                                    <span>
                                      {isCompareLeft ? "Compare A" : isCompareRight ? "Compare B" : "Quality"}
                                    </span>
                                    <span>
                                      {hasPricingData
                                        ? `${formatCompactUsd(row.meanEstimatedCostUsdAll)} / ${formatDurationMs(row.meanLatencyMsAll)}`
                                        : formatDurationMs(row.meanLatencyMsAll)}
                                    </span>
                                  </div>
                                  <div className="mt-2 h-2 rounded-full bg-muted">
                                    <div
                                      className={cn(
                                        "h-2 rounded-full transition-all",
                                        isCompareLeft
                                          ? "bg-sky-500"
                                          : isCompareRight
                                            ? "bg-emerald-500"
                                            : "bg-primary"
                                      )}
                                      style={{ width: `${width}%` }}
                                    />
                                  </div>
                                </div>
                              );
                            })
                          )}
                        </div>
                      </Card>

                      <div
                        className={cn(
                          "grid grid-cols-1 gap-4 xl:col-span-9",
                          hasPricingData ? "xl:grid-cols-3" : "xl:grid-cols-2"
                        )}
                      >
                        <BenchmarkFrontierChart
                          title="Performance vs Tokens"
                          subtitle="Median tokens on successful runs versus success rate."
                          xLabel="Median total tokens"
                          dataTestId="tokens-frontier"
                          points={frontierPoints
                            .filter(
                              (point) =>
                                typeof point.tokens === "number" && typeof point.winRate === "number"
                            )
                            .map((point) => ({
                              id: point.id,
                              label: point.label,
                              x: point.tokens as number,
                              y: point.winRate as number,
                              tone: point.tone,
                            }))}
                        />
                        {hasPricingData ? (
                          <BenchmarkFrontierChart
                            title="Performance vs Price"
                            subtitle="Mean benchmark run cost across all attempts versus success rate."
                            xLabel="Mean run cost"
                            dataTestId="price-frontier"
                            formatXValue={formatCompactUsd}
                            points={frontierPoints
                              .filter(
                                (point) =>
                                  typeof point.priceUsd === "number" && typeof point.winRate === "number"
                              )
                              .map((point) => ({
                                id: point.id,
                                label: point.label,
                                x: point.priceUsd as number,
                                y: point.winRate as number,
                                tone: point.tone,
                              }))}
                          />
                        ) : null}
                        <BenchmarkFrontierChart
                          title="Performance vs Speed"
                          subtitle="Median model response time on successful runs versus success rate."
                          xLabel="Median model response time"
                          dataTestId="speed-frontier"
                          formatXValue={(value) => formatDurationMs(Math.round(value))}
                          points={frontierPoints
                            .filter(
                              (point) =>
                                typeof point.latencyMs === "number" && typeof point.winRate === "number"
                            )
                            .map((point) => ({
                              id: point.id,
                              label: point.label,
                              x: Math.round(point.latencyMs as number),
                              y: point.winRate as number,
                              tone: point.tone,
                            }))}
                        />
                      </div>
                    </div>

                    {hasPricingData ? (
                      <div
                        className="rounded-xl border border-slate-200/80 bg-slate-50/80 px-4 py-3"
                        data-testid="pricing-method-note"
                      >
                        <div className="flex flex-col gap-2 xl:flex-row xl:items-center xl:justify-between">
                          <div className="text-xs text-muted-foreground">
                            Price uses mean run cost across all attempts from run-level prompt and
                            completion token totals. Run trace links expose the underlying traces.
                          </div>
                          <div className="flex flex-wrap gap-2 text-[11px]">
                            {pricingReferenceRow?.pricingCapturedAt ? (
                              <Badge variant="outline" className="font-mono">
                                Captured {formatDateLabel(pricingReferenceRow.pricingCapturedAt)}
                              </Badge>
                            ) : null}
                            {pricingReferenceRow?.pricingSourceUrl ? (
                              <a
                                className="inline-flex items-center rounded-full border border-slate-200 bg-white px-2.5 py-1 font-mono text-slate-700 transition-colors hover:border-slate-300 hover:text-slate-900"
                                href={pricingReferenceRow.pricingSourceUrl}
                                rel="noreferrer"
                                target="_blank"
                              >
                                Pricing source
                              </a>
                            ) : null}
                          </div>
                        </div>
                      </div>
                    ) : null}
                  </div>

                  {hasPricingData && lossSpendRows.length > 0 ? (
                    <Card
                      className="border-slate-200/80 bg-white/80 p-4"
                      data-testid="failure-cost-hotspots"
                    >
                      <div className="flex flex-col gap-1">
                        <div className="text-sm font-medium">Failure cost hotspots</div>
                        <div className="text-xs text-muted-foreground">
                          Mean benchmark-run cost on losses for the current view. Higher values
                          indicate expensive failures.
                        </div>
                      </div>
                      <div className="mt-3 overflow-x-auto">
                        <table className="w-full text-sm">
                          <thead className="bg-muted/40 text-xs text-muted-foreground">
                            <tr>
                              <th className="px-3 py-2 text-left font-medium">Run</th>
                              <th className="px-3 py-2 text-right font-medium">Mean loss cost</th>
                              <th className="px-3 py-2 text-right font-medium">
                                Mean loss response time
                              </th>
                              <th className="px-3 py-2 text-right font-medium">Mean loss tokens</th>
                              <th className="px-3 py-2 text-left font-medium">Reasons</th>
                            </tr>
                          </thead>
                          <tbody>
                            {lossSpendRows.map((row) => (
                              <tr key={`loss-${row.key}`} className="border-t">
                                <td className="px-3 py-2 font-medium">{row.label}</td>
                                <td className="px-3 py-2 text-right font-mono text-xs">
                                  {formatUsd(row.meanEstimatedCostUsdLoss)}
                                </td>
                                <td className="px-3 py-2 text-right font-mono text-xs">
                                  {formatDurationMs(row.meanLossLatencyMs)}
                                </td>
                                <td className="px-3 py-2 text-right font-mono text-xs">
                                  {formatNumber(row.meanLossTokens)}
                                </td>
                                <td className="px-3 py-2 text-xs text-muted-foreground">
                                  {row.lossReasonText}
                                </td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      </div>
                    </Card>
                  ) : null}

                  {focusedRow ? (
                    <Card
                      className="border-slate-200/80 bg-white/80 p-4"
                      data-testid="focused-analysis"
                    >
                      <div className="flex flex-col gap-2 lg:flex-row lg:items-start lg:justify-between">
                        <div className="space-y-1">
                          <div className="text-sm font-medium">Focused model analysis</div>
                          <div className="text-xs text-muted-foreground">
                            Hover or click a row in the table to inspect its task-group profile and
                            navigation patterns.
                          </div>
                        </div>
                        <div className="flex flex-wrap gap-1.5">
                          <Badge variant="outline" className="text-[11px] font-mono">
                            {focusedRow.model}
                          </Badge>
                          {focusedRow.rank !== null ? (
                            <Badge variant="outline" className="text-[11px] font-mono">
                              rank:{formatNumber(focusedRow.rank)}
                            </Badge>
                          ) : null}
                          <Badge variant="outline" className="text-[11px] font-mono">
                            success:{formatPercent(focusedRow.winRate)}
                          </Badge>
                          {focusedSuiteStatus ? (
                            <Badge
                              variant="outline"
                              className={cn(
                                "text-[11px] font-mono",
                                focusedSuiteStatus === "graph-native"
                                  ? "border-emerald-500/50 text-emerald-700 dark:text-emerald-300"
                                  : "border-amber-500/50 text-amber-700 dark:text-amber-300"
                              )}
                            >
                              {focusedSuiteStatus}
                            </Badge>
                          ) : null}
                        </div>
                      </div>

                      {focusedRow.suiteIds[0] && focusedSuiteDetail ? (
                        <div className="mt-3 rounded-md border bg-muted/20 px-3 py-2 text-xs text-muted-foreground">
                          <div className="font-medium text-foreground">
                            Suite: {focusedSuiteDetail.benchmark_label || focusedRow.suiteIds[0]}
                          </div>
                          <div className="mt-1 font-mono">status:{focusedSuiteStatus || "unknown"}</div>
                          <div className="mt-1 font-mono">
                            generator:{focusedSuiteDetail.generator_version || "—"}
                          </div>
                          {typeof focusedSuiteDetail.item_count === "number" ? (
                            <div className="mt-1 font-mono">
                              items:{formatNumber(focusedSuiteDetail.item_count)}
                            </div>
                          ) : null}
                          {focusedSuiteDetail.notes?.[0] ? (
                            <div className="mt-1">{humanizeUiCopy(focusedSuiteDetail.notes?.[0])}</div>
                          ) : null}
                        </div>
                      ) : null}

                      <div className="mt-4 grid grid-cols-1 gap-4 xl:grid-cols-3">
                        <div className="space-y-3 xl:col-span-1">
                          <div>
                            <div className="text-sm font-medium">Weakness areas</div>
                            <div className="mt-2 text-xs text-muted-foreground">
                              Strongest task group:{" "}
                              <span className="font-mono text-foreground">
                                {displaySliceLabel(focusedRow.diagnostics?.strongest_slice_id)}
                              </span>
                              {" · "}
                              delta{" "}
                              <span className="font-mono text-foreground">
                                {formatPercent(
                                  typeof focusedRow.diagnostics?.strongest_delta_vs_core === "number"
                                    ? focusedRow.diagnostics?.strongest_delta_vs_core
                                    : null
                                )}
                              </span>
                            </div>
                            <div className="text-xs text-muted-foreground">
                              Weakest task group:{" "}
                              <span className="font-mono text-foreground">
                                {displaySliceLabel(focusedRow.diagnostics?.weakest_slice_id)}
                              </span>
                              {" · "}
                              delta{" "}
                              <span className="font-mono text-foreground">
                                {formatPercent(
                                  typeof focusedRow.diagnostics?.weakest_delta_vs_core === "number"
                                    ? focusedRow.diagnostics?.weakest_delta_vs_core
                                    : null
                                )}
                              </span>
                            </div>
                          </div>

                          <div className="rounded-md border">
                            <div className="border-b bg-muted/30 px-3 py-2 text-xs font-medium text-muted-foreground">
                              Task-group profile
                            </div>
                            <div className="divide-y">
                              {Object.entries(focusedDiagnosticSlices)
                                .sort(([leftId], [rightId]) => {
                                  if (leftId === "core_rank_v1") return -1;
                                  if (rightId === "core_rank_v1") return 1;
                                  return leftId.localeCompare(rightId);
                                })
                                .map(([sliceKey, sliceValue]) => (
                                  <div
                                    key={`${focusedRow.key}-${sliceKey}`}
                                    className="flex items-center justify-between px-3 py-2 text-xs"
                                  >
                                    <div className="text-foreground">{displaySliceLabel(sliceKey)}</div>
                                    <div className="font-mono text-muted-foreground">
                                      {formatPercent(
                                        typeof sliceValue?.win_rate === "number" ? sliceValue.win_rate : null
                                      )}
                                      {" · "}
                                      {formatPercent(
                                        typeof sliceValue?.delta_vs_core === "number"
                                          ? sliceValue.delta_vs_core
                                          : null
                                      )}
                                    </div>
                                  </div>
                                ))}
                            </div>
                          </div>
                        </div>

                        <div className="space-y-3 xl:col-span-1">
                          <div>
                            <div className="text-sm font-medium">Navigation patterns</div>
                            <div className="mt-2 grid grid-cols-2 gap-2">
                              <div className="rounded-md border bg-muted/20 px-3 py-2">
                                <div className="text-[11px] text-muted-foreground">Average tries</div>
                                <div className="font-mono text-sm">
                                  {formatNumber(
                                    typeof focusedRow.behavior?.mean_attempt_count === "number"
                                      ? focusedRow.behavior?.mean_attempt_count
                                      : null,
                                    2
                                  )}
                                </div>
                              </div>
                              <div className="rounded-md border bg-muted/20 px-3 py-2">
                                <div className="text-[11px] text-muted-foreground">Retry rate</div>
                                <div className="font-mono text-sm">
                                  {formatPercent(
                                    typeof focusedRow.behavior?.retry_step_rate === "number"
                                      ? focusedRow.behavior?.retry_step_rate
                                      : null
                                  )}
                                </div>
                              </div>
                              <div className="rounded-md border bg-muted/20 px-3 py-2">
                                <div className="text-[11px] text-muted-foreground">Backtrack rate</div>
                                <div className="font-mono text-sm">
                                  {formatPercent(
                                    typeof focusedRow.behavior?.revisit_rate === "number"
                                      ? focusedRow.behavior?.revisit_rate
                                      : null
                                  )}
                                </div>
                              </div>
                              <div className="rounded-md border bg-muted/20 px-3 py-2">
                                <div className="text-[11px] text-muted-foreground">Moves to broad pages</div>
                                <div className="font-mono text-sm">
                                  {formatPercent(
                                    typeof focusedRow.behavior?.hub_move_rate === "number"
                                      ? focusedRow.behavior?.hub_move_rate
                                      : null
                                  )}
                                </div>
                              </div>
                              <div className="rounded-md border bg-muted/20 px-3 py-2">
                                <div className="text-[11px] text-muted-foreground">Moves into dead ends</div>
                                <div className="font-mono text-sm">
                                  {formatPercent(
                                    typeof focusedRow.behavior?.dead_end_move_rate === "number"
                                      ? focusedRow.behavior?.dead_end_move_rate
                                      : null
                                  )}
                                </div>
                              </div>
                              <div className="rounded-md border bg-muted/20 px-3 py-2">
                                <div className="text-[11px] text-muted-foreground">Invalid answer rate</div>
                                <div className="font-mono text-sm">
                                  {formatPercent(
                                    typeof focusedRow.behavior?.bad_answer_step_rate === "number"
                                      ? focusedRow.behavior?.bad_answer_step_rate
                                      : null
                                  )}
                                </div>
                              </div>
                            </div>
                          </div>
                        </div>

                        <div className="space-y-3 xl:col-span-1">
                          <div className="text-sm font-medium">Example decisions</div>
                          {Object.entries(focusedExamples).length === 0 ? (
                            <div className="rounded-md border bg-muted/20 px-3 py-4 text-xs text-muted-foreground">
                              No captured examples for the current view.
                            </div>
                          ) : (
                            Object.entries(focusedExamples).map(([exampleKey, example]) => (
                              <div
                                key={`${focusedRow.key}-${exampleKey}`}
                                className="rounded-md border bg-muted/20 px-3 py-3"
                              >
                                <div className="flex items-center justify-between gap-2">
                                  <div className="text-xs font-medium capitalize text-foreground">
                                    {exampleKey.replaceAll("_", " ")}
                                  </div>
                                  <div className="text-[11px] font-mono text-muted-foreground">
                                    {example?.current_article || "—"} → {example?.selected_title || "—"}
                                  </div>
                                </div>
                                <div className="mt-1 text-[11px] text-muted-foreground">
                                  {example?.slice_id ? (
                                    <span className="font-mono">
                                      task-group:{displaySliceLabel(example.slice_id)}
                                    </span>
                                  ) : null}
                                  {example?.reason ? (
                                    <span className="ml-2 font-mono">reason:{example.reason}</span>
                                  ) : null}
                                  {typeof example?.attempt_count === "number" ? (
                                    <span className="ml-2 font-mono">tries:{formatNumber(example.attempt_count)}</span>
                                  ) : null}
                                </div>
                                <div className="mt-2 text-xs text-muted-foreground">
                                  {formatExamplePreview(example?.preview)}
                                </div>
                              </div>
                            ))
                          )}
                        </div>
                      </div>
                    </Card>
                  ) : null}
                </div>
              </details>
            ) : null}

            <div className="text-xs text-muted-foreground">
              Republish the public leaderboard with{" "}
              <span className="font-mono">python scripts/publish_frontier_standard_bundle.py</span>.
            </div>
          </div>
        )}
      </Card>
    </div>
  );
}
