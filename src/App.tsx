import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import ViewerTab from "@/components/viewer-tab";
import PlayTab from "@/components/play-tab";
import AboutTab from "@/components/about-tab";
import LlmRunManager from "@/components/llm-run-manager";
import { Github } from "lucide-react";
import { useState, useEffect } from "react";

type TabValue = "view" | "play" | "about";

const LAST_TAB_STORAGE_KEY = "wikirace:last-tab:v1";
const SEEN_PLAY_TAB_STORAGE_KEY = "wikirace:seen-play-tab:v1";

function loadStoredTab(): TabValue {
  if (typeof window === "undefined") return "view";
  const stored = window.localStorage.getItem(LAST_TAB_STORAGE_KEY);
  if (stored === "view" || stored === "play" || stored === "about") return stored;
  return "view";
}

function loadHasSeenPlayTab(): boolean {
  if (typeof window === "undefined") return false;
  return window.localStorage.getItem(SEEN_PLAY_TAB_STORAGE_KEY) === "true";
}

export default function Home() {
  const [selectedTab, setSelectedTab] = useState<TabValue>(loadStoredTab);
  const [startArticle, setStartArticle] = useState<string>("");
  const [destinationArticle, setDestinationArticle] = useState<string>("");
  const [hasSeenPlayTab, setHasSeenPlayTab] = useState<boolean>(loadHasSeenPlayTab);

  useEffect(() => {
    if (typeof window === "undefined") return;
    window.localStorage.setItem(LAST_TAB_STORAGE_KEY, selectedTab);

    if (selectedTab === "play") {
      window.localStorage.setItem(SEEN_PLAY_TAB_STORAGE_KEY, "true");
      setHasSeenPlayTab(true);
    }
  }, [selectedTab]);

  const handleTryRun = (startArticle: string, destinationArticle: string) => {
    setSelectedTab("play");
    setStartArticle(startArticle);
    setDestinationArticle(destinationArticle);
  };

  return (
    <div className="min-h-screen bg-gradient-to-b from-background to-muted/30">
      <LlmRunManager />
      <div className="container mx-auto p-4 max-w-7xl">
      <div className="flex flex-col gap-4 md:flex-row md:justify-between md:items-end">
        <div className="space-y-1">
          <h1 className="text-3xl font-bold tracking-tight">WikiRacing Arena</h1>
          <p className="text-sm text-muted-foreground max-w-2xl">
            A fun way for humans and LLMs to compete: race from one Wikipedia page
            to another using only links.
          </p>
        </div>
        <div className="flex items-center gap-4">
          <a 
            href="https://github.com/huggingface/wikirace-llms" 
            target="_blank" 
            rel="noopener noreferrer"
            className="text-gray-700 hover:text-gray-900"
          >
            <Github size={24} />
          </a>
        </div>
      </div>

      <Tabs
        defaultValue="view"
        className="w-full"
        onValueChange={(value) => setSelectedTab(value as TabValue)}
        value={selectedTab}
      >
        <TabsList className="mb-4 mt-6">
          <TabsTrigger value="view">View Runs</TabsTrigger>
          <TabsTrigger value="play">
            Play Game
          </TabsTrigger>
          <TabsTrigger value="about">About</TabsTrigger>
        </TabsList>

        <TabsContent value="view">
          <ViewerTab
            handleTryRun={handleTryRun}
            onGoToPlayTab={() => setSelectedTab("play")}
            showPlayCta={!hasSeenPlayTab}
          />
        </TabsContent>

        <TabsContent value="play">
          <PlayTab
            startArticle={startArticle}
            destinationArticle={destinationArticle}
            onGoToViewerTab={() => setSelectedTab("view")}
          />
        </TabsContent>

        <TabsContent value="about">
          <AboutTab />
        </TabsContent>
      </Tabs>
      </div>
    </div>
  );
}
