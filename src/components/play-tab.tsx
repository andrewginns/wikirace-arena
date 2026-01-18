import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { API_BASE } from "@/lib/constants";
import { prefersReducedMotion } from "@/lib/motion";
import RaceSetup from "@/components/race/race-setup";
import type { RaceConfig } from "@/components/race/race-types";
import MatchupArena from "@/components/matchup-arena";
import MultiplayerPlay from "@/components/multiplayer/multiplayer-play";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { safeLocalStorageGetItem, safeLocalStorageSetItem } from "@/lib/storage";
import {
  createSession,
  getOrCreateSession,
  startHumanRun,
  startLlmRun,
  useSessionsStore,
} from "@/lib/session-store";
import { RECOMMENDED_MODELS } from "@/lib/model-presets";

type PlayMode = "local" | "multiplayer";

const PLAY_MODE_STORAGE_KEY = "wikirace:play-mode:v1";

function loadStoredPlayMode(): PlayMode {
  if (typeof window === "undefined") return "local";
  const params = new URLSearchParams(window.location.search);
  if (params.has("room")) return "multiplayer";
  const stored = safeLocalStorageGetItem(PLAY_MODE_STORAGE_KEY);
  if (stored === "multiplayer") return "multiplayer";
  return "local";
}

export default function PlayTab({
  startArticle,
  destinationArticle,
  onGoToViewerTab,
}: {
  startArticle?: string;
  destinationArticle?: string;
  onGoToViewerTab?: () => void;
}) {
  const [playMode, setPlayMode] = useState<PlayMode>(loadStoredPlayMode);
  const [isServerConnected, setIsServerConnected] = useState<boolean>(false);
  const [modelList] = useState<string[]>(() => [...RECOMMENDED_MODELS]);
  const [allArticles, setAllArticles] = useState<string[]>([]);
  const [setupCollapsed, setSetupCollapsed] = useState<boolean>(false);
  const [scrollTarget, setScrollTarget] = useState<"setup" | "arena" | null>(null);
  const allArticlesFetchAbortRef = useRef<AbortController | null>(null);
  const prevServerConnectedRef = useRef<boolean>(isServerConnected);

  const { sessions, active_session_id } = useSessionsStore();
  const activeSession = active_session_id ? sessions[active_session_id] : null;

  // Server connection check
  useEffect(() => {
    const checkServerConnection = async () => {
      try {
        const response = await fetch(API_BASE + "/health");
        setIsServerConnected(response.ok);
      } catch {
        setIsServerConnected(false);
      }
    };

    // Check immediately and then every 30 seconds
    checkServerConnection();
    const interval = setInterval(checkServerConnection, 30000);

    return () => clearInterval(interval);
  }, []);

  useEffect(() => {
    if (typeof window === "undefined") return;
    safeLocalStorageSetItem(PLAY_MODE_STORAGE_KEY, playMode);
  }, [playMode]);

  const fetchAllArticles = useCallback(async () => {
    allArticlesFetchAbortRef.current?.abort();
    const controller = new AbortController();
    allArticlesFetchAbortRef.current = controller;

    try {
      const response = await fetch(`${API_BASE}/get_all_articles`, {
        signal: controller.signal,
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const data: unknown = await response.json();
      if (controller.signal.aborted) return;
      if (!Array.isArray(data)) throw new Error("Unexpected response");
      setAllArticles(data.filter((item): item is string => typeof item === "string"));
    } catch {
      if (controller.signal.aborted) return;
      setAllArticles([]);
    }
  }, []);

  useEffect(() => {
    fetchAllArticles();

    return () => {
      allArticlesFetchAbortRef.current?.abort();
      allArticlesFetchAbortRef.current = null;
    };
  }, [fetchAllArticles]);

  useEffect(() => {
    const prev = prevServerConnectedRef.current;
    prevServerConnectedRef.current = isServerConnected;

    // The UI can boot before the API server. When the server becomes reachable,
    // retry loading the article list so comboboxes populate without a reload.
    if (prev || !isServerConnected) return;
    if (allArticles.length > 0) return;
    fetchAllArticles();
  }, [allArticles.length, fetchAllArticles, isServerConnected]);

  const initialStartPage = activeSession?.start_article || startArticle || "Capybara";
  const initialTargetPage = activeSession?.destination_article || destinationArticle || "Pokémon";

  useEffect(() => {
    if (!scrollTarget) return;

    const el = document.getElementById(
      scrollTarget === "arena" ? "matchup-arena" : "play-setup"
    );
    el?.scrollIntoView({
      behavior: prefersReducedMotion() ? "auto" : "smooth",
      block: "start",
    });
    setScrollTarget(null);
  }, [scrollTarget]);

  useEffect(() => {
    if (!startArticle || !destinationArticle) return;
    getOrCreateSession({
      startArticle,
      destinationArticle,
    });
  }, [startArticle, destinationArticle]);

  const effectiveArticles = useMemo(() => {
    // Avoid the combobox looking broken on slow / failed API loads.
    if (allArticles.length > 0) return allArticles;
    return [initialStartPage, initialTargetPage];
  }, [allArticles, initialStartPage, initialTargetPage]);

  const launchRaceRuns = (config: RaceConfig) => {
    const session = createSession({
      startArticle: config.startPage,
      destinationArticle: config.targetPage,
      title: config.title,
      rules: {
        max_hops: config.rules.maxHops,
        max_links: config.rules.maxLinks,
        max_tokens: config.rules.maxTokens,
        include_image_links: config.rules.includeImageLinks,
        disable_links_view: config.rules.disableLinksView,
      },
      humanTimer: {
        auto_start_on_first_action: config.humanTimer?.autoStartOnFirstAction ?? true,
      },
    });

    for (const p of config.participants) {
      if (p.kind === "human") {
        startHumanRun({
          sessionId: session.id,
          playerName: p.name || "Human",
          maxSteps: config.rules.maxHops,
        });
      } else {
        const model = p.model || "llm";
        const name = (p.name || "").trim();
        startLlmRun({
          sessionId: session.id,
          model,
          playerName: name.length > 0 && name !== model ? name : undefined,
          apiBase: p.apiBase,
          openaiApiMode: p.openaiApiMode,
          openaiReasoningEffort: p.openaiReasoningEffort,
          openaiReasoningSummary: p.openaiReasoningSummary,
          anthropicThinkingBudgetTokens: p.anthropicThinkingBudgetTokens,
          googleThinkingConfig: p.googleThinkingConfig,
          maxSteps: config.rules.maxHops,
          maxLinks: config.rules.maxLinks,
          maxTokens: config.rules.maxTokens,
        });
      }
    }

    setSetupCollapsed(true);
    setScrollTarget("arena");
  };

  return (
    <div className="space-y-6">
      <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <div className="text-sm font-medium">Play mode</div>
          <div className="text-xs text-muted-foreground">
            Local uses one device; Multiplayer syncs across devices.
          </div>
        </div>
        <Tabs value={playMode} onValueChange={(v) => setPlayMode(v as PlayMode)}>
          <TabsList className="h-9">
            <TabsTrigger value="local" className="text-xs px-3">
              Local
            </TabsTrigger>
            <TabsTrigger value="multiplayer" className="text-xs px-3">
              Multiplayer
            </TabsTrigger>
          </TabsList>
        </Tabs>
      </div>

      {playMode === "multiplayer" ? (
        <MultiplayerPlay
          allArticles={effectiveArticles}
          isServerConnected={isServerConnected}
          modelList={modelList}
          onGoToViewerTab={onGoToViewerTab}
        />
      ) : (
        <>
          <div id="play-setup" className="space-y-6">
            {!setupCollapsed && (
              <RaceSetup
                initialStartPage={initialStartPage}
                initialTargetPage={initialTargetPage}
                allArticles={effectiveArticles}
                modelList={modelList}
                isServerConnected={isServerConnected}
                onStartRace={launchRaceRuns}
              />
            )}
          </div>

          <MatchupArena
            onGoToViewerTab={onGoToViewerTab}
            onNewRace={() => {
              setSetupCollapsed(false);
              setScrollTarget("setup");
            }}
            modelList={modelList}
            isServerConnected={isServerConnected}
          />
        </>
      )}
    </div>
  );
}
