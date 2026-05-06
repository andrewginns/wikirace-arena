import { normalizeWikiTitle } from "@/lib/wiki-title";

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

function isHopTerminalStep(step: StepLike | null | undefined) {
  return step?.type === "move" || step?.type === "win" || step?.type === "lose";
}

function stepArticleForHop(stepArticle: string | null | undefined, currentArticle: string) {
  if (typeof stepArticle !== "string" || stepArticle.trim().length === 0) {
    return currentArticle;
  }
  const articleWithoutFragment = stepArticle.split("#", 1)[0];
  if (normalizeWikiTitle(stepArticle).length === 0) {
    return currentArticle;
  }
  return articleWithoutFragment;
}

export function computeHopsFromSteps(
  steps: readonly StepLike[] | null | undefined,
  startArticle?: string | null
) {
  const hopCounts = computeHopCountsByStepIndex(steps, startArticle);
  return hopCounts[hopCounts.length - 1] ?? 0;
}

export function computeHopCountsByStepIndex(
  steps: readonly StepLike[] | null | undefined,
  startArticle?: string | null
) {
  if (!steps || steps.length === 0) return [0];

  const hopCounts: number[] = [];
  let hops = 0;
  let currentArticle =
    typeof startArticle === "string" && startArticle.trim().length > 0
      ? startArticle.split("#", 1)[0]
      : "";

  for (const step of steps) {
    const article = stepArticleForHop(step?.article, currentArticle);

    if (step?.type === "start") {
      currentArticle = article;
      hopCounts.push(hops);
      continue;
    }

    if (
      isHopTerminalStep(step) &&
      article &&
      normalizeWikiTitle(article) !== normalizeWikiTitle(currentArticle)
    ) {
      hops += 1;
    }

    if (article) {
      currentArticle = article;
    }
    hopCounts.push(hops);
  }

  return hopCounts;
}

export function currentArticleFromSteps(
  steps: readonly StepLike[] | null | undefined,
  fallback: string
) {
  if (!steps) return fallback;
  for (let index = steps.length - 1; index >= 0; index -= 1) {
    const article = steps[index]?.article;
    if (typeof article !== "string" || article.trim().length === 0) continue;
    if (normalizeWikiTitle(article).length === 0) continue;
    return article.split("#", 1)[0];
  }
  return fallback.split("#", 1)[0] || fallback;
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
