export type ViewerRunLike = {
  start_article: string;
  steps: readonly string[];
};

export function viewerRunHops(run: ViewerRunLike): number {
  const steps = run.steps ?? [];
  if (steps.length === 0) return 0;

  // Most built-in datasets include the start article as step 0 (so hops/moves are steps - 1).
  // Some uploaded datasets may omit the explicit start step; in that case, treat each step as a hop.
  if (steps[0] === run.start_article) return Math.max(0, steps.length - 1);
  return steps.length;
}

export function formatHops(hops: number): string {
  return `${hops} ${hops === 1 ? "hop" : "hops"}`;
}

