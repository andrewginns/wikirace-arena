"use client";

import { useEffect, useState } from "react";
import { Card } from "@/components/ui/card";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Button } from "@/components/ui/button";
import GameComponent from "@/components/game-component";
import { API_BASE } from "@/lib/constants";
import { VirtualizedCombobox } from "@/components/ui/virtualized-combobox";
import ModelPicker from "@/components/model-picker";
import { Info, Shuffle } from "lucide-react";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { Separator } from "@/components/ui/separator";
import popularNodes from "../../results/popular_nodes.json";

export default function SoloPlay({
  startArticle,
  destinationArticle,
  isAuthenticated,
  isServerConnected,
  modelList,
  allArticles,
}: {
  startArticle?: string;
  destinationArticle?: string;
  isAuthenticated: boolean;
  isServerConnected: boolean;
  modelList: string[];
  allArticles: string[];
}) {
  const [player, setPlayer] = useState<"me" | "model">("model");
  const [selectedModel, setSelectedModel] = useState<string | undefined>(
    modelList.includes("gpt-5-mini") ? "gpt-5-mini" : modelList[0]
  );
  const [maxHops, setMaxHops] = useState<number>(20);
  const [isGameStarted, setIsGameStarted] = useState<boolean>(false);
  const [startPage, setStartPage] = useState<string>(
    startArticle || "Capybara"
  );
  const [targetPage, setTargetPage] = useState<string>(
    destinationArticle || "Pokémon"
  );
  const [maxTokens, setMaxTokens] = useState<number>(3000);
  const [maxLinks, setMaxLinks] = useState<number>(200);

  useEffect(() => {
    if (startArticle) setStartPage(startArticle);
  }, [startArticle]);

  useEffect(() => {
    if (destinationArticle) setTargetPage(destinationArticle);
  }, [destinationArticle]);

  useEffect(() => {
    if (!selectedModel || selectedModel.trim().length === 0) {
      setSelectedModel(modelList.includes("gpt-5-mini") ? "gpt-5-mini" : modelList[0]);
    }
  }, [modelList, selectedModel]);

  const handleStartGame = () => setIsGameStarted(true);
  const handleResetGame = () => setIsGameStarted(false);
  const handlePlayerChange = (value: string) => setPlayer(value as "me" | "model");

  const selectRandomArticle = (setter: (article: string) => void) => {
    if (popularNodes.length > 0) {
      const randomIndex = Math.floor(Math.random() * popularNodes.length);
      setter(popularNodes[randomIndex]);
    }
  };

  return (
    <div className="space-y-6">
      {!isGameStarted ? (
        <div className="space-y-6">
          <Card className="p-6">
            <div className="flex items-start justify-between gap-4">
              <div>
                <h3 className="text-lg font-semibold">Solo game</h3>
                <p className="text-sm text-muted-foreground">
                  Quick single-player mode (you or one model). For competitions, use{" "}
                  <span className="font-medium">Race</span>.
                </p>
              </div>
            </div>

            <div className="mt-6 space-y-6">
              <div>
                <h4 className="text-sm font-medium mb-3">Player mode</h4>
                <Tabs
                  defaultValue="me"
                  value={player}
                  onValueChange={handlePlayerChange}
                  className="w-full"
                >
                  <TabsList className="grid w-full grid-cols-2">
                    <TabsTrigger value="me">I’ll play</TabsTrigger>
                    <TabsTrigger value="model">AI will play</TabsTrigger>
                  </TabsList>
                </Tabs>
              </div>

              <Separator className="my-4" />

              <div className="grid grid-cols-1 gap-6">
                <div>
                  <h4 className="text-sm font-medium mb-3">Start page</h4>
                  <div className="flex items-center">
                    <VirtualizedCombobox
                      options={allArticles}
                      value={startPage}
                      onValueChange={(value) => setStartPage(value)}
                    />

                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => selectRandomArticle(setStartPage)}
                      className="h-9 ml-2 whitespace-nowrap"
                    >
                      <Shuffle className="h-3.5 w-3.5 mr-1" />
                      Random
                    </Button>
                    <div className="flex-1" />
                  </div>
                </div>

                <div>
                  <h4 className="text-sm font-medium mb-3">Target page</h4>
                  <div className="flex items-center">
                    <VirtualizedCombobox
                      options={allArticles}
                      value={targetPage}
                      onValueChange={(value) => setTargetPage(value)}
                    />

                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => selectRandomArticle(setTargetPage)}
                      className="h-9 ml-2 whitespace-nowrap"
                    >
                      <Shuffle className="h-3.5 w-3.5 mr-1" />
                      Random
                    </Button>
                    <div className="flex-1" />
                  </div>
                </div>
              </div>

              {player === "model" && (
                <>
                  <Separator className="my-4" />
                  <div className="animate-in fade-in slide-in-from-top-5 duration-300">
                    <h4 className="text-sm font-medium mb-3">Model settings</h4>
                    <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
                      <div>
                        <ModelPicker
                          label="Model"
                          value={selectedModel}
                          onValueChange={(v) => setSelectedModel(v)}
                          options={modelList}
                          description="Pick from the list or type any LiteLLM model string."
                        />
                      </div>

                      <div>
                        <Label
                          htmlFor="max-tokens"
                          className="flex items-center gap-1 text-sm mb-2"
                        >
                          Max tokens
                          <TooltipProvider>
                            <Tooltip>
                              <TooltipTrigger>
                                <Info className="h-3.5 w-3.5 text-muted-foreground" />
                              </TooltipTrigger>
                              <TooltipContent>
                                <p className="max-w-xs">
                                  Maximum number of tokens the model can generate per
                                  response.
                                </p>
                              </TooltipContent>
                            </Tooltip>
                          </TooltipProvider>
                        </Label>
                        <Input
                          id="max-tokens"
                          type="number"
                          value={maxTokens}
                          onChange={(e) => setMaxTokens(Number.parseInt(e.target.value))}
                          min={1}
                          max={10000}
                        />
                      </div>

                      <div>
                        <Label
                          htmlFor="max-links"
                          className="flex items-center gap-1 text-sm mb-2"
                        >
                          Max links
                          <TooltipProvider>
                            <Tooltip>
                              <TooltipTrigger>
                                <Info className="h-3.5 w-3.5 text-muted-foreground" />
                              </TooltipTrigger>
                              <TooltipContent>
                                <p className="max-w-xs">
                                  Maximum number of links the model can consider per
                                  page. Small models tend to get stuck if this is too
                                  high.
                                </p>
                              </TooltipContent>
                            </Tooltip>
                          </TooltipProvider>
                        </Label>
                        <Input
                          id="max-links"
                          type="number"
                          value={maxLinks}
                          onChange={(e) => setMaxLinks(Number.parseInt(e.target.value))}
                          min={1}
                          max={1000}
                        />
                      </div>
                    </div>
                  </div>
                </>
              )}
            </div>
          </Card>

          <div className="flex justify-center">
            <TooltipProvider>
              <Tooltip>
                <TooltipTrigger asChild>
                  <div>
                    <Button
                      onClick={handleStartGame}
                      size="lg"
                      className="px-8"
                      variant="default"
                      disabled={player === "model" && (!selectedModel || selectedModel.trim().length === 0)}
                    >
                      Start
                    </Button>
                  </div>
                </TooltipTrigger>
                {player === "model" && (!isAuthenticated || !isServerConnected) && (
                  <TooltipContent>
                    <p className="max-w-xs">
                      If you're using Hugging Face hosted models, sign in. For OpenAI/Anthropic,
                      set server env keys (e.g. `OPENAI_API_KEY`, `ANTHROPIC_API_KEY`).
                    </p>
                  </TooltipContent>
                )}
              </Tooltip>
            </TooltipProvider>
          </div>

          {!isServerConnected && (
            <div className="text-center p-2 bg-yellow-100 text-yellow-800 rounded-md text-sm">
              Server connection issue. Some features may be unavailable.
            </div>
          )}
        </div>
      ) : (
        <GameComponent
          player={player}
          model={player === "model" ? selectedModel : undefined}
          maxHops={maxHops}
          startPage={startPage}
          targetPage={targetPage}
          onReset={handleResetGame}
          maxTokens={maxTokens}
          maxLinks={maxLinks}
          apiBase={API_BASE}
        />
      )}
    </div>
  );
}


