import {
  Suspense,
  lazy,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type ReactNode,
} from "react";
import { API_BASE } from "@/lib/constants";
import { cn } from "@/lib/utils";
import { useMediaQuery } from "@/lib/use-media-query";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { StatusChip } from "@/components/ui/status-chip";
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
  Check,
  ChevronDown,
  Copy,
  Download,
  Footprints,
  Flag,
  Hourglass,
  PanelLeftClose,
  PanelLeftOpen,
  Trophy,
  Trash2,
  User,
  X,
} from "lucide-react";
import ConfettiCanvas from "@/components/confetti-canvas";
import WikiArticlePreview from "@/components/wiki-article-preview";
import AddAiForm from "@/components/race/add-ai-form";
import AddChallengersDialog from "@/components/race/add-challengers-dialog";
import type { RaceDriver } from "@/lib/race-driver";
import type { RaceMode, RaceRun, RaceState, RaceStep } from "@/lib/race-state";
import {
  computeHopsFromSteps,
  currentArticleFromSteps,
  sumTokenUsageFromSteps,
} from "@/lib/run-metrics";
import { addViewerDataset } from "@/lib/viewer-datasets";
import { normalizeWikiTitle, wikiTitlesMatch } from "@/lib/wiki-title";

const ForceDirectedGraph = lazy(() => import("@/components/force-directed-graph"));

const DEFAULT_MAX_STEPS = 20;

const RUN_COLOR_PALETTE = [
  "#2563eb", // chart-1 (brand.primary)
  "#db2777", // chart-2 (brand.secondary)
  "#16a34a", // chart-3 (brand.accent)
  "#0ea5e9", // chart-4 (brand.highlight)
  "#f59e0b", // chart-5
];

const LAYOUT_STORAGE_KEY = "wikirace:arena-layout:v1";
const MULTIPLAYER_LAYOUT_STORAGE_KEY = "wikirace:arena-layout:multiplayer:v1";
const MOBILE_LAYOUT_STORAGE_KEY = "wikirace:arena-layout:mobile:v1";
const MULTIPLAYER_MOBILE_LAYOUT_STORAGE_KEY = "wikirace:arena-layout:multiplayer:mobile:v1";
const HUMAN_PANE_MODE_STORAGE_KEY = "wikirace:arena-human-pane:v1";
const MOBILE_HUMAN_PANE_MODE_STORAGE_KEY = "wikirace:arena-human-pane:mobile:v1";
const HIDDEN_RUNS_STORAGE_KEY_PREFIX = "wikirace:arena-hidden-runs:v1";

type HumanPaneMode = "wiki" | "split" | "links";

type ArenaViewMode = "article" | "results";

type ArenaEventKind = "move" | "win" | "lose" | "info";

type ArenaEvent = {
  id: string;
  kind: ArenaEventKind;
  message: string;
  at: number;
};

type ArenaCssVars = CSSProperties & {
  ["--links-pane-width"]?: string;
};

type DirectLinkMiss = {
  hopIndex: number;
  fromArticle: string;
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

const COULD_HAVE_WON_LINK_CACHE_SIZE = 64;

const MULTIPLAYER_DEFAULT_LAYOUT: ArenaLayout = {
  ...DEFAULT_LAYOUT,
  leaderboardCollapsed: true,
};

const LEGACY_DEFAULT_MAP_HEIGHT = 420;
const PREVIOUS_DEFAULT_MAP_HEIGHT = 840;

function trimCacheMap<T>(cache: Map<string, T>, maxSize: number) {
  while (cache.size > maxSize) {
    const firstKey = cache.keys().next().value as string | undefined;
    if (!firstKey) return;
    cache.delete(firstKey);
  }
}

function loadHumanPaneMode(storageKey: string): HumanPaneMode {
  if (typeof window === "undefined") return "wiki";
  const raw = window.localStorage.getItem(storageKey);
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

function layoutStorageKey(mode: RaceMode | null, isMobile: boolean): string {
  if (isMobile) {
    return mode === "multiplayer"
      ? MULTIPLAYER_MOBILE_LAYOUT_STORAGE_KEY
      : MOBILE_LAYOUT_STORAGE_KEY;
  }
  return mode === "multiplayer" ? MULTIPLAYER_LAYOUT_STORAGE_KEY : LAYOUT_STORAGE_KEY;
}

function defaultLayoutForMode(mode: RaceMode | null): ArenaLayout {
  return mode === "multiplayer" ? MULTIPLAYER_DEFAULT_LAYOUT : DEFAULT_LAYOUT;
}

function loadLayout(mode: RaceMode | null, isMobile: boolean): ArenaLayout {
  const defaultLayout = defaultLayoutForMode(mode);
  if (typeof window === "undefined") return defaultLayout;
  try {
    const raw = window.localStorage.getItem(layoutStorageKey(mode, isMobile));
    if (!raw) return defaultLayout;
    const parsed = JSON.parse(raw) as Partial<ArenaLayout>;
    const leaderboardWidthRaw =
      typeof parsed.leaderboardWidth === "number"
        ? parsed.leaderboardWidth
        : defaultLayout.leaderboardWidth;
    const leaderboardCollapsedRaw =
      typeof parsed.leaderboardCollapsed === "boolean"
        ? parsed.leaderboardCollapsed
        : defaultLayout.leaderboardCollapsed;
    const linksPaneWidthRaw =
      typeof parsed.linksPaneWidth === "number"
        ? parsed.linksPaneWidth
        : defaultLayout.linksPaneWidth;
    const runDetailsHeightRaw =
      typeof parsed.runDetailsHeight === "number"
        ? parsed.runDetailsHeight
        : defaultLayout.runDetailsHeight;
    const wikiHeightRaw =
      typeof parsed.wikiHeight === "number" ? parsed.wikiHeight : defaultLayout.wikiHeight;
    const mapHeightRaw =
      typeof parsed.mapHeight === "number" ? parsed.mapHeight : defaultLayout.mapHeight;
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
      mapHeightRaw === LEGACY_DEFAULT_MAP_HEIGHT && mapHeightRaw < defaultLayout.mapHeight;
    const mapHeight = shouldShrinkFromPreviousDefault
      ? defaultLayout.mapHeight
      : shouldMigrateMapHeight
        ? defaultLayout.mapHeight
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
    return defaultLayout;
  }
}

function hiddenRunsStorageKey(raceId: string) {
  return `${HIDDEN_RUNS_STORAGE_KEY_PREFIX}:${raceId}`;
}

function loadHiddenRunIds(raceId: string) {
  if (typeof window === "undefined") return new Set<string>();
  try {
    const raw = window.localStorage.getItem(hiddenRunsStorageKey(raceId));
    if (!raw) return new Set<string>();
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return new Set<string>();
    return new Set(parsed.filter((v) => typeof v === "string" && v.trim().length > 0));
  } catch {
    return new Set<string>();
  }
}

function persistHiddenRunIds(raceId: string, runIds: Set<string>) {
  if (typeof window === "undefined") return;
  try {
    const list = Array.from(runIds);
    window.localStorage.setItem(hiddenRunsStorageKey(raceId), JSON.stringify(list));
  } catch {
    // ignore
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

function raceDisplayName(race: RaceState) {
  if (race.title && race.title.trim().length > 0) return race.title;
  return `${race.start_article} → ${race.destination_article}`;
}

function runDisplayName(run: RaceRun) {
  const name = run.display_name;
  return name && name.trim().length > 0 ? name : "Player";
}

function viewerResultFromRaceRun(run: RaceRun): "win" | "lose" {
  if (run.result === "win") return "win";
  return "lose";
}

function buildViewerDatasetFromRace({
  race,
  runs,
  name,
}: {
  race: RaceState;
  runs: RaceRun[];
  name: string;
}) {
  const maxSteps = Math.max(20, ...runs.map((r) => Math.max(1, r.steps.length)));

  return {
    name,
    article_list: [race.start_article, race.destination_article],
    num_trials: 1,
    num_workers: 1,
    max_steps: maxSteps,
    agent_settings: {
      model: "mixed",
      api_base: null,
      max_links: 200,
      max_tries: 3,
    },
    runs: runs.map((run) => ({
      model:
        run.kind === "human"
          ? `human/${run.display_name || "Human"}`
          : run.model || "llm",
      api_base: run.api_base || null,
      max_links: 200,
      max_tries: 3,
      result: viewerResultFromRaceRun(run),
      start_article: race.start_article,
      destination_article: race.destination_article,
      steps: run.steps,
    })),
  };
}

function runHops(run: RaceRun) {
  return typeof run.hops === "number" ? run.hops : computeHopsFromSteps(run.steps);
}

function runMaxSteps(run: RaceRun) {
  return typeof run.max_steps === "number" ? run.max_steps : DEFAULT_MAX_STEPS;
}

function runDurationMs(run: RaceRun) {
  if (typeof run.duration_ms === "number") return run.duration_ms;
  if (run.finished_at && run.started_at) {
    return Math.max(0, new Date(run.finished_at).getTime() - new Date(run.started_at).getTime());
  }
  return Number.POSITIVE_INFINITY;
}

function runElapsedMs(run: RaceRun, nowMs: number) {
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

  const startedAt = run.started_at;
  if (!startedAt) return 0;
  const startMs = new Date(startedAt).getTime();
  const endMs =
    run.status === "running"
      ? nowMs
      : run.finished_at
      ? new Date(run.finished_at).getTime()
      : nowMs;
  return Math.max(0, endMs - startMs);
}

function summarizeStepMeta(step: RaceStep) {
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

function stepOutput(step: RaceStep) {
  if (!step.metadata) return null;
  const output = (step.metadata as Record<string, unknown>).llm_output;
  return typeof output === "string" ? output : null;
}

function stepError(step: RaceStep) {
  if (!step.metadata) return null;
  const error = (step.metadata as Record<string, unknown>).error;
  return typeof error === "string" && error.trim().length > 0 ? error : null;
}

type StepMetrics = {
  latencyMs?: number;
  promptTokens?: number;
  completionTokens?: number;
  totalTokens?: number;
};

function stepMetrics(step: RaceStep): StepMetrics {
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

export default function RaceArena({
  race,
  driver,
  onGoToViewerTab,
  onNewRace,
  modelList = [],
  isServerConnected = true,
  extraHeaderActions,
}: {
  race: RaceState | null;
  driver: RaceDriver | null;
  onGoToViewerTab?: () => void;
  onNewRace?: () => void;
  modelList?: string[];
  isServerConnected?: boolean;
  extraHeaderActions?: ReactNode;
}) {
  const driverValue = driver;

  const raceId = race?.id || null;
  const raceMode: RaceMode | null = race?.mode ?? null;
  const isMobile = useMediaQuery("(max-width: 639px)");
  const [hiddenRunIds, setHiddenRunIds] = useState<Set<string>>(() => new Set());

  useEffect(() => {
    if (!raceId) {
      setHiddenRunIds(new Set());
      return;
    }
    setHiddenRunIds(loadHiddenRunIds(raceId));
  }, [raceId]);

  useEffect(() => {
    if (!raceId) return;
    persistHiddenRunIds(raceId, hiddenRunIds);
  }, [raceId, hiddenRunIds]);

  const session = useMemo(() => {
    if (!race) return null;
    if (hiddenRunIds.size === 0) return race;
    const visibleRuns = race.runs.filter((run) => !hiddenRunIds.has(run.id));
    if (visibleRuns.length === race.runs.length) return race;
    return { ...race, runs: visibleRuns };
  }, [race, hiddenRunIds]);

  const [layout, setLayout] = useState<ArenaLayout>(() => loadLayout(raceMode, isMobile));
  const prevLayoutContextRef = useRef<{ raceMode: RaceMode | null; isMobile: boolean }>({
    raceMode,
    isMobile,
  });
  useEffect(() => {
    const prev = prevLayoutContextRef.current;
    if (prev.raceMode === raceMode && prev.isMobile === isMobile) return;
    prevLayoutContextRef.current = { raceMode, isMobile };
    setLayout(loadLayout(raceMode, isMobile));
  }, [raceMode, isMobile]);
  const [selectedRunId, setSelectedRunId] = useState<string | null>(null);
  const [selectedRunIds, setSelectedRunIds] = useState<Set<string>>(() => new Set());
  const [compareEnabled, setCompareEnabled] = useState(false);
  const [compareHop, setCompareHop] = useState(0);
  const [nowTick, setNowTick] = useState<number>(() => Date.now());
  const [exportMenuOpen, setExportMenuOpen] = useState(false);
	  const [finishExportMenuOpen, setFinishExportMenuOpen] = useState(false);
	
	  const [addAiOpen, setAddAiOpen] = useState(false);
	  const [humanPaneMode, setHumanPaneMode] = useState<HumanPaneMode>(() =>
	    loadHumanPaneMode(
	      isMobile ? MOBILE_HUMAN_PANE_MODE_STORAGE_KEY : HUMAN_PANE_MODE_STORAGE_KEY
	    )
	  );
  const [linksSearchOpen, setLinksSearchOpen] = useState(false);
  const [arenaViewMode, setArenaViewMode] = useState<ArenaViewMode>("article");
  const [linkQuery, setLinkQuery] = useState<string>("");
  const [wikiLoading, setWikiLoading] = useState(false);
  const [winCelebrationRunId, setWinCelebrationRunId] = useState<string | null>(null);
  const [winToast, setWinToast] = useState<{ runId: string; message: string } | null>(null);
  const [replayEnabled, setReplayEnabled] = useState(false);
  const [replayHop, setReplayHop] = useState(0);
  const [replayPlaying, setReplayPlaying] = useState(false);
  const [mapPreviewArticle, setMapPreviewArticle] = useState<string | null>(null);
  const [directLinkMiss, setDirectLinkMiss] = useState<DirectLinkMiss | null>(null);
  const couldHaveWonLinkCacheRef = useRef<Map<string, Set<string> | null>>(new Map());
  const lastIframeNavigateRef = useRef<{ title: string; at: number } | null>(null);
  const wikiIframeRef = useRef<HTMLIFrameElement | null>(null);
  const winToastTimeoutRef = useRef<number | null>(null);
  const prevSessionIdRef = useRef<string | null>(null);
  const prevRunStateRef = useRef<Map<string, string>>(new Map());
  const [recentlyChangedRuns, setRecentlyChangedRuns] = useState<Set<string>>(new Set());
  const [linkActiveIndex, setLinkActiveIndex] = useState<number>(0);
  const [activityEvents, setActivityEvents] = useState<ArenaEvent[]>([]);
  const [activityVisible, setActivityVisible] = useState(true);
  const [finishCopyStatus, setFinishCopyStatus] = useState<"idle" | "copied" | "error">(
    "idle"
  );
  const activitySessionIdRef = useRef<string | null>(null);
  const activityRunStepsRef = useRef<Map<string, number>>(new Map());
  const activityRunLastArticleRef = useRef<Map<string, string>>(new Map());
  const runColorMapRef = useRef<Map<string, string>>(new Map());

  useEffect(() => {
    runColorMapRef.current = new Map();
  }, [race?.id]);

  const runColorById = useMemo(() => {
    const map = runColorMapRef.current;
    if (!race) return new Map<string, string>();

    for (const run of race.runs) {
      if (!map.has(run.id)) {
        map.set(run.id, RUN_COLOR_PALETTE[map.size % RUN_COLOR_PALETTE.length]!);
      }
    }

    return new Map(map);
  }, [race]);

  const getRunColor = useCallback(
    (runId: string) => runColorById.get(runId) ?? "#a1a1aa",
    [runColorById]
  );

  useEffect(() => {
    return () => {
      if (winToastTimeoutRef.current) {
        window.clearTimeout(winToastTimeoutRef.current);
        winToastTimeoutRef.current = null;
      }
    };
  }, []);


  useEffect(() => {
    if (typeof window === "undefined") return;
    window.localStorage.setItem(layoutStorageKey(raceMode, isMobile), JSON.stringify(layout));
  }, [isMobile, layout, raceMode]);

  useEffect(() => {
    setHumanPaneMode(
      loadHumanPaneMode(
        isMobile ? MOBILE_HUMAN_PANE_MODE_STORAGE_KEY : HUMAN_PANE_MODE_STORAGE_KEY
      )
    );
  }, [isMobile]);

  useEffect(() => {
    if (!isMobile) return;
    if (humanPaneMode !== "split") return;
    setHumanPaneMode("wiki");
  }, [humanPaneMode, isMobile]);

  useEffect(() => {
    if (typeof window === "undefined") return;
    if (isMobile && humanPaneMode === "split") return;
    window.localStorage.setItem(
      isMobile ? MOBILE_HUMAN_PANE_MODE_STORAGE_KEY : HUMAN_PANE_MODE_STORAGE_KEY,
      humanPaneMode
    );
  }, [humanPaneMode, isMobile]);

  useEffect(() => {
    const timer = window.setInterval(() => setNowTick(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, []);

  const triggerWinToast = useCallback(
    (run: RaceRun) => {
      const hops = runHops(run);
      const message = `${runDisplayName(run)} won in ${hops} hop${hops === 1 ? "" : "s"}`;
      setWinToast({ runId: run.id, message });

      if (winToastTimeoutRef.current) {
        window.clearTimeout(winToastTimeoutRef.current);
      }
      winToastTimeoutRef.current = window.setTimeout(() => setWinToast(null), 4500);
    },
    []
  );

  useEffect(() => {
    if (!session) {
      prevSessionIdRef.current = null;
      prevRunStateRef.current = new Map();
      setWinToast(null);
      if (winToastTimeoutRef.current) {
        window.clearTimeout(winToastTimeoutRef.current);
        winToastTimeoutRef.current = null;
      }
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
      triggerWinToast(run);
      if (run.kind === "human") {
        setWinCelebrationRunId(run.id);
      }
    }

    prevRunStateRef.current = next;
  }, [session, triggerWinToast]);

  useEffect(() => {
    if (!session) {
      activitySessionIdRef.current = null;
      activityRunStepsRef.current = new Map();
      activityRunLastArticleRef.current = new Map();
      setActivityEvents([]);
      return;
    }

    if (activitySessionIdRef.current !== session.id) {
      activitySessionIdRef.current = session.id;
      activityRunStepsRef.current = new Map(
        session.runs.map((r) => [r.id, r.steps.length])
      );
      activityRunLastArticleRef.current = new Map(
        session.runs.map((r) => [
          r.id,
          r.steps[r.steps.length - 1]?.article || session.start_article,
        ])
      );
      setActivityVisible(true);
      setActivityEvents([
        {
          id: `session-${session.id}`,
          kind: "info",
          message: `Race started: ${session.start_article} → ${session.destination_article}`,
          at: Date.now(),
        },
      ]);
      return;
    }

    const prevSteps = activityRunStepsRef.current;
    const prevLast = activityRunLastArticleRef.current;
    const knownIds = new Set(session.runs.map((r) => r.id));
    for (const id of Array.from(prevSteps.keys())) {
      if (!knownIds.has(id)) {
        prevSteps.delete(id);
        prevLast.delete(id);
      }
    }

    const now = Date.now();
    let serial = 0;
    const newEvents: ArenaEvent[] = [];

    for (const run of session.runs) {
      const prevLen = prevSteps.get(run.id);
      const prevArticle = prevLast.get(run.id) || session.start_article;

      if (typeof prevLen !== "number") {
        newEvents.push({
          id: `join-${run.id}-${now}-${serial++}`,
          kind: "info",
          message: `${runDisplayName(run)} joined the race`,
          at: now + serial,
        });
        prevSteps.set(run.id, run.steps.length);
        prevLast.set(
          run.id,
          run.steps[run.steps.length - 1]?.article || prevArticle
        );
        continue;
      }

      if (run.steps.length <= prevLen) continue;

      let from = prevArticle;
      const addedSteps = run.steps.slice(prevLen);
      for (const step of addedSteps) {
        if (step.type === "start") {
          from = step.article;
          continue;
        }
        if (step.type === "move") {
          newEvents.push({
            id: `move-${run.id}-${now}-${serial++}`,
            kind: "move",
            message: `${runDisplayName(run)} moved: ${from} → ${step.article}`,
            at: now + serial,
          });
          from = step.article;
          continue;
        }
        if (step.type === "win") {
          const hops = runHops(run);
          newEvents.push({
            id: `win-${run.id}-${now}-${serial++}`,
            kind: "win",
            message: `${runDisplayName(run)} won in ${hops} hop${hops === 1 ? "" : "s"}`,
            at: now + serial,
          });
          from = step.article;
          continue;
        }
        if (step.type === "lose") {
          const reasonRaw = step.metadata?.reason;
          const reason =
            typeof reasonRaw === "string" && reasonRaw.trim().length > 0
              ? reasonRaw
              : null;
          newEvents.push({
            id: `lose-${run.id}-${now}-${serial++}`,
            kind: "lose",
            message: `${runDisplayName(run)} lost${reason ? ` (${reason})` : ""}`,
            at: now + serial,
          });
          from = step.article;
        }
      }

      prevSteps.set(run.id, run.steps.length);
      prevLast.set(
        run.id,
        run.steps[run.steps.length - 1]?.article || from
      );
    }

    if (newEvents.length > 0) {
      newEvents.sort((a, b) => b.at - a.at);
      setActivityEvents((prev) => [...newEvents, ...prev].slice(0, 14));
    }
  }, [session]);

  const runsById = useMemo(() => {
    const map = new Map<string, RaceRun>();
    if (!session) return map;
    for (const r of session.runs) map.set(r.id, r);
    return map;
  }, [session]);

  const selectedRun = selectedRunId ? runsById.get(selectedRunId) : null;
  const selectedRunColor = selectedRun ? getRunColor(selectedRun.id) : null;

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

    const yourDefaultRunId =
      session.mode === "multiplayer" && session.you_player_id
        ? session.runs.find(
            (run) => run.kind === "human" && run.player_id === session.you_player_id
          )?.id
        : null;
    const firstRunning = session.runs.find((r) => r.status === "running")?.id;
    setSelectedRunId(yourDefaultRunId || firstRunning || session.runs[0]?.id || null);
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
    return currentArticleFromSteps(selectedRun.steps, session.start_article);
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
  const wikiArticle = mapPreviewArticle ?? displayedArticle;

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
  const selectedRunFinished = selectedRunStatus !== null && selectedRunStatus !== "running";
  const lockWikiNavigation = replayEnabled && !selectedRunFinished;
  const includeImageLinks = Boolean(session?.rules.include_image_links);
  const disableLinksView = Boolean(session?.rules.disable_links_view);

  const wikiHeightMultiplier = session?.mode === "multiplayer" && isSelectedHuman ? 2 : 1;
  const effectiveWikiHeight = layout.wikiHeight * wikiHeightMultiplier;

  const selectedRunTokenTotals = useMemo(() => {
    if (!selectedRun || selectedRun.kind !== "llm") return null;
    return sumTokenUsageFromSteps(selectedRun.steps);
  }, [selectedRun]);

  const autoStartHumanTimer = session?.human_timer?.auto_start_on_first_action !== false;

  // Hotseat: only the active (selected) human's timer should run.
  useEffect(() => {
    if (!driverValue?.pauseHumanTimers) return;
    if (!selectedRunIdValue || !selectedRunKind || !selectedRunStatus) {
      driverValue.pauseHumanTimers(null);
      return;
    }

    if (selectedRunKind === "human" && selectedRunStatus === "running") {
      driverValue.pauseHumanTimers(selectedRunIdValue);
      return;
    }

    driverValue.pauseHumanTimers(null);
  }, [driverValue, selectedRunIdValue, selectedRunKind, selectedRunStatus]);

  useEffect(() => {
    if (!driverValue?.pauseHumanTimers || !driverValue.resumeHumanTimerForRun) return;
    if (!autoStartHumanTimer) return;
    if (!selectedRunIdValue) return;
    if (selectedRunKind !== "human" || selectedRunStatus !== "running") return;
    if (selectedHumanTimerState !== "not_started") return;
    if (replayEnabled) return;

    driverValue.pauseHumanTimers(selectedRunIdValue);
    driverValue.resumeHumanTimerForRun(selectedRunIdValue);
  }, [
    autoStartHumanTimer,
    driverValue,
    replayEnabled,
    selectedHumanTimerState,
    selectedRunIdValue,
    selectedRunKind,
    selectedRunStatus,
  ]);

  useEffect(() => {
    if (!selectedRunFinished) return;
    if (arenaViewMode !== "results") setArenaViewMode("results");
  }, [selectedRunFinished, arenaViewMode]);

  useEffect(() => {
    setMapPreviewArticle(null);
  }, [selectedRunId]);

  // When a human run is finished/abandoned, hide the (now irrelevant) links panel by default.
  useEffect(() => {
    if (!selectedRunKind || !selectedRunStatus) return;
    if (selectedRunKind !== "human") return;
    if (selectedRunStatus === "running") return;
    if (humanPaneMode !== "wiki") setHumanPaneMode("wiki");
  }, [selectedRunId, selectedRunKind, selectedRunStatus, humanPaneMode]);

  useEffect(() => {
    if (!disableLinksView) return;
    if (selectedRunKind !== "human") return;
    if (humanPaneMode !== "wiki") setHumanPaneMode("wiki");
  }, [disableLinksView, selectedRunKind, humanPaneMode]);

  useEffect(() => {
    setLinkQuery("");
    setLinkActiveIndex(0);
    setLinksSearchOpen(false);
  }, [selectedRunId, wikiArticle]);

  const fetchOutgoingLinkSet = useCallback(async (articleTitle: string) => {
    const cache = couldHaveWonLinkCacheRef.current;
    const key = normalizeWikiTitle(articleTitle);
    if (cache.has(key)) return cache.get(key) ?? null;

    try {
      const response = await fetch(
        `${API_BASE}/get_article_with_links/${encodeURIComponent(articleTitle)}`
      );
      if (!response.ok) {
        cache.set(key, null);
        trimCacheMap(cache, COULD_HAVE_WON_LINK_CACHE_SIZE);
        return null;
      }
      const data = (await response.json()) as { links?: unknown };
      if (!data || !Array.isArray(data.links)) {
        cache.set(key, null);
        trimCacheMap(cache, COULD_HAVE_WON_LINK_CACHE_SIZE);
        return null;
      }
      const normalized = new Set<string>();
      for (const link of data.links) {
        if (typeof link === "string") normalized.add(normalizeWikiTitle(link));
      }
      cache.set(key, normalized);
      trimCacheMap(cache, COULD_HAVE_WON_LINK_CACHE_SIZE);
      return normalized;
    } catch {
      cache.set(key, null);
      trimCacheMap(cache, COULD_HAVE_WON_LINK_CACHE_SIZE);
      return null;
    }
  }, []);

  useEffect(() => {
    let cancelled = false;
    setDirectLinkMiss(null);

    if (!session) return;
    if (!selectedRun) return;
    if (!selectedRunFinished) return;
    if (selectedRun.steps.length < 2) return;

    const destination = session.destination_article;
    const normalizedDestination = normalizeWikiTitle(destination);

    void (async () => {
      for (let hopIndex = 0; hopIndex < selectedRun.steps.length - 1; hopIndex += 1) {
        const fromArticle = selectedRun.steps[hopIndex]?.article;
        const nextArticle = selectedRun.steps[hopIndex + 1]?.article;
        if (!fromArticle || !nextArticle) continue;
        if (wikiTitlesMatch(nextArticle, destination)) continue;

        const outgoing = await fetchOutgoingLinkSet(fromArticle);
        if (cancelled) return;
        if (!outgoing) continue;

        if (outgoing.has(normalizedDestination)) {
          setDirectLinkMiss({ hopIndex, fromArticle });
          return;
        }
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [fetchOutgoingLinkSet, selectedRun, selectedRunFinished, session]);

  const leaderboardSections = useMemo(() => {
    if (!session) {
      return { running: [] as RaceRun[], ranked: [] as RaceRun[], unranked: [] as RaceRun[] };
    }

    const running = session.runs
      .filter((r) => r.status === "running")
      .sort(
        (a, b) =>
          new Date(a.started_at || 0).getTime() - new Date(b.started_at || 0).getTime()
      );

    const ranked = session.runs
      .filter((r) => r.status !== "running" && r.result === "win")
      .sort((a, b) => {
        const hopsDiff = runHops(a) - runHops(b);
        if (hopsDiff !== 0) return hopsDiff;
        const durationDiff = runDurationMs(a) - runDurationMs(b);
        if (durationDiff !== 0) return durationDiff;
        return new Date(a.started_at || 0).getTime() - new Date(b.started_at || 0).getTime();
      });

    const unranked = session.runs
      .filter((r) => r.status !== "running" && r.result !== "win")
      .sort(
        (a, b) =>
          new Date(b.started_at || 0).getTime() - new Date(a.started_at || 0).getTime()
      );

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
    if (!session) return map;

    for (const runIndex of compareRunIndices) {
      const run = session.runs[runIndex];
      if (!run) continue;
      map[runIndex] = getRunColor(run.id);
    }
    return map;
  }, [compareRunIndices, getRunColor, session]);

  const handleMapNodeSelect = useCallback(
    (node: { id: string }) => {
      if (!selectedRun) return;
      const nodeTitle = node.id;
      if (!nodeTitle) return;

      let matchedIdx = -1;
      for (let i = 0; i < selectedRun.steps.length; i++) {
        const article = selectedRun.steps[i]?.article;
        if (!article) continue;
        if (wikiTitlesMatch(article, nodeTitle)) matchedIdx = i;
      }

      if (matchedIdx >= 0) {
        setMapPreviewArticle(null);
        setReplayEnabled(true);
        setReplayPlaying(false);
        setReplayHop(matchedIdx);
      } else if (selectedRun.status !== "running") {
        setMapPreviewArticle(nodeTitle);
        setReplayEnabled(false);
        setReplayPlaying(false);
      } else {
        return;
      }

      if (selectedRun.status === "running" && arenaViewMode !== "article") {
        setArenaViewMode("article");
      }
    },
    [arenaViewMode, selectedRun]
  );

  const [links, setLinks] = useState<string[]>([]);
  const [linksTitle, setLinksTitle] = useState<string | null>(null);
  const [linksLoading, setLinksLoading] = useState(false);
  const [linksError, setLinksError] = useState<string | null>(null);
  const [wikiPageLinks, setWikiPageLinks] = useState<{ title: string; links: string[] } | null>(
    null
  );
  const linksFetchIdRef = useRef(0);

  useEffect(() => {
    setWikiPageLinks(null);
    setLinksTitle(null);
  }, [selectedRunIdValue]);

  useEffect(() => {
    setWikiPageLinks((prev) => {
      if (!prev) return prev;
      if (wikiTitlesMatch(prev.title, wikiArticle)) return prev;
      return null;
    });
    setLinksTitle((prev) => {
      if (!prev) return prev;
      if (wikiTitlesMatch(prev, wikiArticle)) return prev;
      return null;
    });
  }, [wikiArticle]);

  const linksArticle = wikiPageLinks?.title ?? wikiArticle;
  const hasLinksForArticle = Boolean(linksTitle && wikiTitlesMatch(linksTitle, linksArticle));
  const linksReady =
    hasLinksForArticle &&
    !linksLoading &&
    wikiPageLinks !== null;

  const sortedLinks = useMemo(() => {
    if (!hasLinksForArticle) return [];
    return [...links].sort((a, b) => a.localeCompare(b));
  }, [hasLinksForArticle, links]);

  const availableLinks = useMemo(() => {
    if (!linksReady) return [];
    if (!wikiPageLinks) return [];
    const pageSet = new Set(wikiPageLinks.links.map((link) => normalizeWikiTitle(link)));
    return sortedLinks.filter((link) => pageSet.has(normalizeWikiTitle(link)));
  }, [linksReady, sortedLinks, wikiPageLinks]);

  const filteredLinks = useMemo(() => {
    const q = linkQuery.trim().toLowerCase();
    if (q.length === 0) return availableLinks;
    return availableLinks.filter((link) => link.toLowerCase().includes(q));
  }, [availableLinks, linkQuery]);

  const visibleLinks = filteredLinks;

  useEffect(() => {
    setLinkActiveIndex((prev) =>
      clampNumber(prev, 0, Math.max(0, visibleLinks.length - 1))
    );
  }, [visibleLinks.length]);


  const fetchLinks = useCallback(
    async (articleTitle: string) => {
      const fetchId = (linksFetchIdRef.current += 1);
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
        if (fetchId !== linksFetchIdRef.current) return;
        setLinks(data.links as string[]);
        setLinksTitle(articleTitle);
	      } catch (err) {
	        if (fetchId !== linksFetchIdRef.current) return;
	        const msg = err instanceof Error ? err.message : String(err);
	        setLinks([]);
	        setLinksError(msg);
	      } finally {
	        if (fetchId === linksFetchIdRef.current) {
	          setLinksLoading(false);
	        }
	      }
	    },
	    []
	  );

  useEffect(() => {
    if (!isSelectedHuman) return;
    if (!isSelectedRunning) return;
    if (!selectedRun) return;
    if (!linksArticle) return;
    if (hasLinksForArticle) return;
    fetchLinks(linksArticle);
  }, [fetchLinks, hasLinksForArticle, isSelectedHuman, isSelectedRunning, linksArticle, selectedRun]);

  const canControlSelectedRun = useMemo(() => {
    if (!driverValue) return false;
    if (!selectedRunIdValue) return false;
    if (selectedRunKind !== "human") return false;
    if (selectedRunStatus !== "running") return false;
    return driverValue.capabilities.canControlRun(selectedRunIdValue);
  }, [driverValue, selectedRunIdValue, selectedRunKind, selectedRunStatus]);

  const moveSelectedRun = useCallback(
    async (nextArticle: string) => {
      if (replayEnabled) return false;
      if (!driverValue) return false;
      if (!selectedRunIdValue) return false;
      if (!canControlSelectedRun) return false;
      setMapPreviewArticle(null);
      return await driverValue.makeMove({ runId: selectedRunIdValue, title: nextArticle });
    },
    [canControlSelectedRun, driverValue, replayEnabled, selectedRunIdValue]
  );

  useEffect(() => {
    if (!session) return;
    if (!driverValue?.forceWinRun) return;

    for (const run of session.runs) {
      if (run.kind !== "human") continue;
      if (run.status !== "running") continue;
      const last = run.steps[run.steps.length - 1]?.article;
      if (!last) continue;
      if (!wikiTitlesMatch(last, session.destination_article)) continue;

      driverValue.forceWinRun(run.id);
    }
  }, [driverValue, session]);

  const wikiArticleRef = useRef(wikiArticle);
  useEffect(() => {
    wikiArticleRef.current = wikiArticle;
  }, [wikiArticle]);

  const moveSelectedRunRef = useRef(moveSelectedRun);
  useEffect(() => {
    moveSelectedRunRef.current = moveSelectedRun;
  }, [moveSelectedRun]);

  // Allow navigation by clicking links inside the Wikipedia iframe.
  // When the selected run is finished we treat this as "explore" mode (no hops recorded).
  useEffect(() => {
    if (!selectedRunIdValue) return;

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
      const msg = data as {
        type?: unknown;
        title?: unknown;
        links?: unknown;
        requestId?: unknown;
      };

      if (msg.type === "wikirace:navigate_request") {
        const requestId = msg.requestId;
        if (typeof requestId !== "string" || requestId.length === 0) return;

        const respond = (allow: boolean) => {
          try {
            (event.source as WindowProxy | null)?.postMessage(
              { type: "wikirace:navigate_response", requestId, allow },
              event.origin
            );
          } catch {
            // ignore
          }
        };

        const title = msg.title;
        if (typeof title !== "string" || title.length === 0) {
          respond(false);
          return;
        }

        // During an active run, replay mode locks the iframe (no navigation).
        // After a run finishes, we allow navigation for "explore" mode even if replay is enabled.
        if (lockWikiNavigation) {
          respond(false);
          return;
        }

        const now = Date.now();
        const last = lastIframeNavigateRef.current;
        if (last && last.title === title && now - last.at < 1000) {
          respond(true);
          return;
        }
        lastIframeNavigateRef.current = { title, at: now };

        const isSelectedHumanRunning =
          selectedRunKind === "human" && selectedRunStatus === "running";
        if (isSelectedHumanRunning) {
          if (!canControlSelectedRun) {
            setMapPreviewArticle(title);
            respond(true);
            return;
          }

          void (async () => {
            const ok = await moveSelectedRunRef.current(title);
            respond(ok);
          })();
          return;
        }

        setMapPreviewArticle(title);
        respond(true);
        return;
      }

      if (msg.type === "wikirace:pageLinks") {
        const title = msg.title;
        if (typeof title !== "string" || title.length === 0) return;
        if (!wikiTitlesMatch(title, wikiArticleRef.current)) return;
        const links = msg.links;
        if (!Array.isArray(links)) return;
        if (links.some((link) => typeof link !== "string")) return;
        setWikiPageLinks({ title, links: links as string[] });
        return;
      }

      if (msg.type !== "wikirace:navigate") return;
      const title = msg.title;
      if (typeof title !== "string" || title.length === 0) return;

      // During an active run, replay mode locks the iframe (no navigation).
      // After a run finishes, we allow navigation for "explore" mode even if replay is enabled.
      if (lockWikiNavigation) return;

      const now = Date.now();
      const last = lastIframeNavigateRef.current;
      if (last && last.title === title && now - last.at < 1000) return;
      lastIframeNavigateRef.current = { title, at: now };

      const isSelectedHumanRunning =
        selectedRunKind === "human" && selectedRunStatus === "running";
      if (isSelectedHumanRunning) {
        if (canControlSelectedRun) {
          void moveSelectedRunRef.current(title);
        } else {
          setMapPreviewArticle(title);
        }
        return;
      }

      // Exploration mode: update the UI without affecting run steps.
      setMapPreviewArticle(title);
    };

    window.addEventListener("message", handleMessage);
    return () => window.removeEventListener("message", handleMessage);
  }, [
    canControlSelectedRun,
    lockWikiNavigation,
    replayEnabled,
    selectedRunIdValue,
    selectedRunKind,
    selectedRunStatus,
  ]);

  const exportRaceJson = () => {
    if (!session) return;
    downloadJson(
      `${(session.title || `${session.start_article}-${session.destination_article}`)
        .replaceAll(" ", "_")
        .slice(0, 80)}.race.json`,
      {
        schema_version: 1,
        exported_at: new Date().toISOString(),
        race: session,
      }
    );
  };

  const wikiSrc = useMemo(() => {
    if (!wikiArticle) return "";
    return `${API_BASE}/wiki/${encodeURIComponent(
      wikiArticle.replaceAll(" ", "_")
    )}`;
  }, [wikiArticle]);

  const wikiZoomValue = normalizeWikiZoom(layout.wikiZoom);
  const wikiScale = wikiZoomValue / 100;
  const wikiZoomMultiplier = 1 / wikiScale;

  const wikiPostMessageOrigin = useMemo((): string | null => {
    if (typeof window === "undefined") return null;
    if (!wikiSrc) return window.location.origin;

    // Ensure we only send messages to the iframe's origin (dev: API origin; prod: same-origin).
    try {
      return new URL(wikiSrc, window.location.href).origin;
    } catch {
      return window.location.origin;
    }
  }, [wikiSrc]);

  const postWikiReplayMode = useCallback((enabled: boolean) => {
    if (!wikiPostMessageOrigin) return;
    wikiIframeRef.current?.contentWindow?.postMessage(
      { type: "wikirace:setReplayMode", enabled },
      wikiPostMessageOrigin
    );
  }, [wikiPostMessageOrigin]);

  const postWikiIncludeImageLinks = useCallback((enabled: boolean) => {
    if (!wikiPostMessageOrigin) return;
    wikiIframeRef.current?.contentWindow?.postMessage(
      { type: "wikirace:setIncludeImageLinks", enabled },
      wikiPostMessageOrigin
    );
  }, [wikiPostMessageOrigin]);

  useEffect(() => {
    if (!session) return;
    if (!wikiSrc) return;
    setWikiLoading(true);
  }, [session, wikiSrc]);

  useEffect(() => {
    if (!wikiSrc) return;
    postWikiReplayMode(lockWikiNavigation);
  }, [lockWikiNavigation, postWikiReplayMode, wikiSrc]);

  useEffect(() => {
    if (!wikiSrc) return;
    postWikiIncludeImageLinks(includeImageLinks);
  }, [includeImageLinks, postWikiIncludeImageLinks, wikiSrc]);

  const exportViewerJson = () => {
    if (!session) return;
    const dataset = buildViewerDatasetFromRace({
      race: session,
      runs: session.runs,
      name: raceDisplayName(session),
    });
    downloadJson("viewer-dataset.json", dataset);
  };

  const saveToViewer = () => {
    if (!session) return;
    const dataset = buildViewerDatasetFromRace({
      race: session,
      runs: session.runs,
      name: raceDisplayName(session),
    });
    addViewerDataset({ name: dataset.name, data: dataset });
    onGoToViewerTab?.();
  };

  const copyRaceSummary = async () => {
    if (!session) return;

    const lines: string[] = [];
    lines.push(`Race: ${raceDisplayName(session)}`);
    lines.push(`${session.start_article} → ${session.destination_article}`);
    lines.push("");

    const finishedRuns = [...leaderboardSections.ranked, ...leaderboardSections.unranked];
    if (finishedRuns.length === 0) {
      lines.push("No finished runs.");
    } else {
      lines.push("Results:");
      for (let i = 0; i < finishedRuns.length; i++) {
        const run = finishedRuns[i]!;
        const hops = runHops(run);
        const durationSeconds = Math.max(0, Math.floor(runDurationMs(run) / 1000));
        const result = run.result || run.status;
        lines.push(
          `- ${runDisplayName(run)}: ${result} • ${hops} hop${hops === 1 ? "" : "s"} • ${formatTime(durationSeconds)}`
        );
      }
    }

    const text = lines.join("\n");

    try {
      await navigator.clipboard.writeText(text);
      setFinishCopyStatus("copied");
      window.setTimeout(() => setFinishCopyStatus("idle"), 1800);
    } catch {
      setFinishCopyStatus("error");
      window.setTimeout(() => setFinishCopyStatus("idle"), 1800);
    }
  };

  const startSelectedTurn = () => {
    if (!driverValue?.pauseHumanTimers || !driverValue.resumeHumanTimerForRun) return;
    if (!selectedRun) return;
    if (selectedRun.kind !== "human") return;
    if (selectedRun.status !== "running") return;
    if (!selectedRun.timer_state) return;
    driverValue.pauseHumanTimers(selectedRun.id);
    driverValue.resumeHumanTimerForRun(selectedRun.id);
  };

  const endSelectedTurn = () => {
    if (!driverValue?.pauseHumanTimerForRun) return;
    if (!selectedRun) return;
    if (selectedRun.kind !== "human") return;
    if (selectedRun.status !== "running") return;
    if (!selectedRun.timer_state) return;
    driverValue.pauseHumanTimerForRun(selectedRun.id);
  };

  const abandonSelected = () => {
    if (!driverValue?.abandonRun) return;
    if (!selectedRun) return;
    driverValue.abandonRun(selectedRun.id);
  };

  const deleteSelected = () => {
    if (!driverValue?.deleteRuns) return;
    if (!selectedRun) return;
    driverValue.deleteRuns([selectedRun.id]);
  };

  const hideSelected = () => {
    if (!selectedRun) return;
    setHiddenRunIds((prev) => {
      const next = new Set(prev);
      next.add(selectedRun.id);
      return next;
    });
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
    if (!driverValue?.deleteRuns) return;
    const runIds = Array.from(selectedRunIds);
    if (runIds.length === 0) return;
    driverValue.deleteRuns(runIds);
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
            Start a race or add racers to begin building a persistent leaderboard.
          </p>
        </Card>
      </div>
    );
  }

  const headerTitle = raceDisplayName(session);
	  const headerSubtitle =
	    session.title && session.title.trim().length > 0
	      ? `${session.start_article} → ${session.destination_article}`
	      : null;
	  const canAddAi = Boolean(driverValue?.addAi && driverValue.capabilities.canAddAi);
	  const defaultLayout = defaultLayoutForMode(session.mode);
	  const isMultiplayerMobile = isMobile && session.mode === "multiplayer";
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

      {winToast && (
        <div className="fixed top-4 right-4 z-40">
          <div className="flex items-center gap-2 rounded-md border bg-background/95 px-3 py-2 shadow-lg backdrop-blur animate-in fade-in-0 slide-in-from-top-2">
            <Trophy className="h-4 w-4 text-primary" />
            <div className="text-sm font-medium">{winToast.message}</div>
            <button
              type="button"
              className="ml-2 inline-flex h-7 w-7 items-center justify-center rounded-md text-muted-foreground hover:text-foreground"
              onClick={() => {
                setWinToast(null);
                if (winToastTimeoutRef.current) {
                  window.clearTimeout(winToastTimeoutRef.current);
                  winToastTimeoutRef.current = null;
                }
              }}
              aria-label="Dismiss win message"
            >
              <X className="h-4 w-4" />
            </button>
          </div>
        </div>
      )}

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
	            {extraHeaderActions}
	            {driverValue?.mode === "local" && modelList.length > 0 && (
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

		            {canAddAi && !isMultiplayerMobile && (
		              <Dialog open={addAiOpen} onOpenChange={setAddAiOpen}>
		                <DialogTrigger asChild>
		                  <Button variant="outline" size="sm">
		                    Add AI
		                  </Button>
		                </DialogTrigger>
		                <DialogContent className="sm:max-w-lg">
		                  <DialogHeader>
		                    <DialogTitle>Add AI racer</DialogTitle>
		                    <DialogDescription>
		                      The server will run this AI to completion.
		                    </DialogDescription>
		                  </DialogHeader>

		                  <AddAiForm
		                    mode="dialog"
		                    modelList={modelList}
		                    defaults={session.rules}
		                    existingRuns={race?.runs ?? session.runs}
		                    onAddAi={async (args) => {
		                      if (!driverValue?.addAi) return false;
		                      return driverValue.addAi(args);
		                    }}
		                    onClose={() => setAddAiOpen(false)}
		                  />
		                </DialogContent>
		              </Dialog>
		            )}
	            {onNewRace && (
	              <Button variant="secondary" size="sm" onClick={onNewRace}>
	                New race
	              </Button>
	            )}
	            {hiddenRunIds.size > 0 && !isMultiplayerMobile && (
	              <Button
	                variant="outline"
	                size="sm"
	                onClick={() => setHiddenRunIds(new Set())}
	              >
	                Show hidden ({hiddenRunIds.size})
	              </Button>
	            )}
	            {!isMultiplayerMobile && (
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
	                      exportRaceJson();
	                      setExportMenuOpen(false);
	                    }}
	                  >
	                    Race JSON
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
	                </PopoverContent>
	              </Popover>
	            )}
	            {!isMultiplayerMobile && (
	              <Button
	                variant="default"
	                size="sm"
	                onClick={saveToViewer}
	                disabled={session.runs.length === 0}
	              >
	                Save to viewer
	              </Button>
	            )}
          </div>
	        </div>
	      </Card>

        {sessionAllRunsFinished && session.runs.length > 0 && (
          <Card className="p-3">
            <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
              <div className="space-y-1">
                <div className="flex items-center gap-2">
                  <Trophy className="h-4 w-4 text-status-finished" />
                  <div className="text-sm font-semibold">Race finished</div>
                </div>
                <div className="text-xs text-muted-foreground">
                  {leaderboardSections.ranked.length > 0
                    ? `${leaderboardSections.ranked.length} win${leaderboardSections.ranked.length === 1 ? "" : "s"} • ${leaderboardSections.unranked.length} other`
                    : `No wins • ${leaderboardSections.unranked.length} finished run${leaderboardSections.unranked.length === 1 ? "" : "s"}`}
                </div>
              </div>

              <div className="flex flex-wrap items-center gap-2">
                {!isMultiplayerMobile && (
                  <Button size="sm" onClick={saveToViewer} disabled={session.runs.length === 0}>
                    Save to viewer
                  </Button>
                )}

                <Button
                  size="sm"
                  variant="outline"
                  className="gap-2"
                  onClick={copyRaceSummary}
                >
                  {finishCopyStatus === "copied" ? (
                    <Check className="h-4 w-4" />
                  ) : (
                    <Copy className="h-4 w-4" />
                  )}
                  {finishCopyStatus === "copied"
                    ? "Copied"
                    : finishCopyStatus === "error"
                      ? "Copy failed"
                      : "Copy summary"}
                </Button>

                {!isMultiplayerMobile && (
                  <Popover open={finishExportMenuOpen} onOpenChange={setFinishExportMenuOpen}>
                    <PopoverTrigger asChild>
                      <Button variant="outline" size="sm" className="gap-2">
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
                          exportRaceJson();
                          setFinishExportMenuOpen(false);
                        }}
                      >
                        Race JSON
                      </Button>
                      <Button
                        type="button"
                        variant="ghost"
                        className="w-full justify-start"
                        onClick={() => {
                          exportViewerJson();
                          setFinishExportMenuOpen(false);
                        }}
                      >
                        Viewer JSON
                      </Button>
                    </PopoverContent>
                  </Popover>
                )}
              </div>
            </div>

            {leaderboardSections.ranked.length > 0 ? (
              <div className="mt-3 grid grid-cols-1 gap-2 sm:grid-cols-3">
                {leaderboardSections.ranked.slice(0, 3).map((run, idx) => {
                  const hops = runHops(run);
                  const durationSeconds = Math.max(0, Math.floor(runDurationMs(run) / 1000));
                  const color = getRunColor(run.id);
                  return (
                    <div key={run.id} className="rounded-md border bg-muted/10 p-2">
                      <div className="flex items-center gap-2 min-w-0">
                        <div className="text-[11px] font-semibold text-competitive w-6">
                          #{idx + 1}
                        </div>
                        <span
                          className="h-2 w-2 rounded-full flex-shrink-0"
                          style={{ backgroundColor: color }}
                          aria-hidden="true"
                        />
                        <div className="text-sm font-medium truncate">
                          {runDisplayName(run)}
                        </div>
                      </div>
                      <div className="mt-1 text-[11px] text-muted-foreground">
                        {hops} hop{hops === 1 ? "" : "s"} • {formatTime(durationSeconds)}
                      </div>
                    </div>
                  );
                })}
              </div>
            ) : (
              <div className="mt-3 text-xs text-muted-foreground">
                No wins recorded for this race.
              </div>
            )}
          </Card>
        )}

	  <div className="flex flex-col gap-4 sm:flex-row sm:gap-0 items-stretch">
        {layout.leaderboardCollapsed ? null : (
          <>
            <div
	              className="min-w-0 flex-shrink-0 w-full order-2 sm:order-none"
	              style={isMobile ? undefined : { width: layout.leaderboardWidth }}
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
	                    variant={compareEnabled ? "competitive" : "outline"}
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
                  <Button
                    variant="outline"
                    size="sm"
                    className="h-8 gap-2"
                    onClick={clearSelectedRuns}
                  >
                    <X className="h-4 w-4" />
                    Clear
                  </Button>
                )}

	              {selectedRunIds.size > 0 && driverValue?.deleteRuns && !isMultiplayerMobile && (
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
                  const runColor = getRunColor(r.id);
                  const statusLabel =
                    r.kind === "human" && r.timer_state
                      ? r.timer_state === "running"
                        ? "Running"
                        : r.timer_state === "paused"
                        ? "Paused"
                        : "Waiting"
                      : "Running";
                  const statusChipStatus =
                    statusLabel === "Running"
                      ? "running"
                      : statusLabel === "Paused"
                        ? "active"
                        : "neutral";

                return (
                    <button
                      key={r.id}
                      type="button"
                      onClick={() => setSelectedRunId(r.id)}
                      style={{ borderLeftColor: runColor }}
                      className={cn(
                        "w-full text-left rounded-lg border border-l-4 p-2 transition-colors",
                        isActive
                          ? "border-status-active/40 bg-status-active/5 shadow-[var(--shadow-card)] ring-1 ring-status-active/15"
                          : "hover:bg-muted/50 border-border border-l-transparent",
                        isTimerRunning &&
                          "ring-2 ring-status-running/30 ring-offset-1 ring-offset-background",
                        isRecentlyChanged && "animate-pulse motion-reduce:animate-none"
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
                            <span
                              className="h-2 w-2 rounded-full flex-shrink-0"
                              style={{ backgroundColor: runColor }}
                              aria-hidden="true"
                            />
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
                        <StatusChip status={statusChipStatus}>{statusLabel}</StatusChip>
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
                  const runColor = getRunColor(r.id);

                return (
                    <button
                      key={r.id}
                      type="button"
                      onClick={() => setSelectedRunId(r.id)}
                      style={{ borderLeftColor: runColor }}
                      className={cn(
                        "w-full text-left rounded-lg border border-l-4 p-2 transition-colors",
                        isActive
                          ? "border-status-active/40 bg-status-active/5 shadow-[var(--shadow-card)] ring-1 ring-status-active/15"
                          : "hover:bg-muted/50 border-border border-l-transparent",
                        isTimerRunning &&
                          "ring-2 ring-status-running/30 ring-offset-1 ring-offset-background",
                        isRecentlyChanged && "animate-pulse motion-reduce:animate-none"
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
                            <div
                              className={cn(
                                "text-[11px] font-semibold w-7",
                                idx < 3 ? "text-competitive" : "text-muted-foreground"
                              )}
                            >
                              #{idx + 1}
                            </div>
                            <span
                              className="h-2 w-2 rounded-full flex-shrink-0"
                              style={{ backgroundColor: runColor }}
                              aria-hidden="true"
                            />
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
                        <StatusChip status="finished">Win</StatusChip>
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
                  const runColor = getRunColor(r.id);

                return (
                    <button
                      key={r.id}
                      type="button"
                      onClick={() => setSelectedRunId(r.id)}
                      style={{ borderLeftColor: runColor }}
                      className={cn(
                        "w-full text-left rounded-lg border border-l-4 p-2 transition-colors",
                        "opacity-80 bg-muted/20",
                        isActive
                          ? "border-status-active/40 bg-status-active/5 opacity-100 shadow-[var(--shadow-card)] ring-1 ring-status-active/15"
                          : "hover:bg-muted/40 border-border border-l-transparent",
                        isTimerRunning &&
                          "ring-2 ring-status-running/30 ring-offset-1 ring-offset-background",
                        isRecentlyChanged && "animate-pulse motion-reduce:animate-none"
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
                            <span
                              className="h-2 w-2 rounded-full flex-shrink-0"
                              style={{ backgroundColor: runColor }}
                              aria-hidden="true"
                            />
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
                        <StatusChip status={badgeLabel === "Fail" ? "error" : "neutral"}>
                          {badgeLabel}
                        </StatusChip>
                        <div className="text-[11px] text-muted-foreground">
                          {hops}/{maxSteps} • {formatTime(elapsed)}
                        </div>
                      </div>
                    </div>
                  </button>
                );
              })}
	            </div>

              <Separator className="my-3" />

              {activityVisible ? (
                <div className="rounded-lg border bg-muted/20 p-2">
                  <div className="flex items-center justify-between gap-2">
                    <div className="text-[11px] font-semibold text-muted-foreground">
                      Activity
                    </div>
                    <button
                      type="button"
                      className="inline-flex h-6 w-6 items-center justify-center rounded-md text-muted-foreground hover:text-foreground"
                      onClick={() => setActivityVisible(false)}
                      aria-label="Hide activity"
                    >
                      <X className="h-3.5 w-3.5" />
                    </button>
                  </div>

                  {activityEvents.length === 0 ? (
                    <div className="mt-1 text-[11px] text-muted-foreground">
                      No events yet.
                    </div>
                  ) : (
                    <div className="mt-2 max-h-28 overflow-y-auto space-y-1 pr-1">
                      {activityEvents.slice(0, 6).map((event) => (
                        <div key={event.id} className="flex items-start gap-2 text-[11px]">
                          <span
                            className={cn(
                              "mt-1 h-2 w-2 rounded-full flex-shrink-0",
                              event.kind === "win"
                                ? "bg-status-finished"
                                : event.kind === "lose"
                                ? "bg-status-error"
                                : event.kind === "move"
                                ? "bg-status-running"
                                : "bg-muted-foreground"
                            )}
                            aria-hidden="true"
                          />
                          <div className="min-w-0 break-words">{event.message}</div>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              ) : (
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  className="h-7 px-2 text-xs text-muted-foreground justify-start"
                  onClick={() => setActivityVisible(true)}
                >
                  Show activity
                </Button>
              )}
	          </Card>
            </div>

	            <ResizeHandle
	              axis="x"
	              onDelta={resizeLeaderboardWidth}
	              onDoubleClick={() => setLayout(defaultLayout)}
	              className="hidden sm:block w-2 flex-shrink-0 order-3 sm:order-none"
	            />
          </>
        )}

	        <div className="min-w-0 flex-1 order-1 sm:order-none">
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
	                    <div className="flex items-center gap-2 min-w-0">
	                      {selectedRun ? (
	                        <span
	                          className="h-2.5 w-2.5 rounded-full flex-shrink-0"
	                          style={{ backgroundColor: getRunColor(selectedRun.id) }}
	                          aria-hidden="true"
	                        />
	                      ) : null}
	                      <div className="text-sm font-medium truncate">
	                        {selectedRun ? runDisplayName(selectedRun) : "Select a run"}
	                      </div>
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
	                        {selectedRun && (
	                          <span className="inline-flex items-center gap-1">
	                            <Footprints className="h-3.5 w-3.5" />
	                            Hops:{" "}
	                            <span className="font-medium">
	                              {replayEnabled
	                                ? selectedReplayStepIndex
	                                : runHops(selectedRun)}{" "}
	                              / {runMaxSteps(selectedRun)}
	                            </span>
	                          </span>
	                        )}
	                        {selectedHumanTimerRunning && (
	                          <StatusChip status="active">
	                            Active player • {formatTime(selectedRunElapsedSeconds)}
	                          </StatusChip>
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
	                            <TabsTrigger
	                              value="article"
	                              className="text-xs px-2"
	                            >
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
                        <Button
                          variant="default"
                          size="sm"
                          onClick={startSelectedTurn}
                        >
                          Start turn
                        </Button>
                      ))}

	                    {selectedRun &&
	                      selectedRun.status === "running" &&
	                      canControlSelectedRun &&
	                      driverValue?.abandonRun && (
	                      <Button variant="destructive" size="sm" onClick={abandonSelected}>
	                        Give up
	                      </Button>
	                    )}

	                    {selectedRun && session.mode === "multiplayer" && (
	                      <Button
	                        variant="outline"
	                        size="sm"
	                        className="gap-2"
	                        onClick={hideSelected}
	                      >
	                        <Trash2 className="h-4 w-4" />
	                        Hide
	                      </Button>
	                    )}

	                    {selectedRun && driverValue?.deleteRuns && !isMultiplayerMobile && (
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

	            {arenaViewMode === "article" && !selectedRunFinished && (
	              <>
	                	    <div
	                  className="min-h-0 overflow-hidden"
	                  style={{ height: effectiveWikiHeight }}
	                >
	                  <div className="h-full overflow-hidden">
	                    <div
	                      className={cn(
	                        "grid grid-cols-1 gap-4 h-full min-h-0",
	                        selectedRun?.kind === "human" &&
                              !disableLinksView &&
                              humanPaneMode === "split"
	                          ? "xl:grid-cols-[var(--links-pane-width)_auto_1fr] xl:gap-0"
	                          : "xl:grid-cols-12"
	                      )}
	                      style={
	                        selectedRun?.kind === "human" &&
                              !disableLinksView &&
                              humanPaneMode === "split"
	                          ? ({
	                              "--links-pane-width": `${layout.linksPaneWidth}px`,
	                            } as ArenaCssVars)
	                          : undefined
	                      }
	                    >
	                  {selectedRun?.kind === "human" &&
                          !disableLinksView &&
                          humanPaneMode !== "wiki" && (
	                    <Card
	                      className={cn(
	                        "p-3 h-full flex flex-col min-h-0",
	                        humanPaneMode === "links" ? "xl:col-span-12" : null
	                      )}
	                    >
                      <div className="flex items-center justify-between">
                        <div className="text-sm font-medium">Available links</div>
                        <div className="flex items-center gap-2">
                          {!disableLinksView && humanPaneMode === "links" && (
                            isMobile ? (
                              <Button
                                variant="outline"
                                size="sm"
                                className="h-8 text-xs"
                                onClick={() => setHumanPaneMode("wiki")}
                              >
                                Back to Wikipedia
                              </Button>
                            ) : (
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
                            )
                          )}
                        </div>
                      </div>
                      <Separator className="my-3" />

                      <div className="flex items-center gap-2 text-xs text-muted-foreground">
                        {!linksReady ? (
                          <span>Loading…</span>
                        ) : linkQuery.trim().length > 0 ? (
                          <span>
                            {filteredLinks.length} match
                            {filteredLinks.length === 1 ? "" : "es"} of {availableLinks.length}
                          </span>
                        ) : (
                          <span>
                            {availableLinks.length} link{availableLinks.length === 1 ? "" : "s"}
                          </span>
                        )}
                      </div>
	                      {isMobile && !linksSearchOpen && linkQuery.trim().length === 0 ? (
	                        <Button
	                          variant="outline"
	                          size="sm"
	                          className="h-9 w-full justify-start text-muted-foreground"
	                          onClick={() => setLinksSearchOpen(true)}
	                          disabled={
	                            replayEnabled || !canControlSelectedRun || !linksReady
	                          }
	                        >
	                          Search links…
	                        </Button>
	                      ) : (
	                        <div className="flex items-center gap-2">
	                          <Input
	                            value={linkQuery}
	                            onChange={(e) => {
	                              setLinkQuery(e.target.value);
	                              setLinkActiveIndex(0);
	                            }}
	                            onKeyDown={(e) => {
	                              if (replayEnabled) return;
	                              if (!canControlSelectedRun) return;
	                              if (e.key === "ArrowDown") {
	                                e.preventDefault();
	                                setLinkActiveIndex((prev) =>
	                                  clampNumber(
	                                    prev + 1,
	                                    0,
	                                    Math.max(0, visibleLinks.length - 1)
	                                  )
	                                );
	                                return;
	                              }
	                              if (e.key === "ArrowUp") {
	                                e.preventDefault();
	                                setLinkActiveIndex((prev) =>
	                                  clampNumber(
	                                    prev - 1,
	                                    0,
	                                    Math.max(0, visibleLinks.length - 1)
	                                  )
	                                );
	                                return;
	                              }
	                              if (e.key !== "Enter") return;
	                              const q = linkQuery.trim().toLowerCase();
	                              const activeLink = visibleLinks[linkActiveIndex];
	                              if (activeLink) {
	                                void moveSelectedRun(activeLink);
	                                setLinkQuery("");
	                                return;
	                              }
	                              if (q.length === 0) return;

	                              const exact = filteredLinks.find(
	                                (link) => link.toLowerCase() === q
	                              );
	                              if (exact) {
	                                void moveSelectedRun(exact);
	                                setLinkQuery("");
	                                return;
	                              }

	                              if (filteredLinks.length === 1) {
	                                void moveSelectedRun(filteredLinks[0]);
	                                setLinkQuery("");
	                              }
	                            }}
	                            placeholder="Search links…"
	                            className="h-9"
	                            disabled={
	                              replayEnabled || !canControlSelectedRun || !linksReady
	                            }
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
	                      )}

                      {selectedRun.status !== "running" ? (
                        <div className="mt-3 text-sm text-muted-foreground">Run finished.</div>
	                      ) : !linksReady ? (
                        <div className="mt-3 text-sm text-muted-foreground">Loading links…</div>
                      ) : linksError ? (
                        <div className="mt-3 rounded-md border border-status-error/30 bg-status-error/10 p-3">
                          <StatusChip status="error">Couldn’t load links</StatusChip>
                          <div className="mt-2 text-sm text-muted-foreground break-words">
                            {linksError}
                          </div>
                        </div>
                      ) : availableLinks.length === 0 ? (
                        <div className="mt-3 text-sm text-muted-foreground">
                          No links found for{" "}
                          <span className="font-medium">{linksArticle}</span>.
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
                                onClick={() => void moveSelectedRun(link)}
                                disabled={replayEnabled || !canControlSelectedRun}
                              >
                                {link}
                              </Button>
                            ))}
	                          </div>
	                        </div>
	                      )}
	                    </Card>
	                  )}

	                  {selectedRun?.kind === "human" &&
                        !disableLinksView &&
                        humanPaneMode === "split" && (
	                    <ResizeHandle
	                      axis="x"
	                      onDelta={resizeLinksPaneWidth}
	                      onDoubleClick={() =>
	                        setLayout((prev) => ({
	                          ...prev,
	                          linksPaneWidth: defaultLayout.linksPaneWidth,
	                        }))
	                      }
	                      className="hidden xl:block w-2 mx-2"
	                    />
	                  )}
	
	                  {selectedRun?.kind !== "human" ||
                        disableLinksView ||
                        humanPaneMode !== "links" ? (
	                    <Card
	                      className={cn(
	                        "p-3 overflow-hidden h-full flex flex-col min-h-0",
	                        selectedRun?.kind === "human" &&
                              !disableLinksView &&
                              humanPaneMode === "split"
	                          ? "order-first xl:order-none min-w-0"
	                          : "xl:col-span-12"
	                      )}
	                    >
                    <div className="space-y-1">
                      <div className="flex items-center justify-between">
                        <div className="text-sm font-medium">Wikipedia view</div>
                        <div className="flex items-center gap-2 min-w-0">
                          {selectedRun?.kind === "human" &&
                            !disableLinksView &&
                            (isMobile ? (
                              <Button
                                variant="default"
                                size="sm"
                                className="h-8 text-xs"
                                onClick={() => setHumanPaneMode("links")}
                              >
                                Links
                              </Button>
                            ) : (
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
                            ))}
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
                            {wikiArticle}
                          </div>
                        </div>
                      </div>
	                      {selectedRun?.kind === "human" && (
	                        <div className="text-xs text-muted-foreground">
	                          {replayEnabled
	                            ? "Replay mode: exit replay to make moves."
	                            : selectedRun.status === "running"
	                              ? "Tip: click links in the page to move (or use the searchable list)."
	                              : "Explore mode: click links to browse (won't affect hops)."}
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
                          postWikiReplayMode(lockWikiNavigation);
                          postWikiIncludeImageLinks(includeImageLinks);
                        }}
                      />
                    </div>
                  </Card>
	                  ) : wikiSrc ? (
                    <iframe
                      key={wikiSrc}
                      ref={wikiIframeRef}
                      src={wikiSrc}
                      className="pointer-events-none absolute left-[-99999px] top-0 h-px w-px opacity-0"
                      onLoad={() => {
                        setWikiLoading(false);
                        postWikiReplayMode(lockWikiNavigation);
                        postWikiIncludeImageLinks(includeImageLinks);
                      }}
                    />
                  ) : null}
	                    </div>
	                  </div>
	                </div>

	                <ResizeHandle
	                  axis="y"
	                  onDelta={resizeWikiVsRunDetails}
	                  onDoubleClick={() => setLayout(defaultLayout)}
	                  className="hidden sm:block h-2"
	                />
	                <div className="h-2 sm:hidden" aria-hidden="true" />
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
	                      <div className="flex items-center gap-2">
	                        <Badge variant="outline" className="text-[11px]">
	                          {selectedRun.kind}
	                        </Badge>
	                        {selectedRun.kind === "llm" &&
	                        !isMultiplayerMobile &&
	                        driverValue?.cancelRun &&
	                        driverValue.capabilities.canCancelRun(selectedRun.id) &&
	                        selectedRun.status === "running" ? (
	                          <Button
	                            variant="outline"
	                            size="sm"
	                            onClick={() => void driverValue.cancelRun?.(selectedRun.id)}
	                          >
	                            Cancel
	                          </Button>
	                        ) : null}
	                        {selectedRun.kind === "llm" &&
	                        !isMultiplayerMobile &&
	                        driverValue?.restartRun &&
	                        driverValue.capabilities.canRestartRun(selectedRun.id) ? (
	                          <Button
	                            variant="outline"
	                            size="sm"
	                            onClick={() => void driverValue.restartRun?.(selectedRun.id)}
	                          >
	                            Restart
	                          </Button>
	                        ) : null}
	                      </div>
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
	                            <div className="text-xs text-muted-foreground">Model settings</div>
	                            <div className="mt-0.5 text-xs text-muted-foreground">
	                              api_base: {selectedRun.api_base || "(default)"}
	                              {" • "}
	                              openai_api_mode: {selectedRun.openai_api_mode || "(default)"}
	                              {" • "}
	                              openai_reasoning_effort:{" "}
	                              {selectedRun.openai_reasoning_effort || "(default)"}
	                              {" • "}
	                              anthropic_thinking_budget_tokens:{" "}
	                              {typeof selectedRun.anthropic_thinking_budget_tokens === "number"
	                                ? selectedRun.anthropic_thinking_budget_tokens
	                                : "(default)"}
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
	                      {directLinkMiss && (
	                        <div className="rounded-md border border-status-active/30 bg-status-active/10 p-3">
	                          <div className="flex items-start justify-between gap-3">
	                            <div className="min-w-0">
	                              <StatusChip status="active">You could have won</StatusChip>
	                              <div className="mt-2 text-xs text-muted-foreground">
	                                Hop {directLinkMiss.hopIndex}: on{" "}
	                                <span className="font-medium">{directLinkMiss.fromArticle}</span>
	                                , there was a direct link to{" "}
	                                <span className="font-medium">{session.destination_article}</span>.
	                              </div>
	                            </div>
	                            <Button
	                              variant="outline"
	                              size="sm"
	                              className="h-8 text-xs shrink-0"
	                              onClick={() => {
	                                setMapPreviewArticle(null);
	                                setReplayEnabled(true);
	                                setReplayPlaying(false);
	                                setReplayHop(directLinkMiss.hopIndex);
	                              }}
	                            >
	                              Jump to hop
	                            </Button>
	                          </div>
	                        </div>
	                      )}
	                      <div className="flex items-center justify-between gap-2">
	                        <div className="text-xs text-muted-foreground">Path</div>
	                        <div className="flex items-center gap-2">
                          <Button
                            variant={replayEnabled ? "secondary" : "outline"}
                            size="sm"
                            className="h-7 text-xs"
                            onClick={() => {
                              if (replayEnabled) {
                                setMapPreviewArticle(null);
                                setReplayEnabled(false);
                                setReplayPlaying(false);
                                return;
                              }
                              setMapPreviewArticle(null);
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
                                setMapPreviewArticle(null);
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
                                setMapPreviewArticle(null);
                                setReplayPlaying(false);
                                setReplayHop(Number.parseInt(e.target.value, 10));
                              }}
                              className="flex-1"
                              style={
                                selectedRunColor
                                  ? ({ accentColor: selectedRunColor } as CSSProperties)
                                  : undefined
                              }
                              aria-label="Replay hop"
                            />

                            <Button
                              variant="outline"
                              size="sm"
                              className="h-7 px-2"
                              onClick={() => {
                                setMapPreviewArticle(null);
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
                                setMapPreviewArticle(null);
                                setReplayEnabled(true);
                                setReplayPlaying(false);
                                setReplayHop(idx);
                              }}
                              aria-current={isActive ? "step" : undefined}
                              style={
                                isActive && selectedRunColor
                                  ? ({ "--tw-ring-color": selectedRunColor } as CSSProperties)
                                  : undefined
                              }
                              className={cn(
                                "text-xs rounded border px-2 py-0.5 transition-colors",
                                isFuture && "opacity-40",
                                isActive && "ring-2 ring-offset-1",
                                s.type === "start" && "border-border bg-muted/40",
                                s.type === "win" &&
                                  "border-status-finished/30 bg-status-finished/10 text-foreground",
                                s.type === "lose" &&
                                  "border-status-error/30 bg-status-error/10 text-foreground",
                                s.type === "move" && "border-border bg-background"
                              )}
                            >
                              {s.article}
                            </button>
                          );
                        })}
                      </div>

                      {selectedRun.steps.length > 1 && (
                        <div className="rounded-md border bg-muted/10 p-2">
                          <div className="flex items-center justify-between gap-2">
                            <div className="text-xs font-medium text-muted-foreground">
                              Timeline
                            </div>
                            <div className="text-xs text-muted-foreground tabular-nums">
                              {Math.max(0, selectedRun.steps.length - 1)} hops
                            </div>
                          </div>

                          <div className="mt-2 max-h-40 overflow-y-auto space-y-1 pr-1">
                            {selectedRun.steps.slice(1).map((step, idx) => {
                              const hop = idx + 1;
                              const from =
                                selectedRun.steps[hop - 1]?.article || session.start_article;
                              const isActiveHop = replayEnabled
                                ? hop === selectedReplayStepIndex
                                : hop === selectedRun.steps.length - 1;
                              const badge =
                                step.type === "win" ? (
                                  <StatusChip status="finished">Win</StatusChip>
                                ) : step.type === "lose" ? (
                                  <StatusChip status="error">Lose</StatusChip>
                                ) : null;

                              return (
                                <button
                                  key={`${selectedRun.id}-timeline-${hop}`}
                                  type="button"
                                  onClick={() => {
                                    setMapPreviewArticle(null);
                                    setReplayEnabled(true);
                                    setReplayPlaying(false);
                                    setReplayHop(hop);
                                  }}
                                  aria-current={isActiveHop ? "step" : undefined}
                                  style={
                                    isActiveHop && selectedRunColor
                                      ? ({ "--tw-ring-color": selectedRunColor } as CSSProperties)
                                      : undefined
                                  }
                                  className={cn(
                                    "w-full rounded-md border px-2 py-1 text-left text-[11px] transition-colors",
                                    "bg-background/60 hover:bg-muted/40",
                                    isActiveHop && "bg-background ring-2 ring-offset-1"
                                  )}
                                >
                                  <div className="flex items-start justify-between gap-2">
                                    <div className="min-w-0 flex items-start gap-2">
                                      <span
                                        className="mt-1 h-2 w-2 rounded-full flex-shrink-0"
                                        style={{
                                          backgroundColor: selectedRunColor ?? "#a1a1aa",
                                        }}
                                        aria-hidden="true"
                                      />
                                      <div className="text-muted-foreground tabular-nums w-8 flex-shrink-0">
                                        {hop}
                                      </div>
                                      <div className="min-w-0">
                                        <div className="truncate">
                                          {from} → {step.article}
                                        </div>
                                      </div>
                                    </div>
                                    {badge}
                                  </div>
                                </button>
                              );
                            })}
                          </div>
                        </div>
                      )}
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
		                                const errorMessage = stepError(s);
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
	                                      <div
	                                        className={cn(
	                                          "mt-2 text-xs whitespace-pre-wrap",
	                                          errorMessage
	                                            ? "text-status-error"
	                                            : "text-muted-foreground"
	                                        )}
	                                      >
		                                        {errorMessage
		                                          ? `Error: ${errorMessage}`
		                                          : "No LLM output captured for this step."}
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
	              <>
	                <ResizeHandle
	                  axis="y"
	                  onDelta={resizeRunDetailsVsMap}
	                  onDoubleClick={() => setLayout(defaultLayout)}
	                  className="hidden sm:block h-2"
	                />
	                <div className="h-2 sm:hidden" aria-hidden="true" />
	              </>
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
                        className="flex-1"
                        style={
                          selectedRunColor
                            ? ({ accentColor: selectedRunColor } as CSSProperties)
                            : undefined
                        }
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
                  <Suspense
                    fallback={
                      <div className="w-full h-full flex items-center justify-center text-sm text-muted-foreground">
                        Loading map...
                      </div>
                    }
                  >
                    <ForceDirectedGraph
                      runs={forceGraphRuns}
                      runId={selectedForceGraphRunId}
                      focusColor={selectedRunColor ?? undefined}
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
                      onNodeSelect={handleMapNodeSelect}
                      includeGraphLinks
                    />
                  </Suspense>
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
	                setLayout((prev) => ({ ...prev, mapHeight: defaultLayout.mapHeight }))
	              }
	              className={cn(
	                "hidden sm:block h-2",
	                mapOnTopInResults ? "order-2" : null
	              )}
	            />

              {selectedRunFinished && (
	              <div className="mt-3 min-h-0 order-last" style={{ height: effectiveWikiHeight }}>
                  <Card className="p-3 overflow-hidden h-full flex flex-col min-h-0">
                    <div className="space-y-1">
                      <div className="flex items-center justify-between">
                        <div className="text-sm font-medium">Wikipedia view</div>
                        <div className="flex items-center gap-2 min-w-0">
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
                            {wikiArticle}
                          </div>
                        </div>
                      </div>
                      <div className="text-xs text-muted-foreground">
                        {mapPreviewArticle
                          ? "Map preview."
                          : replayEnabled
                          ? "Replay mode: exit replay to return to the final page."
                          : "Final page from this run."}
                      </div>
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
                          postWikiReplayMode(lockWikiNavigation);
                          postWikiIncludeImageLinks(includeImageLinks);
                        }}
                      />
                    </div>
                  </Card>
                </div>
              )}
          </div>
        </div>
      </div>
      </div>
    </>
  );
}
