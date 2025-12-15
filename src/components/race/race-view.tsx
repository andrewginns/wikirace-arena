"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Separator } from "@/components/ui/separator";
import { cn } from "@/lib/utils";
import { API_BASE } from "@/lib/constants";
import type { RaceConfig } from "./race-types";
import {
  abandonRun,
  appendRunStep,
  createSession,
  finishRun,
  startHumanRun,
  startLlmRun,
  useSessionsStore,
} from "@/lib/session-store";
import { runDisplayName } from "@/lib/session-utils";
import { runLlmRace } from "@/lib/llm-runner";
import { buildViewerDatasetFromSession } from "@/lib/session-to-viewer";
import { addViewerDataset } from "@/lib/viewer-datasets";
import ForceDirectedGraph from "@/components/force-directed-graph";
import { Bot, Download, Flag, Hourglass, User, Users } from "lucide-react";

function formatTime(seconds: number) {
  const mins = Math.floor(seconds / 60);
  const secs = seconds % 60;
  return `${mins}:${secs < 10 ? "0" : ""}${secs}`;
}

function downloadJson(filename: string, data: unknown) {
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

export default function RaceView({
  config,
  onBackToSetup,
  onGoToViewerTab,
}: {
  config: RaceConfig;
  onBackToSetup: () => void;
  onGoToViewerTab?: () => void;
}) {
  const initRef = useRef(false);
  const controllersRef = useRef<Map<string, AbortController>>(new Map());
  const startedLlmRef = useRef<Set<string>>(new Set());
  const lastIframeNavigateRef = useRef<{ title: string; at: number } | null>(null);

  const [sessionId, setSessionId] = useState<string | null>(null);
  const [selectedRunId, setSelectedRunId] = useState<string | null>(null);
  const [nowTick, setNowTick] = useState<number>(() => Date.now());

  const { sessions } = useSessionsStore();
  const session = sessionId ? sessions[sessionId] : null;

  useEffect(() => {
    const timer = window.setInterval(() => setNowTick(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, []);

  // Initialize session + runs (guarded for React StrictMode).
  useEffect(() => {
    if (initRef.current) return;
    initRef.current = true;

    const created = createSession({
      startArticle: config.startPage,
      destinationArticle: config.targetPage,
      title: config.title,
    });
    setSessionId(created.id);

    const createdRuns: string[] = [];
    for (const p of config.participants) {
      if (p.kind === "human") {
        const run = startHumanRun({
          sessionId: created.id,
          playerName: p.name || "Human",
        });
        createdRuns.push(run.id);
      } else {
        const run = startLlmRun({
          sessionId: created.id,
          model: p.model || "llm",
          apiBase: p.apiBase,
          reasoningEffort: p.reasoningEffort,
        });
        createdRuns.push(run.id);
      }
    }

    const first = createdRuns[0] || null;
    setSelectedRunId(first);
  }, [config]);

  // Start any pending LLM runners.
  useEffect(() => {
    if (!sessionId) return;
    if (!session) return;

    for (const run of session.runs) {
      if (run.kind !== "llm") continue;
      if (run.status !== "running") continue;
      if (startedLlmRef.current.has(run.id)) continue;
      if (!run.model) continue;

      startedLlmRef.current.add(run.id);
      const controller = new AbortController();
      controllersRef.current.set(run.id, controller);

      (async () => {
        try {
          const { result } = await runLlmRace({
            startArticle: session.start_article,
            destinationArticle: session.destination_article,
            model: run.model,
            apiBase: run.api_base,
            reasoningEffort: run.reasoning_effort,
            maxSteps: config.rules.maxHops,
            maxLinks: config.rules.maxLinks,
            maxTokens: config.rules.maxTokens,
            signal: controller.signal,
            onStep: (step) => {
              appendRunStep({ sessionId, runId: run.id, step });
            },
          });
          finishRun({ sessionId, runId: run.id, result });
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          appendRunStep({
            sessionId,
            runId: run.id,
            step: {
              type: "lose",
              article: run.steps[run.steps.length - 1]?.article || session.start_article,
              metadata: { reason: "error", error: message },
            },
          });
          finishRun({ sessionId, runId: run.id, result: "lose" });
        } finally {
          controllersRef.current.delete(run.id);
        }
      })();
    }
  }, [sessionId, session, config.rules.maxHops, config.rules.maxLinks, config.rules.maxTokens]);

  useEffect(() => {
    return () => {
      for (const c of controllersRef.current.values()) c.abort();
      controllersRef.current.clear();
    };
  }, []);

  const runsById = useMemo(() => {
    const map = new Map<string, NonNullable<typeof session>["runs"][number]>();
    if (!session) return map;
    for (const r of session.runs) map.set(r.id, r);
    return map;
  }, [session]);

  const selectedRun = selectedRunId ? runsById.get(selectedRunId) : null;

  const selectedCurrentArticle = useMemo(() => {
    if (!selectedRun) return config.startPage;
    const last = selectedRun.steps[selectedRun.steps.length - 1];
    return last?.article || config.startPage;
  }, [selectedRun, config.startPage]);

  const isSelectedHuman = selectedRun?.kind === "human";
  const isSelectedRunning = selectedRun?.status === "running";

  const [links, setLinks] = useState<string[]>([]);
  const [linksLoading, setLinksLoading] = useState(false);
  const [linksError, setLinksError] = useState<string | null>(null);

  const fetchLinks = useCallback(async (articleTitle: string) => {
    setLinksLoading(true);
    setLinksError(null);
    try {
      const response = await fetch(
        `${API_BASE}/get_article_with_links/${encodeURIComponent(articleTitle)}`
      );
      if (!response.ok) {
        const text = await response.text();
        throw new Error(`Failed to load links (${response.status}): ${text}`);
      }
      const data = await response.json();
      if (!data || !Array.isArray(data.links)) {
        throw new Error("Unexpected API response from get_article_with_links");
      }
      setLinks((data.links as string[]).slice(0, config.rules.maxLinks));
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      setLinks([]);
      setLinksError(msg);
    } finally {
      setLinksLoading(false);
    }
  }, [config.rules.maxLinks]);

  useEffect(() => {
    if (!isSelectedHuman) return;
    if (!isSelectedRunning) return;
    fetchLinks(selectedCurrentArticle);
  }, [isSelectedHuman, isSelectedRunning, selectedCurrentArticle, fetchLinks]);

  const recordHumanMove = useCallback((nextArticle: string) => {
    if (!sessionId || !session) return;
    if (!selectedRun || selectedRun.kind !== "human") return;
    if (selectedRun.status !== "running") return;

    const currentHops = Math.max(0, selectedRun.steps.length - 1);
    const nextHops = currentHops + 1;
    const currentArticle =
      selectedRun.steps[selectedRun.steps.length - 1]?.article || session.start_article;

    // Prevent double-counting when the iframe navigates to a section anchor.
    if (nextArticle === currentArticle) return;

    if (nextArticle === session.destination_article) {
      appendRunStep({
        sessionId,
        runId: selectedRun.id,
        step: { type: "win", article: nextArticle },
      });
      finishRun({ sessionId, runId: selectedRun.id, result: "win" });
      return;
    }

    if (nextHops >= config.rules.maxHops) {
      appendRunStep({
        sessionId,
        runId: selectedRun.id,
        step: {
          type: "lose",
          article: nextArticle,
          metadata: { reason: "max_hops", max_hops: config.rules.maxHops },
        },
      });
      finishRun({ sessionId, runId: selectedRun.id, result: "lose" });
      return;
    }

    appendRunStep({
      sessionId,
      runId: selectedRun.id,
      step: { type: "move", article: nextArticle },
    });
  }, [sessionId, session, selectedRun, config.rules.maxHops]);

  // Allow navigation by clicking links inside the Wikipedia iframe (human only).
  useEffect(() => {
    if (!isSelectedHuman) return;
    if (!isSelectedRunning) return;

    const allowedOrigins = new Set<string>([window.location.origin]);
    try {
      if (API_BASE.startsWith("http")) allowedOrigins.add(new URL(API_BASE).origin);
    } catch {
      // ignore
    }

    const handleMessage = (event: MessageEvent) => {
      if (!allowedOrigins.has(event.origin)) return;
      const data = event.data;
      if (!data || typeof data !== "object") return;
      if ((data as any).type !== "wikirace:navigate") return;
      const title = (data as any).title;
      if (typeof title !== "string" || title.length === 0) return;

      const now = Date.now();
      const last = lastIframeNavigateRef.current;
      if (last && last.title === title && now - last.at < 1000) return;
      lastIframeNavigateRef.current = { title, at: now };

      recordHumanMove(title);
    };

    window.addEventListener("message", handleMessage);
    return () => window.removeEventListener("message", handleMessage);
  }, [isSelectedHuman, isSelectedRunning, recordHumanMove]);

  const allFinished = useMemo(() => {
    if (!session) return false;
    return session.runs.length > 0 && session.runs.every((r) => r.status !== "running");
  }, [session]);

  const sortedRuns = useMemo(() => {
    if (!session) return [];
    const copy = [...session.runs];
    copy.sort((a, b) => {
      const aDone = a.status !== "running";
      const bDone = b.status !== "running";
      if (aDone !== bDone) return aDone ? 1 : -1;
      const aHops = typeof a.hops === "number" ? a.hops : Math.max(0, a.steps.length - 1);
      const bHops = typeof b.hops === "number" ? b.hops : Math.max(0, b.steps.length - 1);
      const aWin = a.result === "win";
      const bWin = b.result === "win";
      if (aWin !== bWin) return aWin ? -1 : 1;
      return aHops - bHops;
    });
    return copy;
  }, [session]);

  const forceGraphRuns = useMemo(() => {
    if (!session) return [];
    return session.runs.map((run) => ({
      start_article: session.start_article,
      destination_article: session.destination_article,
      steps: run.steps.map((s) => ({
        type: s.type === "start" ? "start" : "move",
        article: s.article,
      })),
    }));
  }, [session]);

  const exportSessionJson = () => {
    if (!session) return;
    downloadJson(
      `${(session.title || `${session.start_article}-${session.destination_article}`)
        .replaceAll(" ", "_")
        .slice(0, 80)}.session.json`,
      {
        schema_version: 1,
        exported_at: new Date().toISOString(),
        session,
      }
    );
  };

  const exportViewerJson = () => {
    if (!session) return;
    const dataset = buildViewerDatasetFromSession({
      session,
      runs: session.runs,
      name: session.title || `${session.start_article} → ${session.destination_article}`,
    });
    downloadJson("viewer-dataset.json", dataset);
  };

  const saveToViewer = () => {
    if (!session) return;
    const dataset = buildViewerDatasetFromSession({
      session,
      runs: session.runs,
      name: session.title || `${session.start_article} → ${session.destination_article}`,
    });
    addViewerDataset({ name: dataset.name, data: dataset });
    onGoToViewerTab?.();
  };

  const abandonSelected = () => {
    if (!sessionId || !selectedRun) return;
    abandonRun({ sessionId, runId: selectedRun.id });
    const c = controllersRef.current.get(selectedRun.id);
    if (c) c.abort();
  };

  const headerTitle = session
    ? session.title || `${session.start_article} → ${session.destination_article}`
    : `${config.startPage} → ${config.targetPage}`;

  return (
    <div className="space-y-4">
      <Card className="p-3">
        <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <div className="space-y-1">
            <div className="text-sm text-muted-foreground">Race</div>
            <div className="text-lg font-semibold">{headerTitle}</div>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <Button variant="outline" size="sm" onClick={onBackToSetup}>
              New race
            </Button>
            <Button variant="outline" size="sm" className="gap-2" onClick={exportSessionJson} disabled={!session}>
              <Download className="h-4 w-4" />
              Export session
            </Button>
            <Button variant="outline" size="sm" className="gap-2" onClick={exportViewerJson} disabled={!session}>
              <Download className="h-4 w-4" />
              Export viewer JSON
            </Button>
            <Button variant="default" size="sm" onClick={saveToViewer} disabled={!session || session.runs.length === 0}>
              Save to viewer
            </Button>
          </div>
        </div>
      </Card>

      <div className="grid grid-cols-1 lg:grid-cols-12 gap-4">
        <Card className="p-3 lg:col-span-3">
          <div className="flex items-center justify-between">
            <div className="text-sm font-medium flex items-center gap-2">
              <Users className="h-4 w-4 text-muted-foreground" />
              Scoreboard
            </div>
            {allFinished && (
              <Badge variant="outline" className="text-xs">
                Finished
              </Badge>
            )}
          </div>
          <Separator className="my-3" />

          <div className="space-y-2">
            {sortedRuns.map((r) => {
              const isActive = r.id === selectedRunId;
              const hops = typeof r.hops === "number" ? r.hops : Math.max(0, r.steps.length - 1);
              const last = r.steps[r.steps.length - 1]?.article || config.startPage;
              const elapsed = Math.max(0, Math.floor((nowTick - new Date(r.started_at).getTime()) / 1000));

              return (
                <button
                  key={r.id}
                  type="button"
                  onClick={() => setSelectedRunId(r.id)}
                  className={cn(
                    "w-full text-left rounded-lg border p-2 transition-colors",
                    isActive ? "border-primary/50 bg-primary/5" : "hover:bg-muted/50 border-border"
                  )}
                >
                  <div className="flex items-start justify-between gap-2">
                    <div className="min-w-0">
                      <div className="flex items-center gap-2">
                        {r.kind === "human" ? (
                          <User className="h-4 w-4 text-muted-foreground" />
                        ) : (
                          <Bot className="h-4 w-4 text-muted-foreground" />
                        )}
                        <div className="text-sm font-medium truncate">{runDisplayName(r)}</div>
                      </div>
                      <div className="mt-1 text-xs text-muted-foreground truncate">
                        {last}
                      </div>
                    </div>

                    <div className="flex flex-col items-end gap-1 flex-shrink-0">
                      <Badge
                        variant="outline"
                        className={cn(
                          "text-[11px]",
                          r.status === "running" && "border-blue-200 bg-blue-50 text-blue-800",
                          r.result === "win" && "border-green-200 bg-green-50 text-green-800",
                          r.result === "lose" && "border-red-200 bg-red-50 text-red-800",
                          r.result === "abandoned" && "border-zinc-200 bg-zinc-50 text-zinc-700"
                        )}
                      >
                        {r.status === "running" ? "Running" : r.result || "Done"}
                      </Badge>
                      <div className="text-[11px] text-muted-foreground">
                        {hops}/{config.rules.maxHops} • {formatTime(elapsed)}
                      </div>
                    </div>
                  </div>
                </button>
              );
            })}
          </div>

          {selectedRun && selectedRun.status === "running" && (
            <>
              <Separator className="my-3" />
              <Button
                variant="destructive"
                size="sm"
                className="w-full"
                onClick={abandonSelected}
              >
                Give up
              </Button>
            </>
          )}
        </Card>

        <div className="lg:col-span-9 space-y-4">
          <Card className="p-3">
            <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
              <div className="space-y-1">
                <div className="text-sm font-medium">
                  {selectedRun ? runDisplayName(selectedRun) : "Select a racer"}
                </div>
                <div className="text-xs text-muted-foreground flex items-center gap-2 flex-wrap">
                  <span className="inline-flex items-center gap-1">
                    <Flag className="h-3.5 w-3.5" />
                    Target: <span className="font-medium">{config.targetPage}</span>
                  </span>
                  <span className="inline-flex items-center gap-1">
                    <Hourglass className="h-3.5 w-3.5" />
                    Limit: <span className="font-medium">{config.rules.maxHops} hops</span>
                  </span>
                </div>
              </div>

              {selectedRun?.kind === "human" && selectedRun.status === "running" && (
                <div className="text-xs text-muted-foreground">
                  Click links in the list or inside the Wikipedia view.
                </div>
              )}
            </div>
          </Card>

          <div className="grid grid-cols-1 xl:grid-cols-12 gap-4">
            {selectedRun?.kind === "human" && (
              <Card className="p-3 xl:col-span-5">
                <div className="flex items-center justify-between">
                  <div className="text-sm font-medium">Available links</div>
                  <div className="text-xs text-muted-foreground">
                    {links.length} shown
                  </div>
                </div>
                <Separator className="my-3" />

                {selectedRun.status !== "running" ? (
                  <div className="text-sm text-muted-foreground">
                    Run finished.
                  </div>
                ) : linksLoading ? (
                  <div className="text-sm text-muted-foreground">Loading links…</div>
                ) : linksError ? (
                  <div className="text-sm text-red-700 bg-red-50 border border-red-200 rounded-md p-3">
                    <div className="font-medium">Couldn’t load links</div>
                    <div className="mt-1 break-words">{linksError}</div>
                  </div>
                ) : links.length === 0 ? (
                  <div className="text-sm text-muted-foreground">
                    No links found for <span className="font-medium">{selectedCurrentArticle}</span>.
                  </div>
                ) : (
                  <div className="flex flex-wrap content-start overflow-y-auto max-h-[520px]">
                    {[...links]
                      .sort((a, b) => a.localeCompare(b))
                      .map((link) => (
                        <Button
                          key={link}
                          variant="outline"
                          size="sm"
                          className="justify-start overflow-hidden text-ellipsis whitespace-nowrap w-[calc(50%_-_0.5rem)] m-[0.25rem]"
                          onClick={() => recordHumanMove(link)}
                        >
                          {link}
                        </Button>
                      ))}
                  </div>
                )}
              </Card>
            )}

            <Card
              className={cn(
                "p-3 overflow-hidden",
                selectedRun?.kind === "human" ? "xl:col-span-7" : "xl:col-span-12"
              )}
            >
              <div className="flex items-center justify-between">
                <div className="text-sm font-medium">Wikipedia view</div>
                <div className="text-xs text-muted-foreground truncate max-w-[70%]">
                  {selectedCurrentArticle}
                </div>
              </div>
              <Separator className="my-3" />
              <div className="relative w-full h-[520px] overflow-hidden rounded-md border">
                <iframe
                  style={{
                    transform: "scale(0.6, 0.6)",
                    width: "calc(100% * 1.6667)",
                    height: "calc(100% * 1.6667)",
                    transformOrigin: "top left",
                    position: "absolute",
                    top: 0,
                    left: 0,
                  }}
                  src={`${API_BASE}/wiki/${encodeURIComponent(
                    selectedCurrentArticle.replaceAll(" ", "_")
                  )}`}
                  className="border-0"
                />
              </div>
            </Card>
          </div>

          {session && (
            <Card className="p-3">
              <div className="flex items-center justify-between">
                <div className="text-sm font-medium">Race map</div>
                <div className="text-xs text-muted-foreground">
                  Visualizes every participant’s path so far.
                </div>
              </div>
              <Separator className="my-3" />
              <div className="h-[420px]">
                <ForceDirectedGraph runs={forceGraphRuns} runId={null} />
              </div>
            </Card>
          )}
        </div>
      </div>
    </div>
  );
}


