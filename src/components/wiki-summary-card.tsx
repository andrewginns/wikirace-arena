"use client";

import { useEffect, useMemo, useState } from "react";
import { ExternalLink, ImageOff } from "lucide-react";
import { cn } from "@/lib/utils";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";

type WikiSummary = {
  title: string;
  description: string | null;
  extract: string | null;
  thumbnailUrl: string | null;
  url: string;
};

const SUMMARY_CACHE = new Map<string, WikiSummary>();

function toRestTitle(title: string) {
  return encodeURIComponent(title.replaceAll(" ", "_"));
}

function toWikiUrl(title: string) {
  return `https://simple.wikipedia.org/wiki/${encodeURIComponent(title.replaceAll(" ", "_"))}`;
}

async function fetchWikiSummary(title: string): Promise<WikiSummary> {
  const url = `https://simple.wikipedia.org/api/rest_v1/page/summary/${toRestTitle(title)}`;
  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`Failed wiki summary (${res.status})`);
  }

  const data = (await res.json()) as {
    title?: string;
    description?: string;
    extract?: string;
    thumbnail?: { source?: string };
    originalimage?: { source?: string };
    content_urls?: { desktop?: { page?: string } };
  };

  const thumbnailFromApi = typeof data.thumbnail?.source === "string" ? data.thumbnail.source : null;
  const originalFromApi =
    typeof data.originalimage?.source === "string" ? data.originalimage.source : null;
  const thumbnailUrl = thumbnailFromApi ?? originalFromApi;
  const wikiUrl =
    typeof data.content_urls?.desktop?.page === "string" ? data.content_urls.desktop.page : null;

  return {
    title: typeof data.title === "string" ? data.title : title,
    description: typeof data.description === "string" ? data.description : null,
    extract: typeof data.extract === "string" ? data.extract : null,
    thumbnailUrl,
    url: wikiUrl ?? toWikiUrl(title),
  };
}

export default function WikiSummaryCard({
  title,
  className,
}: {
  title: string;
  className?: string;
}) {
  const cacheKey = useMemo(() => title.trim(), [title]);
  const [summary, setSummary] = useState<WikiSummary | null>(() =>
    SUMMARY_CACHE.get(cacheKey) ?? null
  );
  const [status, setStatus] = useState<"idle" | "loading" | "ready" | "error">(() =>
    SUMMARY_CACHE.has(cacheKey) ? "ready" : "idle"
  );

  useEffect(() => {
    const effectiveTitle = cacheKey;
    if (!effectiveTitle) {
      setSummary(null);
      setStatus("idle");
      return;
    }

    const cached = SUMMARY_CACHE.get(effectiveTitle);
    if (cached) {
      setSummary(cached);
      setStatus("ready");
      return;
    }

    let cancelled = false;
    setStatus("loading");
    fetchWikiSummary(effectiveTitle)
      .then((next) => {
        SUMMARY_CACHE.set(effectiveTitle, next);
        if (cancelled) return;
        setSummary(next);
        setStatus("ready");
      })
      .catch(() => {
        if (cancelled) return;
        setSummary(null);
        setStatus("error");
      });

    return () => {
      cancelled = true;
    };
  }, [cacheKey]);

  const resolvedTitle = summary?.title || title;
  const resolvedUrl = summary?.url || toWikiUrl(title);

  return (
    <Card className={cn("p-3", className)}>
      <div className="flex items-start gap-3">
        {summary?.thumbnailUrl ? (
          <img
            src={summary.thumbnailUrl}
            alt=""
            className="h-14 w-14 rounded-md border object-cover flex-shrink-0"
            loading="lazy"
          />
        ) : (
          <div
            className={cn(
              "h-14 w-14 rounded-md border bg-muted/30 flex items-center justify-center text-muted-foreground flex-shrink-0",
              status === "loading" && "animate-pulse motion-reduce:animate-none"
            )}
            aria-label={status === "loading" ? "Loading" : "No image"}
          >
            <ImageOff className="h-4 w-4" aria-hidden="true" />
          </div>
        )}

        <div className="min-w-0 flex-1">
          <div className="text-sm font-medium truncate">{resolvedTitle}</div>
          {summary?.description ? (
            <div className="mt-0.5 text-xs text-muted-foreground truncate">
              {summary.description}
            </div>
          ) : null}
          {summary?.extract ? (
            <div className="mt-1 text-xs text-muted-foreground line-clamp-2">
              {summary.extract}
            </div>
          ) : status === "error" ? (
            <div className="mt-1 text-xs text-muted-foreground">
              Preview unavailable.
            </div>
          ) : null}

          <div className="mt-2 flex items-center gap-2">
            <Button asChild variant="outline" size="sm" className="h-7 text-xs">
              <a href={resolvedUrl} target="_blank" rel="noopener noreferrer">
                Open
                <ExternalLink className="ml-1 h-3.5 w-3.5" aria-hidden="true" />
              </a>
            </Button>
          </div>
        </div>
      </div>
    </Card>
  );
}
