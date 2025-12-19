"use client";

import { useEffect, useMemo, useState } from "react";
import { API_BASE } from "@/lib/constants";
import RaceSetup from "@/components/race/race-setup";
import type { RaceConfig } from "@/components/race/race-types";
import MatchupArena from "@/components/matchup-arena";
import {
  createSession,
  getOrCreateSession,
  startHumanRun,
  startLlmRun,
  useSessionsStore,
} from "@/lib/session-store";

export default function PlayTab({
  startArticle,
  destinationArticle,
  onGoToViewerTab,
}: {
  startArticle?: string;
  destinationArticle?: string;
  onGoToViewerTab?: () => void;
}) {
  const [isServerConnected, setIsServerConnected] = useState<boolean>(false);
  const [modelList] = useState<string[]>([
    "gpt-5.1",
    "gpt-5.2",
    "gpt-5-mini",
    "gpt-5-nano",
  ]);
  const [allArticles, setAllArticles] = useState<string[]>([]);
  const [setupCollapsed, setSetupCollapsed] = useState<boolean>(false);
  const [scrollTarget, setScrollTarget] = useState<"setup" | "arena" | null>(null);

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
    const fetchAllArticles = async () => {
      try {
        const response = await fetch(`${API_BASE}/get_all_articles`);
        const data = await response.json();
        if (Array.isArray(data)) setAllArticles(data);
      } catch {
        setAllArticles([]);
      }
    };
    fetchAllArticles();
  }, []);

  const initialStartPage = activeSession?.start_article || startArticle || "Capybara";
  const initialTargetPage = activeSession?.destination_article || destinationArticle || "Pokémon";

  useEffect(() => {
    if (!scrollTarget) return;

    const el = document.getElementById(
      scrollTarget === "arena" ? "matchup-arena" : "play-setup"
    );
    el?.scrollIntoView({ behavior: "smooth", block: "start" });
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
          reasoningEffort: p.reasoningEffort,
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
    </div>
  );
}
