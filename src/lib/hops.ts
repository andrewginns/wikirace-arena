import { normalizeWikiTitle } from "@/lib/wiki-title";

export type ViewerRunLike = {
  start_article: string;
  steps: readonly unknown[];
};

const VIEWER_RACE_STEP_TYPES = new Set(["start", "move", "win", "lose"]);

export function viewerRunStepArticles(steps: readonly unknown[]): string[] {
  const articles: string[] = [];
  for (const step of steps ?? []) {
    if (typeof step === "string") {
      if (step.trim()) articles.push(step);
      continue;
    }
    if (!step || typeof step !== "object") continue;

    const stepObject = step as { type?: unknown; article?: unknown };
    if (
      typeof stepObject.type !== "string" ||
      !VIEWER_RACE_STEP_TYPES.has(stepObject.type)
    ) {
      continue;
    }
    if (typeof stepObject.article === "string" && stepObject.article.trim()) {
      articles.push(stepObject.article);
    }
  }
  return articles;
}

export function viewerRunPathArticles(run: ViewerRunLike): string[] {
  const path: string[] = [];
  const pushIfNew = (article: unknown) => {
    if (typeof article !== "string") return;
    if (normalizeWikiTitle(article).length === 0) return;
    const articleWithoutFragment = article.split("#", 1)[0];
    const previous = path[path.length - 1];
    if (
      previous &&
      normalizeWikiTitle(previous) === normalizeWikiTitle(articleWithoutFragment)
    ) {
      return;
    }
    path.push(articleWithoutFragment);
  };

  pushIfNew(run.start_article);
  for (const article of viewerRunStepArticles(run.steps ?? [])) {
    pushIfNew(article);
  }
  return path;
}

export function viewerRunHops(run: ViewerRunLike): number {
  return Math.max(0, viewerRunPathArticles(run).length - 1);
}

export function formatHops(hops: number): string {
  return `${hops} ${hops === 1 ? "hop" : "hops"}`;
}
