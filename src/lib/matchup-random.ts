export function pickRandom<T>(items: readonly T[]): T | null {
  if (items.length === 0) return null;
  const idx = Math.floor(Math.random() * items.length);
  return items[idx] ?? null;
}

export function pickRandomDistinctPair(
  items: readonly string[],
  maxTries = 10
): { start: string; target: string } | null {
  if (items.length < 2) return null;

  const start = pickRandom(items);
  if (!start) return null;

  let target = pickRandom(items);
  if (!target) return null;

  let tries = 0;
  while (target === start && tries < maxTries) {
    target = pickRandom(items);
    if (!target) return null;
    tries += 1;
  }

  if (target === start) {
    const fallback = items.find((item) => item !== start);
    if (!fallback) return null;
    target = fallback;
  }
  return { start, target };
}
