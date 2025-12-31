export type StepLike = {
  type?: string;
  article?: string;
  metadata?: Record<string, unknown>;
};

export type TokenTotals = {
  promptTokens: number | null;
  completionTokens: number | null;
  totalTokens: number | null;
};

export function computeHopsFromSteps(steps: readonly StepLike[] | null | undefined) {
  return Math.max(0, (steps?.length ?? 0) - 1);
}

export function currentArticleFromSteps(
  steps: readonly StepLike[] | null | undefined,
  fallback: string
) {
  const last = steps && steps.length > 0 ? steps[steps.length - 1] : null;
  const article = last?.article;
  return typeof article === "string" && article.trim().length > 0 ? article : fallback;
}

export function lastLlmMeta(steps: readonly StepLike[] | null | undefined) {
  if (!steps) return null;
  for (let i = steps.length - 1; i >= 0; i -= 1) {
    const meta = steps[i]?.metadata;
    if (!meta) continue;
    const selectedIndex = meta.selected_index;
    const output = meta.llm_output;
    if (typeof selectedIndex === "number" || typeof output === "string") {
      return meta;
    }
  }
  return null;
}

export function sumTokenUsageFromSteps(steps: readonly StepLike[] | null | undefined) {
  if (!steps) return null;
  let promptTokens = 0;
  let completionTokens = 0;
  let totalTokens = 0;
  let sawPromptTokens = false;
  let sawCompletionTokens = false;
  let sawTotalTokens = false;

  for (const step of steps) {
    const meta = step?.metadata;
    if (!meta) continue;

    const prompt =
      typeof meta.prompt_tokens === "number"
        ? meta.prompt_tokens
        : typeof meta.input_tokens === "number"
          ? meta.input_tokens
          : null;
    const completion =
      typeof meta.completion_tokens === "number"
        ? meta.completion_tokens
        : typeof meta.output_tokens === "number"
          ? meta.output_tokens
          : null;
    const total = typeof meta.total_tokens === "number" ? meta.total_tokens : null;

    if (typeof prompt === "number") {
      promptTokens += prompt;
      sawPromptTokens = true;
    }
    if (typeof completion === "number") {
      completionTokens += completion;
      sawCompletionTokens = true;
    }

    const resolvedTotal =
      typeof total === "number"
        ? total
        : typeof prompt === "number" || typeof completion === "number"
          ? (prompt ?? 0) + (completion ?? 0)
          : null;

    if (typeof resolvedTotal === "number") {
      totalTokens += resolvedTotal;
      sawTotalTokens = true;
    }
  }

  if (!sawPromptTokens && !sawCompletionTokens && !sawTotalTokens) return null;
  return {
    promptTokens: sawPromptTokens ? promptTokens : null,
    completionTokens: sawCompletionTokens ? completionTokens : null,
    totalTokens: sawTotalTokens ? totalTokens : null,
  } satisfies TokenTotals;
}
