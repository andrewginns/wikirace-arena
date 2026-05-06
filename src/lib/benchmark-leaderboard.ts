import { llmDisplayNameOverride, llmModelLabel, llmModelShortName } from "@/lib/llm-display";

export type MetricSummary = {
  min?: number | null;
  median?: number | null;
  mean?: number | null;
  max?: number | null;
};

export type LegacyLeaderboardBucketV1 = {
  total_runs: number;
  wins: number;
  losses: number;
  win_rate: number;
  score_sum: number;
  score_mean: number | null;
  hops_win: MetricSummary;
  duration_ms_win: MetricSummary;
  total_tokens_win: MetricSummary;
  tokens_per_hop_win: MetricSummary;
  llm_latency_ms_per_hop_win: MetricSummary;
};

export type LegacyLeaderboardSummaryV1 = {
  version: number;
  source_jsonl: string;
  weights: Record<string, number>;
  meta?: {
    dataset_ids?: string[];
    model_settings?: BenchmarkModelSettings;
    budgets?: BenchmarkBudgets;
  };
  overall: LegacyLeaderboardBucketV1;
  tiers: Record<string, LegacyLeaderboardBucketV1>;
};

export type LegacyLeaderboardEntryV1 = {
  rank?: number;
  label: string;
  summary: LegacyLeaderboardSummaryV1;
};

export type LegacyLeaderboardFileV1 = {
  version: number;
  generated_at: string;
  dataset_filter: string | null;
  weights: Record<string, number>;
  entries: LegacyLeaderboardEntryV1[];
};

export type BenchmarkModelSettings = {
  model?: string | null;
  run_kind?: "human" | "llm" | null;
  player_name?: string | null;
  api_base?: string | null;
  openai_api_mode?: string | null;
  openai_reasoning_effort?: string | null;
  openai_reasoning_summary?: string | null;
  anthropic_thinking_budget_tokens?: number | null;
  google_thinking_config?: Record<string, unknown> | null;
};

export type BenchmarkBehaviorExample = {
  category?: string | null;
  run_id?: string | null;
  matchup_id?: string | null;
  slice_id?: string | null;
  start?: string | null;
  target?: string | null;
  current_article?: string | null;
  selected_title?: string | null;
  step_type?: string | null;
  reason?: string | null;
  attempt_count?: number | null;
  preview?: string | null;
};

export type BenchmarkBehaviorAnalysis = {
  llm_steps?: number | null;
  decision_steps?: number | null;
  mean_attempt_count?: number | null;
  retry_step_rate?: number | null;
  bad_answer_step_rate?: number | null;
  revisit_rate?: number | null;
  hub_move_rate?: number | null;
  dead_end_move_rate?: number | null;
  examples?: Record<string, BenchmarkBehaviorExample> | null;
};

export type BenchmarkDiagnosticAnalysis = {
  core_slice_id?: string | null;
  strongest_slice_id?: string | null;
  strongest_delta_vs_core?: number | null;
  weakest_slice_id?: string | null;
  weakest_delta_vs_core?: number | null;
  slices?: Record<
    string,
    {
      win_rate?: number | null;
      delta_vs_core?: number | null;
    }
  > | null;
};

export type BenchmarkModelNarrative = {
  headline?: string | null;
  summary?: string | null;
  strengths?: string[] | null;
  watchouts?: string[] | null;
};

export type BenchmarkPairwiseNarrative = {
  models?: string[] | null;
  headline?: string | null;
  summary?: string | null;
  differences?: string[] | null;
};

export type BenchmarkSummaryAnalysis = {
  overall?: BenchmarkBehaviorAnalysis | null;
  slices?: Record<string, BenchmarkBehaviorAnalysis> | null;
  diagnostics?: BenchmarkDiagnosticAnalysis | null;
};

export type BenchmarkSuiteDetail = {
  suite_id: string;
  manifest_path?: string | null;
  generator_version?: string | null;
  generated_at?: string | null;
  db_sha256?: string | null;
  slice_counts?: Record<string, number> | null;
  notes?: string[] | null;
  is_seeded_fallback?: boolean | null;
  benchmark_label?: string | null;
  benchmark_role?: string | null;
  benchmark_visibility?: string | null;
  benchmark_description?: string | null;
  item_count?: number | null;
  composition?: Record<string, number> | null;
  family_counts?: Record<string, number> | null;
  focus_areas?: string[] | null;
  methodology_notes?: string[] | null;
  coverage_notes?: string[] | null;
  model_summaries?: Record<string, BenchmarkModelNarrative> | null;
  pairwise_summaries?: BenchmarkPairwiseNarrative[] | null;
};

export type BenchmarkBudgets = {
  max_hops?: number | null;
  max_links?: number | null;
  max_tokens?: number | null;
  max_tries?: number | null;
};

export type BenchmarkPricingMeta = {
  model?: string | null;
  tier?: string | null;
  captured_at?: string | null;
  source_url?: string | null;
  input_usd_per_million?: number | null;
  output_usd_per_million?: number | null;
  notes?: string[] | null;
};

export type BenchmarkBucketV2 = {
  total_runs: number;
  wins: number;
  losses: number;
  win_rate: number;
  score_sum?: number | null;
  score_mean?: number | null;
  legacy_score_v1_sum?: number | null;
  legacy_score_v1_mean?: number | null;
  score_v2?: number | null;
  hops_win?: MetricSummary;
  hops_over_shortest_win?: MetricSummary;
  duration_ms_win?: MetricSummary;
  duration_ms_all?: MetricSummary;
  duration_ms_loss?: MetricSummary;
  total_tokens_win?: MetricSummary;
  total_tokens_all?: MetricSummary;
  total_tokens_loss?: MetricSummary;
  tokens_per_hop_win?: MetricSummary;
  llm_latency_ms_per_hop_win?: MetricSummary;
  llm_latency_ms_win?: MetricSummary;
  llm_latency_ms_all?: MetricSummary;
  llm_latency_ms_loss?: MetricSummary;
  estimated_cost_usd_win?: MetricSummary;
  estimated_cost_usd_all?: MetricSummary;
  estimated_cost_usd_loss?: MetricSummary;
  mean_total_tokens_all?: number | null;
  mean_llm_latency_ms_all?: number | null;
  mean_estimated_cost_usd_all?: number | null;
  mean_total_tokens_loss?: number | null;
  mean_llm_latency_ms_loss?: number | null;
  mean_estimated_cost_usd_loss?: number | null;
  loss_reasons?: Record<string, number>;
};

export type BenchmarkSummaryV2 = {
  version: number;
  source_jsonl: string;
  weights: Record<string, number>;
  meta?: {
    dataset_ids?: string[];
    suite_ids?: string[];
    slice_ids?: string[];
    setup_ids?: string[];
    prompt_versions?: string[];
    semantics_versions?: string[];
    models?: string[];
    model_settings?: BenchmarkModelSettings | BenchmarkModelSettings[];
    budgets?: BenchmarkBudgets | BenchmarkBudgets[];
    pricing?: BenchmarkPricingMeta | BenchmarkPricingMeta[];
    git_shas?: string[];
    db_paths?: string[];
    db_sha256s?: string[];
    raw_output_modes?: string[];
    attempt_record_count?: number;
  };
  overall: BenchmarkBucketV2;
  tiers?: Record<string, BenchmarkBucketV2>;
  slices?: Record<string, BenchmarkBucketV2>;
  analysis?: BenchmarkSummaryAnalysis;
};

export type BenchmarkLeaderboardEntryV2 = {
  rank?: number;
  label: string;
  source_jsonl?: string;
  source_summary_json?: string | null;
  source_viewer_json?: string | null;
  viewer_public_path?: string | null;
  viewer_url?: string | null;
  summary: BenchmarkSummaryV2;
};

export type BenchmarkLeaderboardFileV2 = {
  version: 2;
  generated_at: string;
  dataset_filter: string | null;
  default_slice_id?: string | null;
  sort_mode?: string;
  weights: Record<string, number>;
  available_dataset_ids?: string[];
  available_suite_ids?: string[];
  suite_details?: Record<string, BenchmarkSuiteDetail>;
  available_slice_ids?: string[];
  available_setup_ids?: string[];
  available_prompt_versions?: string[];
  available_semantics_versions?: string[];
  entries: BenchmarkLeaderboardEntryV2[];
};

export function isBenchmarkLeaderboardV2(raw: unknown): raw is BenchmarkLeaderboardFileV2 {
  if (!raw || typeof raw !== "object") return false;
  const candidate = raw as BenchmarkLeaderboardFileV2;
  return candidate.version === 2 && Array.isArray(candidate.entries);
}

export function isLegacyLeaderboardV1(raw: unknown): raw is LegacyLeaderboardFileV1 {
  if (!raw || typeof raw !== "object") return false;
  const candidate = raw as LegacyLeaderboardFileV1;
  return Array.isArray(candidate.entries) && candidate.version !== 2;
}

export function firstModelSettings(
  value: BenchmarkModelSettings | BenchmarkModelSettings[] | null | undefined
): BenchmarkModelSettings | null {
  if (Array.isArray(value)) {
    const first = value[0];
    return first && typeof first === "object" ? first : null;
  }
  return value && typeof value === "object" ? value : null;
}

export function firstBudgets(
  value: BenchmarkBudgets | BenchmarkBudgets[] | null | undefined
): BenchmarkBudgets | null {
  if (Array.isArray(value)) {
    const first = value[0];
    return first && typeof first === "object" ? first : null;
  }
  return value && typeof value === "object" ? value : null;
}

export function firstPricing(
  value: BenchmarkPricingMeta | BenchmarkPricingMeta[] | null | undefined
): BenchmarkPricingMeta | null {
  if (Array.isArray(value)) {
    const first = value[0];
    return first && typeof first === "object" ? first : null;
  }
  return value && typeof value === "object" ? value : null;
}

export function benchmarkEntryDisplayLabel(entry: BenchmarkLeaderboardEntryV2) {
  const settings = firstModelSettings(entry.summary?.meta?.model_settings);
  const displayOverride = llmDisplayNameOverride({
    playerName: settings?.player_name,
    model: settings?.model,
  });
  if (settings?.run_kind === "human" && displayOverride) return displayOverride;
  if (settings?.run_kind === "human") {
    return llmModelShortName(settings?.model || entry.label) || entry.label;
  }
  if (displayOverride && settings?.model === "human") return displayOverride;
  const label =
    llmModelLabel({
      model: settings?.model,
      openaiReasoningEffort: settings?.openai_reasoning_effort,
      anthropicThinkingBudgetTokens: settings?.anthropic_thinking_budget_tokens,
    }) || null;
  if (label) return label;
  const rawModel = settings?.model;
  return llmModelShortName(rawModel || entry.label) || entry.label;
}

export function benchmarkBucketForSlice(
  summary: BenchmarkSummaryV2,
  sliceId: string | null
): BenchmarkBucketV2 | null {
  if (sliceId) {
    const bucket = summary.slices?.[sliceId];
    if (bucket) return bucket;
    return null;
  }
  return summary.overall;
}

export function metricMedian(metric: MetricSummary | undefined | null) {
  return typeof metric?.median === "number" ? metric.median : null;
}

export function lexicographicCompareBuckets(
  left: BenchmarkBucketV2,
  right: BenchmarkBucketV2,
  leftLabel: string,
  rightLabel: string
) {
  const winRateDiff = (right.win_rate ?? 0) - (left.win_rate ?? 0);
  if (Math.abs(winRateDiff) > 1e-12) return winRateDiff;

  const leftHops = metricMedian(left.hops_over_shortest_win);
  const rightHops = metricMedian(right.hops_over_shortest_win);
  if (leftHops !== rightHops) {
    if (leftHops === null) return 1;
    if (rightHops === null) return -1;
    return leftHops - rightHops;
  }

  const leftTokens = metricMedian(left.total_tokens_win);
  const rightTokens = metricMedian(right.total_tokens_win);
  if (leftTokens !== rightTokens) {
    if (leftTokens === null) return 1;
    if (rightTokens === null) return -1;
    return leftTokens - rightTokens;
  }

  const leftLatency = metricMedian(left.llm_latency_ms_win);
  const rightLatency = metricMedian(right.llm_latency_ms_win);
  if (leftLatency !== rightLatency) {
    if (leftLatency === null) return 1;
    if (rightLatency === null) return -1;
    return leftLatency - rightLatency;
  }

  return leftLabel.localeCompare(rightLabel);
}

export function uniqueStrings(values: Array<string | null | undefined>) {
  return [...new Set(values.filter((value): value is string => Boolean(value && value.trim())))]
    .map((value) => value.trim())
    .sort();
}
