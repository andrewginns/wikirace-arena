"use client";

import { useEffect, useMemo, useState } from "react";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { API_BASE } from "@/lib/constants";
import RaceSetup from "@/components/race/race-setup";
import RaceView from "@/components/race/race-view";
import type { RaceConfig } from "@/components/race/race-types";
import SoloPlay from "@/components/solo-play";

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
  const [isAuthenticated, setIsAuthenticated] = useState<boolean>(false);
  const [modelList] = useState<string[]>([
    "gpt-5.1",
    "gpt-5.2",
    "gpt-5-mini",
    "gpt-5-nano",
  ]);
  const [allArticles, setAllArticles] = useState<string[]>([]);
  const [mode, setMode] = useState<"race" | "solo">("race");

  const [activeRace, setActiveRace] = useState<RaceConfig | null>(null);

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

  // Authentication check
  useEffect(() => {
    const checkAuthentication = () => {
      const idToken = window.localStorage.getItem("huggingface_id_token");
      const accessToken = window.localStorage.getItem(
        "huggingface_access_token"
      );

      if (idToken && accessToken) {
        try {
          const idTokenObject = JSON.parse(idToken);
          if (idTokenObject.exp > Date.now() / 1000) {
            setIsAuthenticated(true);
            return;
          }
        } catch (error) {
          console.error("Error parsing ID token:", error);
        }
      }
      setIsAuthenticated(false);
    };

    checkAuthentication();
    window.addEventListener("storage", checkAuthentication);

    return () => {
      window.removeEventListener("storage", checkAuthentication);
    };
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

  const initialStartPage = startArticle || "Capybara";
  const initialTargetPage = destinationArticle || "Pokémon";

  const effectiveArticles = useMemo(() => {
    // Avoid the combobox looking broken on slow / failed API loads.
    if (allArticles.length > 0) return allArticles;
    return [initialStartPage, initialTargetPage];
  }, [allArticles, initialStartPage, initialTargetPage]);

  return (
    <div className="space-y-6">
      <Tabs value={mode} onValueChange={(v) => setMode(v as "race" | "solo")}>
        <TabsList className="grid grid-cols-2 w-full max-w-[420px]">
          <TabsTrigger value="race">Race</TabsTrigger>
          <TabsTrigger value="solo">Solo</TabsTrigger>
        </TabsList>

        <TabsContent value="race" className="mt-6">
          {activeRace ? (
            <RaceView
              config={activeRace}
              onBackToSetup={() => setActiveRace(null)}
              onGoToViewerTab={onGoToViewerTab}
            />
          ) : (
            <RaceSetup
              initialStartPage={initialStartPage}
              initialTargetPage={initialTargetPage}
              allArticles={effectiveArticles}
              modelList={modelList}
              isAuthenticated={isAuthenticated}
              isServerConnected={isServerConnected}
              onStartRace={(config) => setActiveRace(config)}
            />
          )}
        </TabsContent>

        <TabsContent value="solo" className="mt-6">
          <SoloPlay
            startArticle={initialStartPage}
            destinationArticle={initialTargetPage}
            isAuthenticated={isAuthenticated}
            isServerConnected={isServerConnected}
            modelList={modelList}
            allArticles={effectiveArticles}
          />
        </TabsContent>
      </Tabs>
    </div>
  );
}
