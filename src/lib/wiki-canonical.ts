import { API_BASE } from "@/lib/constants";
import { normalizeWikiTitle } from "@/lib/wiki-title";

const canonicalTitleCache = new Map<string, string>();
const canonicalTitleInFlight = new Map<string, Promise<string>>();

export async function canonicalizeTitle(title: string) {
  const key = normalizeWikiTitle(title);
  const cached = canonicalTitleCache.get(key);
  if (cached) return cached;

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
          canonicalTitleCache.set(key, data.title);
          return data.title;
        }
      }
    } catch {
      // ignore
    }

    canonicalTitleCache.set(key, title);
    return title;
  })();

  canonicalTitleInFlight.set(key, promise);
  try {
    return await promise;
  } finally {
    canonicalTitleInFlight.delete(key);
  }
}

