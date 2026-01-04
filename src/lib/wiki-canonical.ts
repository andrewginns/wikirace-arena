import { API_BASE } from "@/lib/constants";
import { normalizeWikiTitle } from "@/lib/wiki-title";

type CanonicalCacheEntry = {
  value: string;
  expiresAtMs: number | null;
};

const CANONICAL_TITLE_CACHE_MAX = 1000;
const CANONICAL_TITLE_FAILURE_TTL_MS = 60_000;

const canonicalTitleCache = new Map<string, CanonicalCacheEntry>();
const canonicalTitleInFlight = new Map<string, Promise<string>>();

function cacheGet(key: string): string | undefined {
  const entry = canonicalTitleCache.get(key);
  if (!entry) return undefined;

  if (typeof entry.expiresAtMs === "number" && Date.now() > entry.expiresAtMs) {
    canonicalTitleCache.delete(key);
    return undefined;
  }

  // LRU-ish: bump the entry to the most-recent position on reads.
  canonicalTitleCache.delete(key);
  canonicalTitleCache.set(key, entry);
  return entry.value;
}

function cacheSet(key: string, value: string, ttlMs?: number) {
  const expiresAtMs = typeof ttlMs === "number" ? Date.now() + ttlMs : null;
  canonicalTitleCache.delete(key);
  canonicalTitleCache.set(key, { value, expiresAtMs });

  // Evict oldest entries (insertion order) to keep memory bounded.
  while (canonicalTitleCache.size > CANONICAL_TITLE_CACHE_MAX) {
    const oldestKey = canonicalTitleCache.keys().next().value as string | undefined;
    if (!oldestKey) break;
    canonicalTitleCache.delete(oldestKey);
  }
}

export async function canonicalizeTitle(title: string) {
  const key = normalizeWikiTitle(title);
  const cached = cacheGet(key);
  if (cached !== undefined) return cached;

  const inFlight = canonicalTitleInFlight.get(key);
  if (inFlight) return inFlight;

  const promise = (async () => {
    try {
      const response = await fetch(
        `${API_BASE}/canonical_title/${encodeURIComponent(title)}`
      );
      if (response.ok) {
        const data = (await response.json()) as { title?: unknown };
        if (typeof data.title === "string" && data.title.trim().length > 0) {
          cacheSet(key, data.title);
          return data.title;
        }
      }
    } catch {
      // ignore
    }

    // Avoid permanently caching failures (e.g. transient API downtime).
    cacheSet(key, title, CANONICAL_TITLE_FAILURE_TTL_MS);
    return title;
  })();

  canonicalTitleInFlight.set(key, promise);
  try {
    return await promise;
  } finally {
    canonicalTitleInFlight.delete(key);
  }
}
