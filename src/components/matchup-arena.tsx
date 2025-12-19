"use client";

import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import { API_BASE } from "@/lib/constants";
import { cn } from "@/lib/utils";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Separator } from "@/components/ui/separator";
import ResizeHandle from "@/components/ui/resize-handle";
import Markdown from "@/components/ui/markdown";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import {
  Bot,
  ChevronDown,
  Download,
  Flag,
  Hourglass,
  PanelLeftClose,
  PanelLeftOpen,
  Trash2,
  User,
} from "lucide-react";
import ForceDirectedGraph from "@/components/force-directed-graph";
import ConfettiCanvas from "@/components/confetti-canvas";
import WikiArticlePreview from "@/components/wiki-article-preview";
import AddChallengersDialog from "@/components/race/add-challengers-dialog";
import {
  abandonRun,
  appendRunStep,
  deleteRuns,
  finishRun,
  forceWinRun,
  pauseHumanTimerForRun,
  pauseHumanTimers,
  resumeHumanTimerForRun,
  useSessionsStore,
} from "@/lib/session-store";
import type { RunV1, StepV1 } from "@/lib/session-types";
import { runDisplayName, sessionDisplayName } from "@/lib/session-utils";
import { buildViewerDatasetFromSession } from "@/lib/session-to-viewer";
import { addViewerDataset } from "@/lib/viewer-datasets";
import { addWinRunSummary, listWinRunSummaries } from "@/lib/win-summaries";
import { wikiTitlesMatch } from "@/lib/wiki-title";


const DEFAULT_MAX_STEPS = 20;
const DEFAULT_MAX_LINKS = 200;

const LAYOUT_STORAGE_KEY = "wikirace:arena-layout:v1";
const HUMAN_PANE_MODE_STORAGE_KEY = "wikirace:arena-human-pane:v1";

type HumanPaneMode = "wiki" | "split" | "links";

type ArenaViewMode = "article" | "results";

type ArenaCssVars = CSSProperties & {
  ["--links-pane-width"]?: string;
};

type WikiZoom = 60 | 75 | 90 | 100;

type ArenaLayout = {
  leaderboardWidth: number;
  leaderboardCollapsed: boolean;
  linksPaneWidth: number;
  runDetailsHeight: number;
  wikiHeight: number;
  mapHeight: number;
  wikiZoom?: WikiZoom;
};

const DEFAULT_LAYOUT: ArenaLayout = {
  leaderboardWidth: 360,
  leaderboardCollapsed: false,
  linksPaneWidth: 360,
  runDetailsHeight: 340,
  wikiHeight: 520,
  mapHeight: 672,
  wikiZoom: 60,
};

const LEGACY_DEFAULT_MAP_HEIGHT = 420;
const PREVIOUS_DEFAULT_MAP_HEIGHT = 840;

function loadHumanPaneMode(): HumanPaneMode {
  if (typeof window === "undefined") return "wiki";
  const raw = window.localStorage.getItem(HUMAN_PANE_MODE_STORAGE_KEY);
  if (raw === "wiki" || raw === "split" || raw === "links") return raw;
  return "wiki";
}

function clampNumber(value: number, min: number, max: number) {
  return Math.max(min, Math.min(max, value));
}

function normalizeWikiZoom(value: unknown): WikiZoom {
  if (value === 60 || value === 75 || value === 90 || value === 100) return value;
  return 60;
}

function loadLayout(): ArenaLayout {
  if (typeof window === "undefined") return DEFAULT_LAYOUT;
  try {
    const raw = window.localStorage.getItem(LAYOUT_STORAGE_KEY);
    if (!raw) return DEFAULT_LAYOUT;
    const parsed = JSON.parse(raw) as Partial<ArenaLayout>;
    const leaderboardWidthRaw =
      typeof parsed.leaderboardWidth === "number"
        ? parsed.leaderboardWidth
        : DEFAULT_LAYOUT.leaderboardWidth;
    const leaderboardCollapsedRaw =
      typeof parsed.leaderboardCollapsed === "boolean"
        ? parsed.leaderboardCollapsed
        : DEFAULT_LAYOUT.leaderboardCollapsed;
    const linksPaneWidthRaw =
      typeof parsed.linksPaneWidth === "number"
        ? parsed.linksPaneWidth
        : DEFAULT_LAYOUT.linksPaneWidth;
    const runDetailsHeightRaw =
      typeof parsed.runDetailsHeight === "number"
        ? parsed.runDetailsHeight
        : DEFAULT_LAYOUT.runDetailsHeight;
    const wikiHeightRaw =
      typeof parsed.wikiHeight === "number" ? parsed.wikiHeight : DEFAULT_LAYOUT.wikiHeight;
    const mapHeightRaw = typeof parsed.mapHeight === "number" ? parsed.mapHeight : DEFAULT_LAYOUT.mapHeight;
    const wikiZoom = normalizeWikiZoom(parsed.wikiZoom);
    const shouldShrinkFromPreviousDefault =
      mapHeightRaw === PREVIOUS_DEFAULT_MAP_HEIGHT &&
      leaderboardWidthRaw === 360 &&
      leaderboardCollapsedRaw === false &&
      linksPaneWidthRaw === 360 &&
      runDetailsHeightRaw === 340 &&
      wikiHeightRaw === 520 &&
      wikiZoom === 60;
    const shouldMigrateMapHeight =
      mapHeightRaw === LEGACY_DEFAULT_MAP_HEIGHT && mapHeightRaw < DEFAULT_LAYOUT.mapHeight;
    const mapHeight = shouldShrinkFromPreviousDefault
      ? DEFAULT_LAYOUT.mapHeight
      : shouldMigrateMapHeight
        ? DEFAULT_LAYOUT.mapHeight
        : mapHeightRaw;

    return {
      leaderboardWidth: clampNumber(leaderboardWidthRaw, 240, 800),
      leaderboardCollapsed: leaderboardCollapsedRaw,
      linksPaneWidth: clampNumber(linksPaneWidthRaw, 240, 900),
      runDetailsHeight: clampNumber(runDetailsHeightRaw, 160, 1200),
      wikiHeight: clampNumber(wikiHeightRaw, 240, 1600),
      mapHeight: clampNumber(mapHeight, 240, 2400),
      wikiZoom,
    };
  } catch {
    return DEFAULT_LAYOUT;
  }
}

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

function runHops(run: RunV1) {
  return typeof run.hops === "number" ? run.hops : Math.max(0, run.steps.length - 1);
}

function runMaxSteps(run: RunV1) {
  return typeof run.max_steps === "number" ? run.max_steps : DEFAULT_MAX_STEPS;
}

function runMaxLinks(run: RunV1) {
  return typeof run.max_links === "number" ? run.max_links : DEFAULT_MAX_LINKS;
}

function runDurationMs(run: RunV1) {
  if (typeof run.duration_ms === "number") return run.duration_ms;
  if (run.finished_at) {
    return Math.max(
      0,
      new Date(run.finished_at).getTime() - new Date(run.started_at).getTime()
    );
  }
  return Number.POSITIVE_INFINITY;
}

function runElapsedMs(run: RunV1, nowMs: number) {
  if (run.kind === "human" && run.timer_state) {
    const activeMs = typeof run.active_ms === "number" ? run.active_ms : 0;
    if (run.timer_state === "running" && run.last_resumed_at) {
      return Math.max(
        0,
        activeMs + (nowMs - new Date(run.last_resumed_at).getTime())
      );
    }
    return Math.max(0, activeMs);
  }

  if (typeof run.duration_ms === "number" && run.status !== "running") {
    return Math.max(0, run.duration_ms);
  }

  const startMs = new Date(run.started_at).getTime();
  const endMs =
    run.status === "running"
      ? nowMs
      : run.finished_at
      ? new Date(run.finished_at).getTime()
      : nowMs;
  return Math.max(0, endMs - startMs);
}

function summarizeStepMeta(step: StepV1) {
  if (!step.metadata) return null;
  const selectedIndex = (step.metadata as Record<string, unknown>).selected_index;
  const tries = (step.metadata as Record<string, unknown>).tries;
  const output = (step.metadata as Record<string, unknown>).llm_output;

  const parts: string[] = [];
  if (typeof selectedIndex === "number") parts.push(`pick #${selectedIndex}`);
  if (typeof tries === "number" && tries > 0) parts.push(`retries ${tries}`);
  if (typeof output === "string" && output.trim().length > 0) parts.push("has output");
  return parts.length > 0 ? parts.join(" • ") : null;
}

function stepOutput(step: StepV1) {
  if (!step.metadata) return null;
  const output = (step.metadata as Record<string, unknown>).llm_output;
  return typeof output === "string" ? output : null;
}

function stepMetrics(step: StepV1) {
  if (!step.metadata) return {};
  const meta = step.metadata as Record<string, unknown>;
  const latencyMs =
    typeof meta.latency_ms === "number"
      ? meta.latency_ms
      : typeof meta.duration_ms === "number"
        ? meta.duration_ms
        : undefined;
  const promptTokens =
    typeof meta.prompt_tokens === "number"
      ? meta.prompt_tokens
      : typeof meta.input_tokens === "number"
        ? meta.input_tokens
        : undefined;
  const completionTokens =
    typeof meta.completion_tokens === "number"
      ? meta.completion_tokens
      : typeof meta.output_tokens === "number"
        ? meta.output_tokens
        : undefined;
  const totalTokens = typeof meta.total_tokens === "number" ? meta.total_tokens : undefined;
  return { latencyMs, promptTokens, completionTokens, totalTokens };
}

function formatLlmOutputForDisplay(raw: string) {
  const matches = Array.from(raw.matchAll(/<answer>\s*([\s\S]*?)\s*<\/answer>/gi));
  if (matches.length === 0) return { answerXml: null as string | null, markdown: raw.trim() };

  const answer = matches[matches.length - 1]?.[1]?.trim() ?? "";
  let markdown = raw;
  for (const match of matches) {
    markdown = markdown.replace(match[0], "");
  }
  markdown = markdown.trim();

  const answerXml = `<answer>${answer}</answer>`;
  return { answerXml, markdown };
}

export default function MatchupArena({
  onGoToViewerTab,
  onNewRace,
  modelList = [],
  isServerConnected = true,
}: {
  onGoToViewerTab?: () => void;
  onNewRace?: () => void;
  modelList?: string[];
  isServerConnected?: boolean;
}) {
  const { sessions, active_session_id } = useSessionsStore();
  const session = active_session_id ? sessions[active_session_id] : null;
  const sessionId = session?.id || null;

  const [layout, setLayout] = useState<ArenaLayout>(() => loadLayout());
  const [selectedRunId, setSelectedRunId] = useState<string | null>(null);
  const [selectedRunIds, setSelectedRunIds] = useState<Set<string>>(() => new Set());
  const [compareEnabled, setCompareEnabled] = useState(false);
  const [compareHop, setCompareHop] = useState(0);
  const [nowTick, setNowTick] = useState<number>(() => Date.now());
  const [exportMenuOpen, setExportMenuOpen] = useState(false);
  const [humanPaneMode, setHumanPaneMode] = useState<HumanPaneMode>(() => loadHumanPaneMode());
  const [arenaViewMode, setArenaViewMode] = useState<ArenaViewMode>("article");
  const [linkQuery, setLinkQuery] = useState<string>("");
  const [linkDisplayLimit, setLinkDisplayLimit] = useState<number>(DEFAULT_MAX_LINKS);
  const [wikiLoading, setWikiLoading] = useState(false);
  const [winCelebrationRunId, setWinCelebrationRunId] = useState<string | null>(null);
  const [replayEnabled, setReplayEnabled] = useState(false);
  const [replayHop, setReplayHop] = useState(0);
  const [replayPlaying, setReplayPlaying] = useState(false);
  const lastIframeNavigateRef = useRef<{ title: string; at: number } | null>(null);
  const wikiIframeRef = useRef<HTMLIFrameElement | null>(null);
  const prevSessionIdRef = useRef<string | null>(null);
  const prevRunStateRef = useRef<Map<string, string>>(new Map());
  const [recentlyChangedRuns, setRecentlyChangedRuns] = useState<Set<string>>(new Set());
  const [linkActiveIndex, setLinkActiveIndex] = useState<number>(0);

  useEffect(() => {
    if (typeof window === "undefined") return;
    window.localStorage.setItem(LAYOUT_STORAGE_KEY, JSON.stringify(layout));
  }, [layout]);

  useEffect(() => {
    if (typeof window === "undefined") return;
    window.localStorage.setItem(HUMAN_PANE_MODE_STORAGE_KEY, humanPaneMode);
  }, [humanPaneMode]);

  useEffect(() => {
    const timer = window.setInterval(() => setNowTick(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, []);

  useEffect(() => {
    if (!session) {
      prevSessionIdRef.current = null;
      prevRunStateRef.current = new Map();
      return;
    }

    if (prevSessionIdRef.current !== session.id) {
      prevSessionIdRef.current = session.id;
      prevRunStateRef.current = new Map(
        session.runs.map((r) => [r.id, `${r.status}:${r.result || ""}`])
      );
      return;
    }

    const prev = prevRunStateRef.current;
    const next = new Map<string, string>();

    for (const run of session.runs) {
      const key = `${run.status}:${run.result || ""}`;
      next.set(run.id, key);

      const prevKey = prev.get(run.id);

      if (prevKey !== key) {
        setRecentlyChangedRuns((prevRuns) => {
          const nextRuns = new Set(prevRuns);
          nextRuns.add(run.id);
          window.setTimeout(() => {
            setRecentlyChangedRuns((inner) => {
              const copy = new Set(inner);
              copy.delete(run.id);
              return copy;
            });
          }, 1200);
          return nextRuns;
        });
      }

      if (prevKey === key) continue;

      if (run.status !== "finished" || run.result !== "win") continue;

      addWinRunSummary({ session, run });
      if (run.kind === "human") {
        setWinCelebrationRunId(run.id);
      }
    }

    prevRunStateRef.current = next;
  }, [session]);

  const runsById = useMemo(() => {
    const map = new Map<string, RunV1>();
    if (!session) return map;
    for (const r of session.runs) map.set(r.id, r);
    return map;
  }, [session]);

  const selectedRun = selectedRunId ? runsById.get(selectedRunId) : null;

  const selectedRunKindForView = selectedRun?.kind;
  const selectedRunStatusForView = selectedRun?.status;

  useEffect(() => {
    if (!selectedRunKindForView || !selectedRunStatusForView) return;
    const defaultMode =
      selectedRunKindForView === "human" && selectedRunStatusForView === "running"
        ? "article"
        : "results";
    setArenaViewMode(defaultMode);
  }, [selectedRunId, selectedRunKindForView, selectedRunStatusForView]);

  const selectedReplayMaxHop = useMemo(() => {
    if (!selectedRun) return 0;
    return Math.max(0, selectedRun.steps.length - 1);
  }, [selectedRun]);

  useEffect(() => {
    if (!replayEnabled && replayPlaying) {
      setReplayPlaying(false);
    }
  }, [replayEnabled, replayPlaying]);

  useEffect(() => {
    setReplayEnabled(false);
    setReplayPlaying(false);
  }, [selectedRunId]);

  useEffect(() => {
    setReplayHop((prev) => clampNumber(prev, 0, selectedReplayMaxHop));
  }, [selectedReplayMaxHop]);

  useEffect(() => {
    if (!replayEnabled || !replayPlaying) return;
    const timer = window.setInterval(() => {
      setReplayHop((prev) => clampNumber(prev + 1, 0, selectedReplayMaxHop));
    }, 650);
    return () => window.clearInterval(timer);
  }, [replayEnabled, replayPlaying, selectedReplayMaxHop]);

  useEffect(() => {
    if (!replayEnabled || !replayPlaying) return;
    if (replayHop >= selectedReplayMaxHop) setReplayPlaying(false);
  }, [replayEnabled, replayPlaying, replayHop, selectedReplayMaxHop]);


  useEffect(() => {
    if (!session) {
      setSelectedRunId(null);
      setSelectedRunIds(new Set());
      setCompareEnabled(false);
      return;
    }

    if (selectedRunId && session.runs.some((r) => r.id === selectedRunId)) return;
    const firstRunning = session.runs.find((r) => r.status === "running")?.id;
    setSelectedRunId(firstRunning || session.runs[0]?.id || null);
  }, [session, selectedRunId]);

  useEffect(() => {
    if (!session) return;

    const validIds = new Set(session.runs.map((r) => r.id));
    setSelectedRunIds((prev) => {
      let changed = false;
      const next = new Set<string>();
      for (const id of prev) {
        if (validIds.has(id)) {
          next.add(id);
        } else {
          changed = true;
        }
      }
      return changed ? next : prev;
    });
  }, [session]);

  const selectedCurrentArticle = useMemo(() => {
    if (!session) return "";
    if (!selectedRun) return session.start_article;
    return selectedRun.steps[selectedRun.steps.length - 1]?.article || session.start_article;
  }, [session, selectedRun]);

  const selectedReplayStepIndex = useMemo(() => {
    if (!session) return 0;
    if (!selectedRun) return 0;
    const maxIdx = Math.max(0, selectedRun.steps.length - 1);
    if (!replayEnabled) return maxIdx;
    return clampNumber(replayHop, 0, maxIdx);
  }, [session, selectedRun, replayEnabled, replayHop]);

  const displayedArticle = useMemo(() => {
    if (!session) return "";
    if (!selectedRun) return session.start_article;
    if (!replayEnabled) return selectedCurrentArticle;
    return (
      selectedRun.steps[selectedReplayStepIndex]?.article ||
      selectedRun.steps[selectedRun.steps.length - 1]?.article ||
      session.start_article
    );
  }, [session, selectedRun, replayEnabled, selectedCurrentArticle, selectedReplayStepIndex]);

  const isSelectedHuman = selectedRun?.kind === "human";
  const isSelectedRunning = selectedRun?.status === "running";
  const selectedRunKind = selectedRun?.kind ?? null;
  const selectedRunStatus = selectedRun?.status ?? null;
  const selectedRunIdValue = selectedRun?.id ?? null;
  const selectedHumanTimerState =
    selectedRun?.kind === "human" ? selectedRun.timer_state ?? null : null;
  const selectedHumanTimerRunning =
    selectedRun?.kind === "human" && selectedRun?.timer_state === "running";
  const selectedRunElapsedSeconds = selectedRun
    ? Math.max(0, Math.floor(runElapsedMs(selectedRun, nowTick) / 1000))
    : 0;

  const selectedRunTokenTotals = useMemo(() => {
    if (!selectedRun || selectedRun.kind !== "llm") return null;

    let promptTokens = 0;
    let completionTokens = 0;
    let totalTokens = 0;
    let sawPromptTokens = false;
    let sawCompletionTokens = false;
    let sawTotalTokens = false;

    for (const step of selectedRun.steps) {
      const metrics = stepMetrics(step);
      if (typeof metrics.promptTokens === "number") {
        promptTokens += metrics.promptTokens;
        sawPromptTokens = true;
      }
      if (typeof metrics.completionTokens === "number") {
        completionTokens += metrics.completionTokens;
        sawCompletionTokens = true;
      }
      if (typeof metrics.totalTokens === "number") {
        totalTokens += metrics.totalTokens;
        sawTotalTokens = true;
      } else if (
        typeof metrics.promptTokens === "number" ||
        typeof metrics.completionTokens === "number"
      ) {
        totalTokens += (metrics.promptTokens ?? 0) + (metrics.completionTokens ?? 0);
        sawTotalTokens = true;
      }
    }

    if (!sawPromptTokens && !sawCompletionTokens && !sawTotalTokens) return null;

    return {
      promptTokens: sawPromptTokens ? promptTokens : null,
      completionTokens: sawCompletionTokens ? completionTokens : null,
      totalTokens: sawTotalTokens ? totalTokens : null,
    };
  }, [selectedRun]);

  const autoStartHumanTimer = session?.human_timer?.auto_start_on_first_action !== false;

  // Hotseat: only the active (selected) human's timer should run.
  useEffect(() => {
    if (!sessionId) return;
    if (!selectedRunIdValue || !selectedRunKind || !selectedRunStatus) {
      pauseHumanTimers({ sessionId, exceptRunId: null });
      return;
    }

    if (selectedRunKind === "human" && selectedRunStatus === "running") {
      pauseHumanTimers({ sessionId, exceptRunId: selectedRunIdValue });
      return;
    }

    pauseHumanTimers({ sessionId, exceptRunId: null });
  }, [sessionId, selectedRunIdValue, selectedRunKind, selectedRunStatus]);

  useEffect(() => {
    if (!sessionId) return;
    if (!autoStartHumanTimer) return;
    if (!selectedRunIdValue) return;
    if (selectedRunKind !== "human" || selectedRunStatus !== "running") return;
    if (selectedHumanTimerState !== "not_started") return;
    if (replayEnabled) return;

    pauseHumanTimers({ sessionId, exceptRunId: selectedRunIdValue });
    resumeHumanTimerForRun({ sessionId, runId: selectedRunIdValue });
  }, [
    autoStartHumanTimer,
    replayEnabled,
    selectedHumanTimerState,
    selectedRunIdValue,
    selectedRunKind,
    selectedRunStatus,
    sessionId,
  ]);

  // When a human run is finished/abandoned, hide the (now irrelevant) links panel by default.
  useEffect(() => {
    if (!selectedRunKind || !selectedRunStatus) return;
    if (selectedRunKind !== "human") return;
    if (selectedRunStatus === "running") return;
    if (humanPaneMode !== "wiki") setHumanPaneMode("wiki");
  }, [selectedRunId, selectedRunKind, selectedRunStatus, humanPaneMode]);

  useEffect(() => {
    setLinkQuery("");
    setLinkActiveIndex(0);
  }, [selectedRunId, displayedArticle]);

  const leaderboardSections = useMemo(() => {
    if (!session) {
      return { running: [] as RunV1[], ranked: [] as RunV1[], unranked: [] as RunV1[] };
    }

    const running = session.runs
      .filter((r) => r.status === "running")
      .sort((a, b) => new Date(a.started_at).getTime() - new Date(b.started_at).getTime());

    const ranked = session.runs
      .filter((r) => r.status !== "running" && r.result === "win")
      .sort((a, b) => {
        const hopsDiff = runHops(a) - runHops(b);
        if (hopsDiff !== 0) return hopsDiff;
        const durationDiff = runDurationMs(a) - runDurationMs(b);
        if (durationDiff !== 0) return durationDiff;
        return new Date(a.started_at).getTime() - new Date(b.started_at).getTime();
      });

    const unranked = session.runs
      .filter((r) => r.status !== "running" && r.result !== "win")
      .sort((a, b) => new Date(b.started_at).getTime() - new Date(a.started_at).getTime());

    return { running, ranked, unranked };
  }, [session]);

  const forceGraphRuns = useMemo(() => {
    if (!session) return [];
    return session.runs.map((run) => {
      const steps = run.steps
        .filter((s) => s.type === "start" || s.type === "move" || s.type === "win" || s.type === "lose")
        .reduce((acc: { type: string; article: string }[], step) => {
          const last = acc[acc.length - 1];
          if (!last || last.article !== step.article) {
            acc.push({ type: step.type, article: step.article });
          }
          return acc;
        }, [] as { type: string; article: string }[]);

      return {
        start_article: session.start_article,
        destination_article: session.destination_article,
        steps,
      };
    });
  }, [session]);

  const selectedForceGraphRunId = useMemo(() => {
    if (!session) return null;
    if (!selectedRunId) return null;
    const idx = session.runs.findIndex((r) => r.id === selectedRunId);
    return idx >= 0 ? idx : null;
  }, [session, selectedRunId]);

  const selectedRunIndices = useMemo(() => {
    if (!session) return [] as number[];
    const indices: number[] = [];
    for (let i = 0; i < session.runs.length; i++) {
      if (selectedRunIds.has(session.runs[i]!.id)) indices.push(i);
    }
    return indices;
  }, [session, selectedRunIds]);

  const compareRunIndices = useMemo(() => {
    if (!compareEnabled) return [] as number[];
    if (selectedRunIndices.length < 2) return [] as number[];
    return selectedRunIndices;
  }, [compareEnabled, selectedRunIndices]);

  useEffect(() => {
    if (!compareEnabled) return;
    if (selectedRunIndices.length < 2) {
      setCompareEnabled(false);
      return;
    }
  }, [compareEnabled, selectedRunIndices.length]);

  const compareMaxHop = useMemo(() => {
    if (compareRunIndices.length < 2) return 0;
    let maxHop = 0;
    for (const runIndex of compareRunIndices) {
      const steps = forceGraphRuns[runIndex]?.steps ?? [];
      maxHop = Math.max(maxHop, Math.max(0, steps.length - 1));
    }
    return maxHop;
  }, [compareRunIndices, forceGraphRuns]);

  const compareHopClamped = useMemo(() => {
    return clampNumber(compareHop, 0, compareMaxHop);
  }, [compareHop, compareMaxHop]);

  useEffect(() => {
    if (!compareEnabled) return;
    setCompareHop((prev) => clampNumber(prev, 0, compareMaxHop));
  }, [compareEnabled, compareMaxHop]);

  const compareColorByRunId = useMemo(() => {
    const map: Record<number, string> = {};
    for (let i = 0; i < compareRunIndices.length; i++) {
      const runIndex = compareRunIndices[i]!;
      map[runIndex] = [
        "#e63946", // red
        "#457b9d", // blue
        "#2a9d8f", // teal
        "#fca311", // orange
        "#a855f7", // purple
        "#22c55e", // green
      ][i % 6]!;
    }
    return map;
  }, [compareRunIndices]);

  const [links, setLinks] = useState<string[]>([]);
  const [linksLoading, setLinksLoading] = useState(false);
  const [linksError, setLinksError] = useState<string | null>(null);

  const filteredLinks = useMemo(() => {
    const q = linkQuery.trim().toLowerCase();
    const sorted = [...links].sort((a, b) => a.localeCompare(b));
    if (q.length === 0) return sorted;
    return sorted.filter((link) => link.toLowerCase().includes(q));
  }, [links, linkQuery]);

  const visibleLinks = useMemo(() => {
    return filteredLinks.slice(0, linkDisplayLimit);
  }, [filteredLinks, linkDisplayLimit]);

  useEffect(() => {
    setLinkActiveIndex((prev) =>
      clampNumber(prev, 0, Math.max(0, visibleLinks.length - 1))
    );
  }, [visibleLinks.length]);


  const fetchLinks = useCallback(
    async (articleTitle: string, maxLinks: number) => {
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
        setLinks((data.links as string[]).slice(0, maxLinks));
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        setLinks([]);
        setLinksError(msg);
      } finally {
        setLinksLoading(false);
      }
    },
    []
  );

  useEffect(() => {
    if (!isSelectedHuman) return;
    if (!isSelectedRunning) return;
    if (!selectedRun) return;
    fetchLinks(displayedArticle, runMaxLinks(selectedRun));
  }, [isSelectedHuman, isSelectedRunning, displayedArticle, selectedRun, fetchLinks]);

  const recordHumanMove = useCallback(
    (nextArticle: string) => {
      if (replayEnabled) return;
      if (!sessionId || !session) return;
      if (!selectedRun || selectedRun.kind !== "human") return;
      if (selectedRun.status !== "running") return;

      const currentHops = Math.max(0, selectedRun.steps.length - 1);
      const nextHops = currentHops + 1;
      const currentArticle =
        selectedRun.steps[selectedRun.steps.length - 1]?.article || session.start_article;

      // Prevent double-counting when the iframe navigates to a section anchor.
      if (wikiTitlesMatch(nextArticle, currentArticle)) return;

      const autoStartTimer = session.human_timer?.auto_start_on_first_action !== false;
      if (
        autoStartTimer &&
        selectedRun.timer_state &&
        selectedRun.timer_state !== "running"
      ) {
        pauseHumanTimers({ sessionId, exceptRunId: selectedRun.id });
        resumeHumanTimerForRun({ sessionId, runId: selectedRun.id });
      }

      if (wikiTitlesMatch(nextArticle, session.destination_article)) {
        appendRunStep({
          sessionId,
          runId: selectedRun.id,
          step: { type: "win", article: session.destination_article },
        });
        finishRun({ sessionId, runId: selectedRun.id, result: "win" });
        return;
      }

      const maxSteps = runMaxSteps(selectedRun);
      if (nextHops >= maxSteps) {
        appendRunStep({
          sessionId,
          runId: selectedRun.id,
          step: {
            type: "lose",
            article: nextArticle,
            metadata: { reason: "max_hops", max_hops: maxSteps },
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
    },
    [replayEnabled, sessionId, session, selectedRun]
  );

  useEffect(() => {
    if (!sessionId || !session) return;

    for (const run of session.runs) {
      if (run.kind !== "human") continue;
      if (run.status !== "running") continue;
      const last = run.steps[run.steps.length - 1]?.article;
      if (!last) continue;
      if (!wikiTitlesMatch(last, session.destination_article)) continue;

      forceWinRun({ sessionId, runId: run.id });
    }
  }, [sessionId, session]);

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
      const msg = data as { type?: unknown; title?: unknown };
      if (msg.type !== "wikirace:navigate") return;
      const title = msg.title;
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

  const wikiSrc = useMemo(() => {
    if (!displayedArticle) return "";
    return `${API_BASE}/wiki/${encodeURIComponent(
      displayedArticle.replaceAll(" ", "_")
    )}`;
  }, [displayedArticle]);

  const wikiZoomValue = normalizeWikiZoom(layout.wikiZoom);
  const wikiScale = wikiZoomValue / 100;
  const wikiZoomMultiplier = 1 / wikiScale;

  const postWikiReplayMode = useCallback((enabled: boolean) => {
    wikiIframeRef.current?.contentWindow?.postMessage(
      { type: "wikirace:setReplayMode", enabled },
      "*"
    );
  }, []);

  useEffect(() => {
    if (!session) return;
    if (!wikiSrc) return;
    setWikiLoading(true);
  }, [session, wikiSrc]);

  useEffect(() => {
    if (!wikiSrc) return;
    postWikiReplayMode(replayEnabled);
  }, [postWikiReplayMode, replayEnabled, wikiSrc]);

  const exportViewerJson = () => {
    if (!session) return;
    const dataset = buildViewerDatasetFromSession({
      session,
      runs: session.runs,
      name: sessionDisplayName(session),
    });
    downloadJson("viewer-dataset.json", dataset);
  };

  const exportWinsJson = () => {
    if (!session) return;
    const summaries = listWinRunSummaries().filter((s) => s.session_id === session.id);
    downloadJson(
      `${sessionDisplayName(session).replaceAll(" ", "_").slice(0, 80)}.wins.json`,
      { schema_version: 1, exported_at: new Date().toISOString(), summaries }
    );
  };

  const saveToViewer = () => {
    if (!session) return;
    const dataset = buildViewerDatasetFromSession({
      session,
      runs: session.runs,
      name: sessionDisplayName(session),
    });
    addViewerDataset({ name: dataset.name, data: dataset });
    onGoToViewerTab?.();
  };

  const startSelectedTurn = () => {
    if (!sessionId || !selectedRun) return;
    if (selectedRun.kind !== "human") return;
    if (selectedRun.status !== "running") return;
    if (!selectedRun.timer_state) return;
    pauseHumanTimers({ sessionId, exceptRunId: selectedRun.id });
    resumeHumanTimerForRun({ sessionId, runId: selectedRun.id });
  };

  const endSelectedTurn = () => {
    if (!sessionId || !selectedRun) return;
    if (selectedRun.kind !== "human") return;
    if (selectedRun.status !== "running") return;
    if (!selectedRun.timer_state) return;
    pauseHumanTimerForRun({ sessionId, runId: selectedRun.id });
  };

  const abandonSelected = () => {
    if (!sessionId || !selectedRun) return;
    abandonRun({ sessionId, runId: selectedRun.id });
  };

  const deleteSelected = () => {
    if (!sessionId || !selectedRun) return;
    deleteRuns({ sessionId, runIds: [selectedRun.id] });
  };

  const toggleSelectedRunId = (runId: string) => {
    setSelectedRunIds((prev) => {
      const next = new Set(prev);
      if (next.has(runId)) {
        next.delete(runId);
      } else {
        next.add(runId);
      }
      return next;
    });
  };

  const clearSelectedRuns = () => {
    setSelectedRunIds(new Set());
    setCompareEnabled(false);
  };

  const deleteSelectedRuns = () => {
    if (!sessionId) return;
    const runIds = Array.from(selectedRunIds);
    if (runIds.length === 0) return;
    deleteRuns({ sessionId, runIds });
    setSelectedRunIds(new Set());
    setCompareEnabled(false);
  };

  const resizeLeaderboardWidth = (deltaPx: number) => {
    setLayout((prev) => ({
      ...prev,
      leaderboardWidth: clampNumber(prev.leaderboardWidth + deltaPx, 240, 800),
    }));
  };

  const resizeLinksPaneWidth = (deltaPx: number) => {
    setLayout((prev) => ({
      ...prev,
      linksPaneWidth: clampNumber(prev.linksPaneWidth + deltaPx, 240, 900),
    }));
  };

  const resizeWikiVsRunDetails = (deltaPx: number) => {
    const MIN_RUN = 160;
    const MIN_WIKI = 240;

    setLayout((prev) => {
      const total = prev.wikiHeight + prev.runDetailsHeight;
      const nextWiki = clampNumber(prev.wikiHeight + deltaPx, MIN_WIKI, total - MIN_RUN);
      return {
        ...prev,
        wikiHeight: nextWiki,
        runDetailsHeight: Math.max(MIN_RUN, total - nextWiki),
      };
    });
  };

  const resizeRunDetailsVsMap = (deltaPx: number) => {
    const MIN_RUN = 160;
    const MIN_MAP = 240;

    setLayout((prev) => {
      const total = prev.runDetailsHeight + prev.mapHeight;
      const nextRun = clampNumber(prev.runDetailsHeight + deltaPx, MIN_RUN, total - MIN_MAP);
      return {
        ...prev,
        runDetailsHeight: nextRun,
        mapHeight: Math.max(MIN_MAP, total - nextRun),
      };
    });
  };

  const resizeMapHeight = (deltaPx: number) => {
    const MIN_MAP = 240;
    const MAX_MAP = 2400;
    setLayout((prev) => ({
      ...prev,
      mapHeight: clampNumber(prev.mapHeight + deltaPx, MIN_MAP, MAX_MAP),
    }));
  };

  if (!session) {
    return (
      <div id="matchup-arena">
        <Card className="p-6">
          <div className="text-lg font-semibold">Matchup arena</div>
          <p className="text-sm text-muted-foreground mt-1">
            Start a Solo run or add racers to begin building a persistent leaderboard.
          </p>
        </Card>
      </div>
    );
  }

  const headerTitle = sessionDisplayName(session);
  const headerSubtitle =
    session.title && session.title.trim().length > 0
      ? `${session.start_article} → ${session.destination_article}`
      : null;
  const autoExpandRunDetails = Boolean(
    selectedRun && selectedRun.status !== "running" && arenaViewMode === "results"
  );
  const sessionAllRunsFinished =
    session.runs.length > 0 && session.runs.every((r) => r.status !== "running");
  const mapOnTopInResults =
    (sessionAllRunsFinished && arenaViewMode === "results") || autoExpandRunDetails;

  return (
    <>
      <ConfettiCanvas
        active={Boolean(winCelebrationRunId)}
        onDone={() => setWinCelebrationRunId(null)}
      />

	      <div id="matchup-arena" className="space-y-4">
	      <Card className="p-3">
	        <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
	          <div className="space-y-1">
	            <div className="text-sm text-muted-foreground">Arena</div>
	            {headerSubtitle ? (
	              <>
	                <div className="text-lg font-semibold">{headerTitle}</div>
	                <div className="flex items-center gap-2 min-w-0 text-sm text-muted-foreground">
	                  <div className="min-w-0 truncate">{headerSubtitle}</div>
	                  <WikiArticlePreview title={session.destination_article} size={28} />
	                </div>
	              </>
	            ) : (
	              <div className="flex items-center gap-2 min-w-0">
	                <div className="min-w-0 text-lg font-semibold truncate">{headerTitle}</div>
	                <WikiArticlePreview title={session.destination_article} size={32} />
	              </div>
	            )}
	          </div>
	          <div className="flex flex-wrap items-center gap-2">
		            {modelList.length > 0 && (
		              <AddChallengersDialog
		                modelList={modelList}
		                isServerConnected={isServerConnected}
		                onRunsStarted={(runs) => {
		                  const firstHuman = runs.find((r) => r.kind === "human");
		                  if (firstHuman) setSelectedRunId(firstHuman.id);
		                }}
		                trigger={
		                  <Button variant="outline" size="sm">
		                    Add challengers
		                  </Button>
	                }
	              />
	            )}
	            {onNewRace && (
	              <Button variant="secondary" size="sm" onClick={onNewRace}>
	                New race
	              </Button>
	            )}
	            <Popover open={exportMenuOpen} onOpenChange={setExportMenuOpen}>
	              <PopoverTrigger asChild>
	                <Button
	                  variant="outline"
	                  size="sm"
                  className="gap-2"
                  disabled={session.runs.length === 0}
                >
                  <Download className="h-4 w-4" />
                  Export
                  <ChevronDown className="h-4 w-4 opacity-60" />
                </Button>
              </PopoverTrigger>
              <PopoverContent className="p-1 w-56" align="end">
                <Button
                  type="button"
                  variant="ghost"
                  className="w-full justify-start"
                  onClick={() => {
                    exportSessionJson();
                    setExportMenuOpen(false);
                  }}
                >
                  Session JSON
                </Button>
                <Button
                  type="button"
                  variant="ghost"
                  className="w-full justify-start"
                  onClick={() => {
                    exportViewerJson();
                    setExportMenuOpen(false);
                  }}
                >
                  Viewer JSON
                </Button>
                <Button
                  type="button"
                  variant="ghost"
                  className="w-full justify-start"
                  onClick={() => {
                    exportWinsJson();
                    setExportMenuOpen(false);
                  }}
                >
                  Wins JSON
                </Button>
              </PopoverContent>
            </Popover>
            <Button
              variant="default"
              size="sm"
              onClick={saveToViewer}
              disabled={session.runs.length === 0}
            >
              Save to viewer
            </Button>
          </div>
        </div>
      </Card>

      <div className="flex items-stretch">
        {layout.leaderboardCollapsed ? null : (
          <>
            <div
              className="min-w-0 flex-shrink-0"
              style={{ width: layout.leaderboardWidth }}
            >
	          <Card className="p-3 h-full flex flex-col min-h-0">
	            <div className="flex flex-wrap items-center justify-between gap-2">
	              <div className="flex items-center gap-2 min-w-0">
	                <Button
	                  type="button"
	                  variant="ghost"
	                  size="icon"
	                  className="h-8 w-8"
	                  onClick={() =>
	                    setLayout((prev) => ({ ...prev, leaderboardCollapsed: true }))
	                  }
	                  aria-label="Collapse leaderboard"
	                >
	                  <PanelLeftClose className="h-4 w-4" />
	                </Button>
	                <div className="text-sm font-medium">Leaderboard</div>
	                {selectedRunIds.size > 0 && (
	                  <Badge variant="outline" className="text-[11px]">
	                    {selectedRunIds.size} selected
	                  </Badge>
	                )}
	              </div>
	
	              <div className="flex flex-wrap items-center justify-end gap-2">
	                {selectedRunIds.size >= 2 && (
	                  <Button
	                    variant={compareEnabled ? "secondary" : "outline"}
	                    size="sm"
                    className="h-8"
                    onClick={() => {
                      if (compareEnabled) {
                        setCompareEnabled(false);
                        return;
                      }

                      const activeRunIndex = selectedForceGraphRunId;
                      const shouldKeepActive =
                        typeof activeRunIndex === "number" &&
                        selectedRunIndices.includes(activeRunIndex);
                      const focusIndex = shouldKeepActive
                        ? activeRunIndex
                        : selectedRunIndices[0] ?? null;
                      const focusRunId =
                        typeof focusIndex === "number" ? session.runs[focusIndex]?.id : null;
                      if (focusRunId) setSelectedRunId(focusRunId);
                      setCompareHop(0);
                      setReplayEnabled(false);
                      setReplayPlaying(false);
                      setCompareEnabled(true);
                    }}
                  >
                    {compareEnabled ? "Exit compare" : "Compare"}
                  </Button>
                )}

                {selectedRunIds.size > 0 && (
                  <Dialog>
                    <DialogTrigger asChild>
                      <Button variant="outline" size="sm" className="h-8 gap-2">
                        <Trash2 className="h-4 w-4" />
                        Delete
                      </Button>
                    </DialogTrigger>
                    <DialogContent>
                      <DialogHeader>
                        <DialogTitle>Delete selected runs?</DialogTitle>
                        <DialogDescription>
                          This removes {selectedRunIds.size} run(s) from the matchup
                          leaderboard.
                        </DialogDescription>
                      </DialogHeader>
                      <DialogFooter>
                        <DialogClose asChild>
                          <Button
                            type="button"
                            variant="secondary"
                            onClick={clearSelectedRuns}
                          >
                            Clear selection
                          </Button>
                        </DialogClose>
                        <DialogClose asChild>
                          <Button
                            type="button"
                            variant="destructive"
                            onClick={deleteSelectedRuns}
                          >
                            Delete
                          </Button>
                        </DialogClose>
                      </DialogFooter>
                    </DialogContent>
                  </Dialog>
                )}
              </div>
            </div>

            <Separator className="my-3" />

            <div className="flex-1 min-h-0 overflow-y-auto space-y-2 pr-1">
              {leaderboardSections.running.length > 0 && (
                <div className="pt-1">
                  <div className="text-[11px] text-muted-foreground">
                    In progress ({leaderboardSections.running.length})
                  </div>
                </div>
              )}

              {leaderboardSections.running.map((r) => {
                  const isActive = r.id === selectedRunId;
                  const isSelected = selectedRunIds.has(r.id);
                  const hops = runHops(r);
                  const maxSteps = runMaxSteps(r);
                  const last = r.steps[r.steps.length - 1]?.article || session.start_article;
                  const elapsed = Math.max(0, Math.floor(runElapsedMs(r, nowTick) / 1000));
                  const isTimerRunning = r.kind === "human" && r.timer_state === "running";
                  const isRecentlyChanged = recentlyChangedRuns.has(r.id);
                  const statusLabel =
                    r.kind === "human" && r.timer_state
                      ? r.timer_state === "running"
                        ? "Running"
                        : r.timer_state === "paused"
                        ? "Paused"
                        : "Waiting"
                      : "Running";
                  const statusBadgeClass =
                    statusLabel === "Running"
                      ? "border-blue-200 bg-blue-50 text-blue-800"
                      : "border-zinc-200 bg-zinc-50 text-zinc-700";

                return (
                    <button
                      key={r.id}
                      type="button"
                      onClick={() => setSelectedRunId(r.id)}
                      className={cn(
                        "w-full text-left rounded-lg border p-2 transition-colors",
                        isActive
                          ? "border-primary/50 bg-primary/5"
                          : "hover:bg-muted/50 border-border",
                        isTimerRunning && "ring-2 ring-blue-200 ring-offset-1",
                        isRecentlyChanged && "animate-pulse"
                      )}
                    >
                    <div className="flex items-start justify-between gap-2">
                      <div className="min-w-0 flex items-start gap-2">
                          <input
                            type="checkbox"
                            className="mt-0.5 h-4 w-4"
                            checked={isSelected}
                            onChange={() => toggleSelectedRunId(r.id)}
                            onClick={(e) => e.stopPropagation()}
                            aria-label="Select run"
                          />

                        <div className="min-w-0">
                          <div className="flex items-center gap-2">
                            {r.kind === "human" ? (
                              <User className="h-4 w-4 text-muted-foreground" />
                            ) : (
                              <Bot className="h-4 w-4 text-muted-foreground" />
                            )}
                            <div className="text-sm font-medium truncate">
                              {runDisplayName(r)}
                            </div>
                          </div>
                          <div className="mt-1 text-xs text-muted-foreground truncate">
                            {last}
                          </div>
                        </div>
                      </div>

                      <div className="flex flex-col items-end gap-1 flex-shrink-0">
                        <Badge
                          variant="outline"
                          className={cn("text-[11px]", statusBadgeClass)}
                        >
                          {statusLabel}
                        </Badge>
                        <div className="text-[11px] text-muted-foreground">
                          {hops}/{maxSteps} • {formatTime(elapsed)}
                        </div>
                      </div>
                    </div>
                  </button>
                );
              })}

              {leaderboardSections.ranked.length > 0 && (
                <div className="pt-2">
                  <div className="text-[11px] text-muted-foreground">
                    Ranked wins ({leaderboardSections.ranked.length})
                  </div>
                </div>
              )}

              {leaderboardSections.ranked.map((r, idx) => {
                  const isActive = r.id === selectedRunId;
                  const isSelected = selectedRunIds.has(r.id);
                  const hops = runHops(r);
                  const maxSteps = runMaxSteps(r);
                  const last = r.steps[r.steps.length - 1]?.article || session.start_article;
                  const elapsed = Math.max(0, Math.floor(runElapsedMs(r, nowTick) / 1000));
                  const isTimerRunning = r.kind === "human" && r.timer_state === "running";
                  const isRecentlyChanged = recentlyChangedRuns.has(r.id);

                return (
                    <button
                      key={r.id}
                      type="button"
                      onClick={() => setSelectedRunId(r.id)}
                      className={cn(
                        "w-full text-left rounded-lg border p-2 transition-colors",
                        isActive
                          ? "border-primary/50 bg-primary/5"
                          : "hover:bg-muted/50 border-border",
                        isTimerRunning && "ring-2 ring-blue-200 ring-offset-1",
                        isRecentlyChanged && "animate-pulse"
                      )}
                    >
                    <div className="flex items-start justify-between gap-2">
                      <div className="min-w-0 flex items-start gap-2">
                          <input
                            type="checkbox"
                            className="mt-0.5 h-4 w-4"
                            checked={isSelected}
                            onChange={() => toggleSelectedRunId(r.id)}
                            onClick={(e) => e.stopPropagation()}
                            aria-label="Select run"
                          />

                        <div className="min-w-0">
                          <div className="flex items-center gap-2">
                            <div className="text-[11px] font-semibold text-muted-foreground w-7">
                              #{idx + 1}
                            </div>
                            {r.kind === "human" ? (
                              <User className="h-4 w-4 text-muted-foreground" />
                            ) : (
                              <Bot className="h-4 w-4 text-muted-foreground" />
                            )}
                            <div className="text-sm font-medium truncate">
                              {runDisplayName(r)}
                            </div>
                          </div>
                          <div className="mt-1 text-xs text-muted-foreground truncate">
                            {last}
                          </div>
                        </div>
                      </div>

                      <div className="flex flex-col items-end gap-1 flex-shrink-0">
                        <Badge
                          variant="outline"
                          className="text-[11px] border-green-200 bg-green-50 text-green-800"
                        >
                          Win
                        </Badge>
                        <div className="text-[11px] text-muted-foreground">
                          {hops}/{maxSteps} • {formatTime(elapsed)}
                        </div>
                      </div>
                    </div>
                  </button>
                );
              })}

              {leaderboardSections.unranked.length > 0 && (
                <div className="pt-2">
                  <div className="text-[11px] text-muted-foreground">
                    Not ranked ({leaderboardSections.unranked.length})
                  </div>
                </div>
              )}

              {leaderboardSections.unranked.map((r) => {
                  const isActive = r.id === selectedRunId;
                  const isSelected = selectedRunIds.has(r.id);
                  const hops = runHops(r);
                  const maxSteps = runMaxSteps(r);
                  const last = r.steps[r.steps.length - 1]?.article || session.start_article;
                  const elapsed = Math.max(0, Math.floor(runElapsedMs(r, nowTick) / 1000));
                  const badgeLabel = r.result === "abandoned" ? "Abandoned" : "Fail";
                  const isTimerRunning = r.kind === "human" && r.timer_state === "running";
                  const isRecentlyChanged = recentlyChangedRuns.has(r.id);

                return (
                    <button
                      key={r.id}
                      type="button"
                      onClick={() => setSelectedRunId(r.id)}
                      className={cn(
                        "w-full text-left rounded-lg border p-2 transition-colors",
                        "opacity-80 bg-muted/20",
                        isActive
                          ? "border-primary/50 bg-primary/5 opacity-100"
                          : "hover:bg-muted/40 border-border",
                        isTimerRunning && "ring-2 ring-blue-200 ring-offset-1",
                        isRecentlyChanged && "animate-pulse"
                      )}
                    >
                    <div className="flex items-start justify-between gap-2">
                      <div className="min-w-0 flex items-start gap-2">
                          <input
                            type="checkbox"
                            className="mt-0.5 h-4 w-4"
                            checked={isSelected}
                            onChange={() => toggleSelectedRunId(r.id)}
                            onClick={(e) => e.stopPropagation()}
                            aria-label="Select run"
                          />

                        <div className="min-w-0">
                          <div className="flex items-center gap-2">
                            {r.kind === "human" ? (
                              <User className="h-4 w-4 text-muted-foreground" />
                            ) : (
                              <Bot className="h-4 w-4 text-muted-foreground" />
                            )}
                            <div className="text-sm font-medium truncate">
                              {runDisplayName(r)}
                            </div>
                          </div>
                          <div className="mt-1 text-xs text-muted-foreground truncate">
                            {last} • Not ranked
                          </div>
                        </div>
                      </div>

                      <div className="flex flex-col items-end gap-1 flex-shrink-0">
                        <Badge
                          variant="outline"
                          className="text-[11px] border-zinc-200 bg-zinc-50 text-zinc-700"
                        >
                          {badgeLabel}
                        </Badge>
                        <div className="text-[11px] text-muted-foreground">
                          {hops}/{maxSteps} • {formatTime(elapsed)}
                        </div>
                      </div>
                    </div>
                  </button>
                );
              })}
	            </div>
	          </Card>
            </div>

            <ResizeHandle
              axis="x"
              onDelta={resizeLeaderboardWidth}
              onDoubleClick={() => setLayout(DEFAULT_LAYOUT)}
              className="w-2 flex-shrink-0"
            />
          </>
        )}

	        <div className="min-w-0 flex-1">
	          <div className="flex flex-col">
              <Card className="p-3 mb-3">
                <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
                  <div className="flex items-start gap-2 min-w-0">
                    {layout.leaderboardCollapsed ? (
                      <Button
                        type="button"
                        variant="outline"
                        size="icon"
                        className="h-8 w-8 flex-shrink-0"
                        onClick={() =>
                          setLayout((prev) => ({
                            ...prev,
                            leaderboardCollapsed: false,
                          }))
                        }
                        aria-label="Expand leaderboard"
                      >
                        <PanelLeftOpen className="h-4 w-4" />
                      </Button>
                    ) : null}

                    <div className="space-y-1 min-w-0">
                      <div className="text-sm font-medium">
                        {selectedRun ? runDisplayName(selectedRun) : "Select a run"}
                      </div>
	                        <div className="text-xs text-muted-foreground flex items-center gap-2 flex-wrap">
                        <div className="inline-flex items-center gap-2 min-w-0">
                          <Flag className="h-3.5 w-3.5 flex-shrink-0" />
                          <span>Target:</span>
                          <span className="font-medium truncate">
                            {session.destination_article}
                          </span>
                        </div>
                        {selectedRun && (
                          <span className="inline-flex items-center gap-1">
                            <Hourglass className="h-3.5 w-3.5" />
                            Limit:{" "}
                            <span className="font-medium">
                              {runMaxSteps(selectedRun)} hops
                            </span>
                          </span>
                        )}
                        {selectedHumanTimerRunning && (
                          <span className="inline-flex items-center gap-1 rounded-full bg-blue-50 text-blue-800 border border-blue-200 px-2 py-0.5">
                            Active player • {formatTime(selectedRunElapsedSeconds)}
                          </span>
                        )}
                      </div>
                    </div>
                  </div>

                  <div className="flex items-center gap-2">
                    {selectedRun && (
                      <Tabs
                        value={arenaViewMode}
                        onValueChange={(v) => setArenaViewMode(v as ArenaViewMode)}
                      >
                        <TabsList className="h-8">
                          <TabsTrigger value="results" className="text-xs px-2">
                            Results
                          </TabsTrigger>
                          <TabsTrigger value="article" className="text-xs px-2">
                            Article
                          </TabsTrigger>
                        </TabsList>
                      </Tabs>
                    )}

                    {selectedRun &&
                      selectedRun.kind === "human" &&
                      selectedRun.status === "running" &&
                      selectedRun.timer_state &&
                      (selectedRun.timer_state === "running" ? (
                        <Button variant="outline" size="sm" onClick={endSelectedTurn}>
                          End turn
                        </Button>
                      ) : (
                        <Button variant="default" size="sm" onClick={startSelectedTurn}>
                          Start turn
                        </Button>
                      ))}

                    {selectedRun && selectedRun.status === "running" && (
                      <Button variant="destructive" size="sm" onClick={abandonSelected}>
                        Give up
                      </Button>
                    )}

                    {selectedRun && (
                      <Dialog>
                        <DialogTrigger asChild>
                          <Button variant="outline" size="sm" className="gap-2">
                            <Trash2 className="h-4 w-4" />
                            Delete
                          </Button>
                        </DialogTrigger>
                        <DialogContent>
                          <DialogHeader>
                            <DialogTitle>Delete this run?</DialogTitle>
                            <DialogDescription>
                              This removes the run from the matchup leaderboard.
                            </DialogDescription>
                          </DialogHeader>
                          <DialogFooter>
                            <DialogClose asChild>
                              <Button type="button" variant="secondary">
                                Cancel
                              </Button>
                            </DialogClose>
                            <DialogClose asChild>
                              <Button
                                type="button"
                                variant="destructive"
                                onClick={deleteSelected}
                              >
                                Delete
                              </Button>
                            </DialogClose>
                          </DialogFooter>
                        </DialogContent>
                      </Dialog>
                    )}
                  </div>
                </div>
              </Card>

	            {arenaViewMode === "article" && (
	              <>
		                <div
		                  className="min-h-0 overflow-hidden"
		                  style={{ height: layout.wikiHeight }}
	                >
	                  <div className="h-full overflow-hidden">
	                    <div
	                      className={cn(
	                        "grid grid-cols-1 gap-4 h-full min-h-0",
	                        selectedRun?.kind === "human" && humanPaneMode === "split"
	                          ? "xl:grid-cols-[var(--links-pane-width)_auto_1fr] xl:gap-0"
	                          : "xl:grid-cols-12"
	                      )}
	                      style={
	                        selectedRun?.kind === "human" && humanPaneMode === "split"
	                          ? ({
	                              "--links-pane-width": `${layout.linksPaneWidth}px`,
	                            } as ArenaCssVars)
	                          : undefined
	                      }
	                    >
	                  {selectedRun?.kind === "human" && humanPaneMode !== "wiki" && (
	                    <Card
	                      className={cn(
	                        "p-3 h-full flex flex-col min-h-0",
	                        humanPaneMode === "links" ? "xl:col-span-12" : null
	                      )}
	                    >
                      <div className="flex items-center justify-between">
                        <div className="text-sm font-medium">Available links</div>
                        <div className="flex items-center gap-2">
                          {humanPaneMode === "links" && (
                            <Tabs
                              value={humanPaneMode}
                              onValueChange={(v) => setHumanPaneMode(v as HumanPaneMode)}
                            >
                              <TabsList className="h-8">
                                <TabsTrigger value="wiki" className="text-xs px-2">
                                  Wiki
                                </TabsTrigger>
                                <TabsTrigger value="split" className="text-xs px-2">
                                  Split
                                </TabsTrigger>
                                <TabsTrigger value="links" className="text-xs px-2">
                                  Links
                                </TabsTrigger>
                              </TabsList>
                            </Tabs>
                          )}
                          <Select
                            value={String(linkDisplayLimit)}
                            onValueChange={(v) => setLinkDisplayLimit(Number.parseInt(v, 10))}
                          >
                            <SelectTrigger className="h-8 w-[110px]">
                              <SelectValue />
                            </SelectTrigger>
                            <SelectContent>
                              <SelectItem value="50">Show 50</SelectItem>
                              <SelectItem value="100">Show 100</SelectItem>
                              <SelectItem value="200">Show 200</SelectItem>
                            </SelectContent>
                          </Select>
                        </div>
                      </div>
                      <Separator className="my-3" />

                      <div className="flex items-center gap-2 text-xs text-muted-foreground">
                        <span>
                          {visibleLinks.length} of {filteredLinks.length} shown
                        </span>
                        {linkQuery.trim().length > 0 && (
                          <span className="text-muted-foreground/70">Filtered</span>
                        )}
                      </div>
                      <div className="flex items-center gap-2">
                        <Input
                          value={linkQuery}
                          onChange={(e) => {
                            setLinkQuery(e.target.value);
                            setLinkActiveIndex(0);
                          }}
                          onKeyDown={(e) => {
                            if (replayEnabled) return;
                            if (selectedRun.status !== "running") return;
                            if (e.key === "ArrowDown") {
                              e.preventDefault();
                              setLinkActiveIndex((prev) =>
                                clampNumber(prev + 1, 0, Math.max(0, visibleLinks.length - 1))
                              );
                              return;
                            }
                            if (e.key === "ArrowUp") {
                              e.preventDefault();
                              setLinkActiveIndex((prev) =>
                                clampNumber(prev - 1, 0, Math.max(0, visibleLinks.length - 1))
                              );
                              return;
                            }
                            if (e.key !== "Enter") return;
                            const q = linkQuery.trim().toLowerCase();
                            const activeLink = visibleLinks[linkActiveIndex];
                            if (activeLink) {
                              recordHumanMove(activeLink);
                              setLinkQuery("");
                              return;
                            }
                            if (q.length === 0) return;

                            const exact = filteredLinks.find((link) => link.toLowerCase() === q);
                            if (exact) {
                              recordHumanMove(exact);
                              setLinkQuery("");
                              return;
                            }

                            if (filteredLinks.length === 1) {
                              recordHumanMove(filteredLinks[0]);
                              setLinkQuery("");
                            }
                          }}
                          placeholder="Search links…"
                          className="h-9"
                          disabled={replayEnabled || selectedRun.status !== "running" || linksLoading}
                        />
                        <Button
                          variant="outline"
                          size="sm"
                          className="h-9"
                          onClick={() => setLinkQuery("")}
                          disabled={linkQuery.trim().length === 0}
                        >
                          Clear
                        </Button>
                      </div>

                      {selectedRun.status !== "running" ? (
                        <div className="mt-3 text-sm text-muted-foreground">Run finished.</div>
                      ) : linksLoading ? (
                        <div className="mt-3 text-sm text-muted-foreground">Loading links…</div>
                      ) : linksError ? (
                        <div className="mt-3 text-sm text-red-700 bg-red-50 border border-red-200 rounded-md p-3">
                          <div className="font-medium">Couldn’t load links</div>
                          <div className="mt-1 break-words">{linksError}</div>
                        </div>
                      ) : links.length === 0 ? (
                        <div className="mt-3 text-sm text-muted-foreground">
                          No links found for{" "}
                          <span className="font-medium">{displayedArticle}</span>.
                        </div>
                      ) : filteredLinks.length === 0 ? (
                        <div className="mt-3 text-sm text-muted-foreground">
                          No matches for{" "}
                          <span className="font-medium">{linkQuery.trim()}</span>.
                        </div>
	                      ) : (
	                        <div className="mt-3 flex-1 min-h-0 overflow-y-auto">
	                          <div className="space-y-2">
	                            {visibleLinks.map((link, idx) => (
	                              <Button
	                                key={link}
	                                variant="outline"
	                                size="sm"
	                                className={cn(
	                                  "w-full justify-start text-left whitespace-normal break-words h-auto py-2 text-sm",
	                                  idx === linkActiveIndex && "ring-2 ring-primary ring-offset-1",
	                                  humanPaneMode === "links" && "py-1.5"
	                                )}
	                                onClick={() => recordHumanMove(link)}
	                                disabled={replayEnabled || selectedRun.status !== "running"}
	                              >
	                                {link}
	                              </Button>
	                            ))}
	                          </div>
	                        </div>
	                      )}
	                    </Card>
	                  )}

	                  {selectedRun?.kind === "human" && humanPaneMode === "split" && (
	                    <ResizeHandle
	                      axis="x"
	                      onDelta={resizeLinksPaneWidth}
	                      onDoubleClick={() =>
	                        setLayout((prev) => ({
	                          ...prev,
	                          linksPaneWidth: DEFAULT_LAYOUT.linksPaneWidth,
	                        }))
	                      }
	                      className="hidden xl:block w-2 mx-2"
	                    />
	                  )}
	
	                  {selectedRun?.kind !== "human" || humanPaneMode !== "links" ? (
	                    <Card
	                      className={cn(
	                        "p-3 overflow-hidden h-full flex flex-col min-h-0",
	                        selectedRun?.kind === "human" && humanPaneMode === "split"
	                          ? "order-first xl:order-none min-w-0"
	                          : "xl:col-span-12"
	                      )}
	                    >
                    <div className="space-y-1">
                      <div className="flex items-center justify-between">
                        <div className="text-sm font-medium">Wikipedia view</div>
                        <div className="flex items-center gap-2 min-w-0">
                          {selectedRun?.kind === "human" && (
                            <Tabs
                              value={humanPaneMode}
                              onValueChange={(v) => setHumanPaneMode(v as HumanPaneMode)}
                            >
                              <TabsList className="h-8">
                                <TabsTrigger value="wiki" className="text-xs px-2">
                                  Wiki
                                </TabsTrigger>
                                <TabsTrigger value="split" className="text-xs px-2">
                                  Split
                                </TabsTrigger>
                                <TabsTrigger value="links" className="text-xs px-2">
                                  Links
                                </TabsTrigger>
                              </TabsList>
                            </Tabs>
                          )}
                          <Select
                            value={String(wikiZoomValue)}
                            onValueChange={(v) =>
                              setLayout((prev) => ({
                                ...prev,
                                wikiZoom: normalizeWikiZoom(Number.parseInt(v, 10)),
                              }))
                            }
                          >
                            <SelectTrigger className="h-8 w-[110px] text-xs">
                              <SelectValue placeholder="Zoom" />
                            </SelectTrigger>
                            <SelectContent>
                              <SelectItem value="60">60%</SelectItem>
                              <SelectItem value="75">75%</SelectItem>
                              <SelectItem value="90">90%</SelectItem>
                              <SelectItem value="100">100%</SelectItem>
                            </SelectContent>
                          </Select>
                          {replayEnabled && (
                            <Button
                              variant="secondary"
                              size="sm"
                              className="h-8 text-xs"
                              onClick={() => {
                                setReplayEnabled(false);
                                setReplayPlaying(false);
                              }}
                            >
                              Back to live
                            </Button>
                          )}
                          {replayEnabled && (
                            <Badge variant="outline" className="text-[11px]">
                              Replay
                            </Badge>
                          )}
                          <div className="text-xs text-muted-foreground truncate max-w-[70%]">
                            {displayedArticle}
                          </div>
                        </div>
                      </div>
                      {selectedRun?.kind === "human" && (
                        <div className="text-xs text-muted-foreground">
                          {replayEnabled
                            ? "Replay mode: exit replay to make moves."
                            : "Tip: click links in the page to move (or use the searchable list)."}
                        </div>
                      )}
                    </div>
                    <Separator className="my-3" />
                    <div className="relative w-full flex-1 min-h-[320px] overflow-hidden rounded-md border bg-muted/10">
                      {wikiLoading && (
                        <div className="absolute inset-0 flex items-center justify-center text-sm text-muted-foreground">
                          Loading article…
                        </div>
                      )}
                      <iframe
                        key={wikiSrc}
                        ref={wikiIframeRef}
                        style={{
                          transform: `scale(${wikiScale}, ${wikiScale})`,
                          width: `calc(100% * ${wikiZoomMultiplier})`,
                          height: `calc(100% * ${wikiZoomMultiplier})`,
                          transformOrigin: "top left",
                          position: "absolute",
                          top: 0,
                          left: 0,
                        }}
                        src={wikiSrc}
                        className="border-0"
                        onLoad={() => {
                          setWikiLoading(false);
                          postWikiReplayMode(replayEnabled);
                        }}
                      />
                    </div>
                  </Card>
                  ) : null}
	                    </div>
	                  </div>
	                </div>

	                <ResizeHandle
	                  axis="y"
	                  onDelta={resizeWikiVsRunDetails}
	                  onDoubleClick={() => setLayout(DEFAULT_LAYOUT)}
	                  className="h-2"
	                />
	              </>
	            )}

			            <div
			              className={cn(
			                "min-h-0",
			                mapOnTopInResults ? "order-3" : null,
			                autoExpandRunDetails ? null : "overflow-hidden"
			              )}
			              style={autoExpandRunDetails ? undefined : { height: layout.runDetailsHeight }}
			            >
			              <div
			                className={cn(
			                  "space-y-3 pr-1",
			                  autoExpandRunDetails ? null : "h-full overflow-y-auto"
		                )}
			              >
	                {selectedRun && (
		                  <Card className="p-3">
		                    <div className="flex items-center justify-between">
		                      <div className="text-sm font-medium">Run details</div>
	                      <Badge variant="outline" className="text-[11px]">
	                        {selectedRun.kind}
	                      </Badge>
	                    </div>
	                    <Separator className="my-2" />

	                    <div className="grid grid-cols-1 md:grid-cols-2 gap-2 text-sm">
	                      <div>
	                        <div className="text-xs text-muted-foreground">Status</div>
	                        <div className="mt-0.5">
	                          {selectedRun.status === "running"
	                            ? selectedRun.kind === "human" && selectedRun.timer_state
	                              ? selectedRun.timer_state === "running"
	                                ? "Running"
                                : selectedRun.timer_state === "paused"
                                ? "Paused"
                                : "Waiting"
                              : "Running"
                            : selectedRun.result || "Done"}
	                        </div>
	                      </div>
	                      <div>
	                        <div className="text-xs text-muted-foreground">Hops</div>
	                        <div className="mt-0.5">
	                          {runHops(selectedRun)} / {runMaxSteps(selectedRun)}
	                        </div>
	                      </div>
	                      <div>
	                        <div className="text-xs text-muted-foreground">Time</div>
	                        <div className="mt-0.5">
	                          {formatTime(
	                            Math.max(0, Math.floor(runElapsedMs(selectedRun, nowTick) / 1000))
	                          )}
	                        </div>
                      </div>

		                      {selectedRun.kind === "llm" && (
		                        <>
		                          <div>
		                            <div className="text-xs text-muted-foreground">Model</div>
		                            <div className="mt-0.5">{selectedRun.model || "(unknown)"}</div>
		                          </div>
		                          <div>
		                            <div className="text-xs text-muted-foreground">Tokens used</div>
		                            <div className="mt-0.5 text-xs text-muted-foreground">
		                              {selectedRunTokenTotals
		                                ? `in: ${selectedRunTokenTotals.promptTokens ?? "—"} • out: ${selectedRunTokenTotals.completionTokens ?? "—"} • total: ${selectedRunTokenTotals.totalTokens ?? "—"}`
		                                : "—"}
		                            </div>
		                          </div>
		                          <div>
		                            <div className="text-xs text-muted-foreground">LiteLLM params</div>
		                            <div className="mt-0.5 text-xs text-muted-foreground">
		                              api_base: {selectedRun.api_base || "(default)"}
	                              {" • "}
	                              reasoning_effort: {selectedRun.reasoning_effort || "(default)"}
	                              {" • "}
	                              max_tokens:{" "}
	                              {typeof selectedRun.max_tokens === "number"
	                                ? selectedRun.max_tokens
	                                : session?.rules?.max_tokens === null
	                                ? "unlimited"
	                                : typeof session?.rules?.max_tokens === "number"
	                                ? session.rules.max_tokens
	                                : "(default)"}
	                              {" • "}
	                              max_links:{" "}
	                              {typeof selectedRun.max_links === "number"
	                                ? selectedRun.max_links
	                                : session?.rules?.max_links === null
	                                ? "unlimited"
	                                : typeof session?.rules?.max_links === "number"
	                                ? session.rules.max_links
	                                : "(default)"}
	                            </div>
	                          </div>
	                        </>
	                      )}
	                    </div>

	                    <Separator className="my-2" />
	                    <div className="space-y-2">
	                      <div className="flex items-center justify-between gap-2">
	                        <div className="text-xs text-muted-foreground">Path</div>
	                        <div className="flex items-center gap-2">
                          <Button
                            variant={replayEnabled ? "secondary" : "outline"}
                            size="sm"
                            className="h-7 text-xs"
                            onClick={() => {
                              if (replayEnabled) {
                                setReplayEnabled(false);
                                setReplayPlaying(false);
                                return;
                              }
                              setReplayEnabled(true);
                              setReplayPlaying(false);
                              setReplayHop(runHops(selectedRun));
                            }}
                          >
                            {replayEnabled ? "Back to live" : "Replay"}
                          </Button>

	                          {replayEnabled && (
	                            <Button
	                              variant="outline"
	                              size="sm"
	                              className="h-7 text-xs"
	                              onClick={() => {
	                                if (replayPlaying) {
	                                  setReplayPlaying(false);
	                                  return;
	                                }
	                                if (replayHop >= selectedReplayMaxHop) {
	                                  setReplayHop(0);
	                                }
	                                setReplayPlaying(true);
	                              }}
	                              disabled={selectedReplayMaxHop === 0}
	                            >
	                              {replayPlaying ? "Pause" : "Play"}
	                            </Button>
	                          )}
                        </div>
                      </div>

                      {replayEnabled && (
                        <>
                          <div className="flex items-center gap-2">
                            <Button
                              variant="outline"
                              size="sm"
                              className="h-7 px-2"
                              onClick={() => {
                                setReplayPlaying(false);
                                setReplayHop((prev) =>
                                  clampNumber(prev - 1, 0, selectedReplayMaxHop)
                                );
                              }}
                              disabled={replayHop <= 0}
                            >
                              Prev
                            </Button>

                            <input
                              type="range"
                              min={0}
                              max={selectedReplayMaxHop}
                              value={Math.max(0, Math.min(selectedReplayMaxHop, replayHop))}
                              onChange={(e) => {
                                setReplayPlaying(false);
                                setReplayHop(Number.parseInt(e.target.value, 10));
                              }}
                              className="flex-1 accent-primary"
                              aria-label="Replay hop"
                            />

                            <Button
                              variant="outline"
                              size="sm"
                              className="h-7 px-2"
                              onClick={() => {
                                setReplayPlaying(false);
                                setReplayHop((prev) =>
                                  clampNumber(prev + 1, 0, selectedReplayMaxHop)
                                );
                              }}
                              disabled={replayHop >= selectedReplayMaxHop}
                            >
                              Next
                            </Button>

                            <div className="text-xs text-muted-foreground tabular-nums w-[70px] text-right">
                              {Math.max(0, Math.min(selectedReplayMaxHop, replayHop))}/
                              {selectedReplayMaxHop}
                            </div>
                          </div>

                          <div className="text-xs text-muted-foreground">
                            Hop {Math.max(0, Math.min(selectedReplayMaxHop, replayHop))}:{" "}
                            <span className="font-medium">{displayedArticle}</span>
                          </div>
	                        </>
	                      )}

	                      <div className="mt-0.5 flex flex-wrap items-center gap-1">
	                        {selectedRun.steps.map((s, idx) => {
	                          const activeIdx = replayEnabled
	                            ? selectedReplayStepIndex
	                            : Math.max(0, selectedRun.steps.length - 1);
                          const isActive = idx === activeIdx;
                          const isFuture = replayEnabled && idx > selectedReplayStepIndex;

                          return (
                            <button
                              key={`${selectedRun.id}-step-${idx}`}
                              type="button"
                              onClick={() => {
                                setReplayEnabled(true);
                                setReplayPlaying(false);
                                setReplayHop(idx);
                              }}
                              aria-current={isActive ? "step" : undefined}
                              className={cn(
                                "text-xs rounded border px-2 py-0.5 transition-colors",
                                isFuture && "opacity-40",
                                isActive && "ring-2 ring-primary ring-offset-1",
                                s.type === "start" && "border-border bg-muted/40",
                                s.type === "win" &&
                                  "border-green-200 bg-green-50 text-green-900",
                                s.type === "lose" && "border-red-200 bg-red-50 text-red-900",
                                s.type === "move" && "border-border bg-background"
                              )}
                            >
                              {s.article}
                            </button>
                          );
                        })}
                      </div>
                    </div>

	                    {selectedRun.kind === "llm" && (
	                      <>
	                        <Separator className="my-2" />
	                        <div className="space-y-2">
	                          <div className="text-sm font-medium">Step-by-step breakdown</div>
	                          <div className="text-xs text-muted-foreground">
	                            New steps appear here as the model runs.
	                          </div>

	                          <div className="space-y-2">
	                            {selectedRun.steps
	                              .filter((s) => s.type !== "start")
	                              .map((s, idx) => {
		                                const meta = summarizeStepMeta(s);
		                                const output = stepOutput(s);
		                                const metrics = stepMetrics(s);
		                                const tokenLabel = (() => {
		                                  const total =
		                                    typeof metrics.totalTokens === "number"
		                                      ? metrics.totalTokens
		                                      : typeof metrics.promptTokens === "number" ||
		                                          typeof metrics.completionTokens === "number"
		                                        ? (metrics.promptTokens ?? 0) +
		                                          (metrics.completionTokens ?? 0)
		                                        : null;

		                                  if (total === null) return null;

		                                  if (
		                                    typeof metrics.promptTokens === "number" ||
		                                    typeof metrics.completionTokens === "number"
		                                  ) {
		                                    return `in/out/total: ${metrics.promptTokens ?? 0}/${metrics.completionTokens ?? 0}/${total} tok`;
		                                  }

		                                  return `total: ${total} tok`;
		                                })();
		                                const latencyLabel =
		                                  typeof metrics.latencyMs === "number"
		                                    ? `${Math.round(metrics.latencyMs)} ms`
		                                    : null;
	                                const formatted = output ? formatLlmOutputForDisplay(output) : null;

	                                return (
	                                  <details
	                                    key={`${selectedRun.id}-trace-${idx}`}
	                                    className="rounded-md border p-2"
	                                  >
	                                    <summary className="cursor-pointer text-sm">
	                                      <span className="font-medium">{s.type}</span>{" "}
	                                      <span className="text-muted-foreground">{s.article}</span>
	                                      <span className="inline-flex flex-wrap items-center gap-2 ml-2 align-middle">
	                                        {meta && (
	                                          <span className="text-xs text-muted-foreground">{meta}</span>
	                                        )}
	                                        {latencyLabel && (
	                                          <Badge variant="outline" className="text-[11px]">
	                                            {latencyLabel}
	                                          </Badge>
	                                        )}
	                                        {tokenLabel && (
	                                          <Badge variant="outline" className="text-[11px]">
	                                            {tokenLabel}
	                                          </Badge>
	                                        )}
	                                        {output && (
	                                          <span className="text-[11px] text-muted-foreground">
	                                            Show reasoning
	                                          </span>
	                                        )}
	                                      </span>
	                                    </summary>
		                                    {formatted && (
		                                      <div className="mt-2 space-y-2">
		                                        {formatted.answerXml && (
		                                          <div className="rounded-md border bg-muted/30 p-2">
		                                            <div className="text-[11px] text-muted-foreground">
		                                              Answer
		                                            </div>
		                                            <pre className="mt-1 whitespace-pre-wrap font-mono text-[11px]">
		                                              {formatted.answerXml}
		                                            </pre>
		                                          </div>
		                                        )}
		                                        {formatted.markdown.length > 0 ? (
		                                          <Markdown content={formatted.markdown} />
		                                        ) : formatted.answerXml ? (
		                                          <div className="text-xs text-muted-foreground">
		                                            No additional output (answer only).
		                                          </div>
		                                        ) : (
		                                          <div className="text-xs text-muted-foreground">
		                                            No LLM output captured for this step.
		                                          </div>
		                                        )}
		                                      </div>
		                                    )}
		                                    {!output && (
		                                      <div className="mt-2 text-xs text-muted-foreground">
		                                        No LLM output captured for this step.
		                                      </div>
		                                    )}
	                                  </details>
	                                );
	                              })}
                          </div>
                        </div>
                      </>
                    )}
                  </Card>
                )}
              </div>
            </div>

		            {mapOnTopInResults ? null : autoExpandRunDetails ? (
		              <div className="h-2" aria-hidden="true" />
		            ) : (
		              <ResizeHandle
		                axis="y"
		                onDelta={resizeRunDetailsVsMap}
		                onDoubleClick={() => setLayout(DEFAULT_LAYOUT)}
		                className="h-2"
		              />
		            )}

		            <div
		              className={cn(
		                "min-h-0 overflow-hidden",
		                mapOnTopInResults ? "order-1" : null
		              )}
		              style={{ height: layout.mapHeight }}
		            >
			              <Card className="p-3 h-full flex flex-col min-h-0">
			                <div className="flex items-center justify-between">
			                  <div className="flex items-center gap-2 min-w-0">
			                    <div className="text-sm font-medium">Matchup map</div>
	                      </div>
		                  <div className="text-xs text-muted-foreground">
	                    Visualizes every run’s path, plus nearby wiki links.
	                  </div>
                </div>

                {compareEnabled && compareRunIndices.length >= 2 && (
                  <div className="mt-2 space-y-2">
                    <div className="flex items-center justify-between gap-2">
                      <div className="text-xs text-muted-foreground">
                        Comparing {compareRunIndices.length} runs • Hop {compareHopClamped}/
                        {compareMaxHop}
                      </div>
                      <div className="text-xs text-muted-foreground">
                        Choices at this hop
                      </div>
                    </div>

                    <div className="flex items-center gap-2">
                      <Button
                        variant="outline"
                        size="sm"
                        className="h-7 px-2"
                        onClick={() => setCompareHop((prev) => clampNumber(prev - 1, 0, compareMaxHop))}
                        disabled={compareHopClamped <= 0}
                      >
                        Prev
                      </Button>

                      <input
                        type="range"
                        min={0}
                        max={compareMaxHop}
                        value={compareHopClamped}
                        onChange={(e) => setCompareHop(Number.parseInt(e.target.value, 10))}
                        className="flex-1 accent-primary"
                        aria-label="Compare hop"
                      />

                      <Button
                        variant="outline"
                        size="sm"
                        className="h-7 px-2"
                        onClick={() => setCompareHop((prev) => clampNumber(prev + 1, 0, compareMaxHop))}
                        disabled={compareHopClamped >= compareMaxHop}
                      >
                        Next
                      </Button>

                      <div className="text-xs text-muted-foreground tabular-nums w-[70px] text-right">
                        {compareHopClamped}/{compareMaxHop}
                      </div>
                    </div>

                    <div className="space-y-1">
                      {compareRunIndices.map((runIndex) => {
                        const run = session.runs[runIndex];
                        if (!run) return null;

                        const steps = forceGraphRuns[runIndex]?.steps ?? [];
                        const maxIdx = Math.max(0, steps.length - 1);
                        const idx = clampNumber(compareHopClamped, 0, maxIdx);
                        const fromArticle =
                          steps[idx]?.article ||
                          steps[steps.length - 1]?.article ||
                          session.start_article;
                        const toArticle = steps[idx + 1]?.article;
                        const isActive = run.id === selectedRunId;
                        const color = compareColorByRunId[runIndex];

                        return (
                          <button
                            key={`compare-hop-${run.id}`}
                            type="button"
                            onClick={() => setSelectedRunId(run.id)}
                            className={cn(
                              "w-full rounded-md border px-2 py-1 text-left",
                              isActive
                                ? "border-primary/50 bg-primary/5"
                                : "border-border hover:bg-muted/40"
                            )}
                          >
                            <div className="flex items-start justify-between gap-2">
                              <div className="min-w-0">
                                <div className="flex items-center gap-2">
                                  <span
                                    className="h-2 w-2 rounded-full flex-shrink-0"
                                    style={{ backgroundColor: color }}
                                    aria-hidden="true"
                                  />
                                  <div className="text-xs font-medium truncate">
                                    {runDisplayName(run)}
                                  </div>
                                </div>
                                <div className="mt-0.5 text-[11px] text-muted-foreground truncate">
                                  {toArticle
                                    ? `${fromArticle} → ${toArticle}`
                                    : `${fromArticle} (end)`}
                                </div>
                              </div>
                              <div className="text-[11px] text-muted-foreground tabular-nums flex-shrink-0">
                                {Math.min(compareHopClamped, maxIdx)}/{maxIdx}
                              </div>
                            </div>
                          </button>
                        );
                      })}
                    </div>
                  </div>
                )}

                <Separator className="my-3" />
                <div className="flex-1 min-h-0">
                  <ForceDirectedGraph
                    runs={forceGraphRuns}
                    runId={selectedForceGraphRunId}
                    compareRunIds={compareEnabled ? compareRunIndices : undefined}
                    compareColorByRunId={compareEnabled ? compareColorByRunId : undefined}
                    compareHighlightStep={compareEnabled ? compareHopClamped : undefined}
                    highlightStep={
                      compareEnabled
                        ? compareHopClamped
                        : replayEnabled
                        ? selectedReplayStepIndex
                        : undefined
                    }
                    includeGraphLinks
                  />
                </div>
              </Card>
            </div>

	            <ResizeHandle
	              axis="y"
	              onDelta={(deltaPx) => {
	                if (typeof window === "undefined") return;
                const maxScroll = document.documentElement.scrollHeight - window.innerHeight;
                const isPinnedToBottom = window.scrollY >= maxScroll - 48;

                resizeMapHeight(deltaPx);
                if (deltaPx <= 0) return;
                if (!isPinnedToBottom) return;

                const scrollToBottom = () => {
                  window.scrollTo({ top: document.documentElement.scrollHeight, left: 0, behavior: "auto" });
                };

                // Double-rAF so we scroll after layout has applied.
                window.requestAnimationFrame(() => {
                  scrollToBottom();
                  window.requestAnimationFrame(scrollToBottom);
                });
              }}
	              onDoubleClick={() =>
	                setLayout((prev) => ({ ...prev, mapHeight: DEFAULT_LAYOUT.mapHeight }))
	              }
	              className={cn("h-2", mapOnTopInResults ? "order-2" : null)}
	            />
          </div>
        </div>
      </div>
      </div>
    </>
  );
}
