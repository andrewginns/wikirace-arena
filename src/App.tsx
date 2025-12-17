import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import ViewerTab from "@/components/viewer-tab";
import PlayTab from "@/components/play-tab";
import AboutTab from "@/components/about-tab";
import LlmRunManager from "@/components/llm-run-manager";
import { Github } from "lucide-react";
import { useState, useEffect } from "react";

export default function Home() {
  const [selectedTab, setSelectedTab] = useState<"view" | "play" | "about">(
    "view"
  );
  const [startArticle, setStartArticle] = useState<string>("");
  const [destinationArticle, setDestinationArticle] = useState<string>("");
  const [isSmallScreen, setIsSmallScreen] = useState<boolean>(false);
  
  useEffect(() => {
    const checkScreenSize = () => {
      setIsSmallScreen(window.innerWidth < 768);
    };
    
    // Check on initial load
    checkScreenSize();
    
    // Add resize listener
    window.addEventListener('resize', checkScreenSize);
    
    // Clean up
    return () => window.removeEventListener('resize', checkScreenSize);
  }, []);

  const handleTryRun = (startArticle: string, destinationArticle: string) => {
    console.log("Trying run from", startArticle, "to", destinationArticle);
    setSelectedTab("play");
    setStartArticle(startArticle);
    setDestinationArticle(destinationArticle);
  };

  return (
    <div className="min-h-screen bg-gradient-to-b from-background to-muted/30">
      <LlmRunManager />
      <div className="container mx-auto p-4 max-w-7xl">
      {isSmallScreen && (
        <div className="bg-yellow-100 border-l-4 border-yellow-500 text-yellow-700 p-4 mb-4 rounded shadow">
          <p className="font-bold">Warning:</p>
          <p>This application doesn't work well on small screens. Please use a desktop for the best experience.</p>
        </div>
      )}
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
        onValueChange={(value) => setSelectedTab(value as "view" | "play" | "about")}
        value={selectedTab}
      >
        <TabsList className="mb-4 mt-6">
          <TabsTrigger value="view">View Runs</TabsTrigger>
          <TabsTrigger value="play">Play Game</TabsTrigger>
          <TabsTrigger value="about">About</TabsTrigger>
        </TabsList>

        <TabsContent value="view">
          <ViewerTab handleTryRun={handleTryRun} />
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
