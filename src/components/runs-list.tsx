"use client";

import { Card } from "@/components/ui/card";
import { cn } from "@/lib/utils";
import { useState, useEffect, useRef } from "react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Pause, Play } from "lucide-react";
import { formatHops, viewerRunHops } from "@/lib/hops";

interface Run {
  start_article: string;
  destination_article: string;
  steps: string[];
  result?: string;
  near_miss?: boolean;
}

interface RunsListProps {
  runs: Run[];
  onSelectRun: (runId: number) => void;
  selectedRunId: number | null;
  onTryRun?: (startArticle: string, destinationArticle: string) => void;
  pauseToken?: number | null;
  selectedRunIds?: Set<number>;
  onToggleRunSelected?: (runId: number) => void;
}

export default function RunsList({
  runs,
  onSelectRun,
  selectedRunId,
  onTryRun,
  pauseToken,
  selectedRunIds,
  onToggleRunSelected,
}: RunsListProps) {
  const [isPlaying, setIsPlaying] = useState(true);
  const [autoplaySpeed, setAutoplaySpeed] = useState<"slow" | "normal" | "fast">(
    "normal"
  );
  const timerRef = useRef<NodeJS.Timeout | null>(null);
  const listContainerRef = useRef<HTMLDivElement>(null);
  const runItemsRef = useRef<Map<number, HTMLDivElement>>(new Map());
  const userScrollLockRef = useRef(false);
  const programmaticScrollRef = useRef(false);
  const programmaticScrollTimeoutRef = useRef<number | null>(null);

  useEffect(() => {
    if (pauseToken === null || typeof pauseToken === "undefined") return;
    setIsPlaying(false);
  }, [pauseToken]);

  const _onSelectRun = (runId: number) => {
    onSelectRun(runId);
    setIsPlaying(false);
  };

  const isRunVisible = (runId: number) => {
    const container = listContainerRef.current;
    const element = runItemsRef.current.get(runId);
    if (!container || !element) return true;

    const containerRect = container.getBoundingClientRect();
    const elementRect = element.getBoundingClientRect();

    return (
      elementRect.bottom > containerRect.top && elementRect.top < containerRect.bottom
    );
  };

  const markUserScrolling = () => {
    if (!isPlaying) return;

    userScrollLockRef.current = true;

    // If the currently selected run is no longer visible, continuing playback
    // would require auto-scrolling (which is exactly what the user is trying
    // to avoid). Pause instead.
    if (selectedRunId !== null && !isRunVisible(selectedRunId)) {
      setIsPlaying(false);
    }
  };

  // Auto-play functionality
  useEffect(() => {
    const intervalMs =
      autoplaySpeed === "fast" ? 850 : autoplaySpeed === "slow" ? 2500 : 1500;

    if (isPlaying) {
      timerRef.current = setInterval(() => {
        if (runs.length === 0) return;
        
        const nextIndex = selectedRunId === null 
          ? 0 
          : (selectedRunId + 1) % runs.length;
        
        if (userScrollLockRef.current) {
          // Avoid changing scroll position while the user is scrolling.
          // If the next item isn't already visible, pause instead.
          if (!isRunVisible(nextIndex)) {
            setIsPlaying(false);
            return;
          }
        }

        onSelectRun(nextIndex);
      }, intervalMs);
    } else if (timerRef.current) {
      clearInterval(timerRef.current);
      timerRef.current = null;
    }

    return () => {
      if (timerRef.current) {
        clearInterval(timerRef.current);
      }
    };
  }, [autoplaySpeed, isPlaying, selectedRunId, runs, onSelectRun]);

  useEffect(() => {
    return () => {
      if (programmaticScrollTimeoutRef.current) {
        window.clearTimeout(programmaticScrollTimeoutRef.current);
      }
    };
  }, []);

  // Scroll selected run into view when it changes
  useEffect(() => {
    if (selectedRunId === null) return;
    if (isPlaying && userScrollLockRef.current) return;

    const selectedElement = runItemsRef.current.get(selectedRunId);
    const container = listContainerRef.current;
    if (!selectedElement || !container) return;

    const containerRect = container.getBoundingClientRect();
    const elementRect = selectedElement.getBoundingClientRect();
    const elementTop = elementRect.top - containerRect.top + container.scrollTop;
    const elementBottom = elementTop + elementRect.height;
    const viewTop = container.scrollTop;
    const viewBottom = viewTop + container.clientHeight;

    let nextScrollTop: number | null = null;
    if (elementTop < viewTop) {
      nextScrollTop = elementTop;
    } else if (elementBottom > viewBottom) {
      nextScrollTop = elementBottom - container.clientHeight;
    }

    if (nextScrollTop === null) return;

    programmaticScrollRef.current = true;
    container.scrollTo({ top: nextScrollTop, behavior: "smooth" });

    if (programmaticScrollTimeoutRef.current) {
      window.clearTimeout(programmaticScrollTimeoutRef.current);
    }
    programmaticScrollTimeoutRef.current = window.setTimeout(() => {
      programmaticScrollRef.current = false;
      programmaticScrollTimeoutRef.current = null;
    }, 1000);
  }, [selectedRunId, isPlaying]);

  const togglePlayPause = () => {
    setIsPlaying(prev => {
      const next = !prev;
      if (next) {
        userScrollLockRef.current = false;
      }
      return next;
    });
  };

  return (
    <div className="h-full w-full flex flex-col">
      <div className="space-y-2 mb-4">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="flex items-center gap-2">
            <Tooltip>
              <TooltipTrigger asChild>
                <Button 
                  size="sm" 
                  variant={isPlaying ? "secondary" : "outline"} 
                  onClick={togglePlayPause}
                  className="flex-shrink-0 h-9 px-3 gap-1"
                >
                  {isPlaying ? <Pause className="h-4 w-4" /> : <Play className="h-4 w-4" />}
                  <span className="hidden sm:inline">
                    Autoplay: {isPlaying ? "On" : "Off"}
                  </span>
                  <span className="sm:hidden">Autoplay</span>
                </Button>
              </TooltipTrigger>
              <TooltipContent side="top" align="end">
                Autoplay cycles through runs and updates the highlighted path.
              </TooltipContent>
            </Tooltip>

            <Tooltip>
              <TooltipTrigger asChild>
                <div>
                  <Select value={autoplaySpeed} onValueChange={setAutoplaySpeed}>
                    <SelectTrigger className="h-9 w-[110px]">
                      <SelectValue placeholder="Speed" />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="slow">Slow</SelectItem>
                      <SelectItem value="normal">Normal</SelectItem>
                      <SelectItem value="fast">Fast</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
              </TooltipTrigger>
              <TooltipContent side="top" align="end">
                Autoplay speed
              </TooltipContent>
            </Tooltip>
          </div>

          <div className="text-xs text-muted-foreground">
            {runs.length} run{runs.length === 1 ? "" : "s"}
          </div>
        </div>
      </div>

      <div
        ref={listContainerRef}
        className="flex-1 overflow-y-auto overflow-x-hidden space-y-3 pr-1"
        onWheel={markUserScrolling}
        onTouchStart={markUserScrolling}
        onTouchMove={markUserScrolling}
        onScroll={() => {
          if (!isPlaying) return;
          if (programmaticScrollRef.current) return;
          markUserScrolling();
        }}
      >
        {runs.map((run, originalIndex) => {
          const isNearMiss = run.near_miss;
          const isWin = run.result === "win";
          const hops = viewerRunHops(run);
          const isSelected = selectedRunIds?.has(originalIndex) ?? false;
          const stripeClass = isWin
            ? "border-l-green-500"
            : isNearMiss
              ? "border-l-amber-500"
              : run.result
                ? "border-l-red-500"
                : "border-l-transparent";
          return (
            <Card
              key={originalIndex}
              ref={(el) => {
                if (el) {
                  runItemsRef.current.set(originalIndex, el);
                } else {
                  runItemsRef.current.delete(originalIndex);
                }
              }}
              className={cn(
                "p-0 cursor-pointer transition-all border border-l-4 overflow-hidden",
                stripeClass,
                selectedRunId === originalIndex
                  ? "bg-primary/5 border-primary/50 shadow-md"
                  : "hover:bg-muted/50 border-border"
              )}
            >
              <div 
                className="p-3 flex flex-col gap-2"
                onClick={() => _onSelectRun(originalIndex)}
              >
                <div className="flex items-start justify-between">
                  <div className="space-y-1">
                    <div className="font-medium flex items-center flex-wrap gap-1">
                      {onToggleRunSelected ? (
                        <input
                          type="checkbox"
                          className="h-4 w-4 mr-1"
                          checked={isSelected}
                          onChange={() => onToggleRunSelected(originalIndex)}
                          onClick={(e) => e.stopPropagation()}
                          aria-label="Select run"
                        />
                      ) : null}
                      <span className="text-primary">{run.start_article}</span>
                      <svg
                        xmlns="http://www.w3.org/2000/svg"
                        width="14"
                        height="14"
                        viewBox="0 0 24 24"
                        fill="none"
                        stroke="currentColor"
                        strokeWidth="2"
                        strokeLinecap="round"
                        strokeLinejoin="round"
                        className="text-muted-foreground"
                      >
                        <path d="M5 12h14" />
                        <path d="m12 5 7 7-7 7" />
                      </svg>
                      <span className="text-primary">{run.destination_article}</span>
                    </div>
                    <div className="flex items-center gap-2">
                      <Tooltip>
                        <TooltipTrigger asChild>
                          <Badge variant="outline" className="text-xs px-2 py-0 h-5">
                            {formatHops(hops)}
                          </Badge>
                        </TooltipTrigger>
                        <TooltipContent side="top" align="start">
                          A hop is one link-click between articles.
                        </TooltipContent>
                      </Tooltip>
                      {run.result && !isWin && (
                        <Badge
                          variant="outline"
                          className={cn(
                            "text-[11px] h-5 px-2 py-0",
                            run.result === "abandoned"
                              ? "border-slate-200 bg-slate-50 text-slate-700"
                              : "border-red-200 bg-red-50 text-red-800"
                          )}
                        >
                          {run.result}
                        </Badge>
                      )}
                      {isNearMiss && (
                        <Badge
                          variant="outline"
                          className="text-[11px] h-5 px-2 py-0 border-amber-200 bg-amber-50 text-amber-800"
                        >
                          Near miss
                        </Badge>
                      )}
                      {selectedRunId === originalIndex && (
                        <div className="flex items-center gap-1 text-xs text-primary">
                          <div
                            className="h-2 w-2 rounded-full bg-primary animate-pulse"
                            aria-hidden="true"
                          />
                          <span>Active</span>
                        </div>
                      )}
                    </div>
                  </div>
                </div>
              </div>
              
              {onTryRun && selectedRunId === originalIndex && (
                <div className="border-t px-3 py-2 bg-muted/30 flex justify-end">
                  <Button 
                    size="sm" 
                    variant="outline"
                    className="h-7 text-xs"
                    onClick={(e) => {
                      e.stopPropagation();
                      onTryRun(run.start_article, run.destination_article);
                    }}
                  >
                    Try this path
                  </Button>
                </div>
              )}
            </Card>
          );
        })}

        {runs.length === 0 && (
          <div className="flex items-center justify-center h-32 text-muted-foreground">
            No runs available.
          </div>
        )}
      </div>
    </div>
  );
}
