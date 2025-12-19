"use client";

import { useEffect, useMemo, useState, type CSSProperties } from "react";
import { ImageOff } from "lucide-react";
import { cn } from "@/lib/utils";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";

type WikiSummary = {
  title: string;
  description: string | null;
  thumbnailUrl: string | null;
  imageUrl: string | null;
};

const SUMMARY_CACHE = new Map<string, WikiSummary>();

function toRestTitle(title: string) {
  return encodeURIComponent(title.replaceAll(" ", "_"));
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
    thumbnail?: { source?: string };
    originalimage?: { source?: string };
  };

  const thumbnailFromApi = typeof data.thumbnail?.source === "string" ? data.thumbnail.source : null;
  const originalFromApi =
    typeof data.originalimage?.source === "string" ? data.originalimage.source : null;
  const thumbnailUrl = thumbnailFromApi ?? originalFromApi;
  const imageUrl = originalFromApi ?? thumbnailUrl;

  return {
    title: typeof data.title === "string" ? data.title : title,
    description: typeof data.description === "string" ? data.description : null,
    thumbnailUrl,
    imageUrl,
  };
}

export default function WikiArticlePreview({
  title,
  size = 40,
  className,
}: {
  title: string;
  size?: number;
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

  const style: CSSProperties = { width: size, height: size };
  const titleText = summary?.title || title;
  const tooltip = summary?.description ? `${titleText} — ${summary.description}` : titleText;

  if (status === "loading" && !summary) {
    return (
      <div
        className={cn("rounded-md border bg-muted/40 animate-pulse flex-shrink-0", className)}
        style={style}
        aria-label={`Loading preview for ${title}`}
      />
    );
  }

  if (summary?.thumbnailUrl) {
    return (
      <Dialog>
        <DialogTrigger asChild>
          <button
            type="button"
            className={cn(
              "rounded-md border overflow-hidden flex-shrink-0 cursor-zoom-in hover:opacity-90 focus:outline-none focus:ring-2 focus:ring-primary focus:ring-offset-2",
              className
            )}
            style={style}
            aria-label={`Expand preview image for ${titleText}`}
            title={tooltip}
          >
            <img
              src={summary.thumbnailUrl}
              alt={`Preview image for ${titleText}`}
              className="h-full w-full object-cover"
              loading="lazy"
            />
          </button>
        </DialogTrigger>
        <DialogContent className="p-0 sm:max-w-3xl overflow-hidden">
          <DialogHeader className="p-4 pb-3">
            <DialogTitle className="text-base">{titleText}</DialogTitle>
            {summary.description ? (
              <DialogDescription className="text-xs">{summary.description}</DialogDescription>
            ) : null}
          </DialogHeader>
          <div className="border-t bg-muted/10 p-4">
            <img
              src={summary.imageUrl ?? summary.thumbnailUrl}
              alt={`Image for ${titleText}`}
              className="w-full max-h-[75vh] object-contain rounded-md border bg-background"
              loading="lazy"
            />
          </div>
        </DialogContent>
      </Dialog>
    );
  }

  return (
    <div
      className={cn(
        "rounded-md border bg-muted/30 flex items-center justify-center text-muted-foreground flex-shrink-0",
        className
      )}
      style={style}
      title={tooltip}
      aria-label={`No preview image for ${titleText}`}
      data-status={status}
    >
      <ImageOff className="h-4 w-4" aria-hidden="true" />
    </div>
  );
}
