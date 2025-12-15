"use client";

import { useEffect, useMemo, useState } from "react";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Separator } from "@/components/ui/separator";
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
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { VirtualizedCombobox } from "@/components/ui/virtualized-combobox";
import ModelPicker from "@/components/model-picker";
import { cn } from "@/lib/utils";
import { Bot, Plus, Settings2, Shuffle, Trophy, Users } from "lucide-react";
import popularNodes from "../../../results/popular_nodes.json";
import type { RaceConfig, RaceParticipantDraft, RaceRules } from "./race-types";

function makeId(prefix: string) {
  const randomId =
    typeof crypto !== "undefined" && crypto.randomUUID
      ? crypto.randomUUID()
      : `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  return `${prefix}_${randomId}`;
}

type Preset = {
  id: "sprint" | "classic" | "marathon";
  name: string;
  description: string;
  rules: RaceRules;
};

const PRESETS: Preset[] = [
  {
    id: "sprint",
    name: "Sprint",
    description: "Fast rounds. Great for humans.",
    rules: { maxHops: 12, maxLinks: 200, maxTokens: 1500 },
  },
  {
    id: "classic",
    name: "Classic",
    description: "Balanced default.",
    rules: { maxHops: 20, maxLinks: 200, maxTokens: 3000 },
  },
  {
    id: "marathon",
    name: "Marathon",
    description: "More hops + more thinking time.",
    rules: { maxHops: 35, maxLinks: 300, maxTokens: 4500 },
  },
];

export default function RaceSetup({
  initialStartPage,
  initialTargetPage,
  allArticles,
  modelList,
  isAuthenticated,
  isServerConnected,
  onStartRace,
}: {
  initialStartPage?: string;
  initialTargetPage?: string;
  allArticles: string[];
  modelList: string[];
  isAuthenticated: boolean;
  isServerConnected: boolean;
  onStartRace: (config: RaceConfig) => void;
}) {
  const [title, setTitle] = useState<string>("");
  const [startPage, setStartPage] = useState<string>(
    initialStartPage || "Capybara"
  );
  const [targetPage, setTargetPage] = useState<string>(
    initialTargetPage || "Pokémon"
  );
  const [presetId, setPresetId] = useState<Preset["id"]>("classic");
  const preset = useMemo(
    () => PRESETS.find((p) => p.id === presetId) || PRESETS[1],
    [presetId]
  );

  const [rules, setRules] = useState<RaceRules>(preset.rules);
  useEffect(() => {
    setRules(preset.rules);
  }, [presetId]);

  useEffect(() => {
    if (initialStartPage) setStartPage(initialStartPage);
  }, [initialStartPage]);
  useEffect(() => {
    if (initialTargetPage) setTargetPage(initialTargetPage);
  }, [initialTargetPage]);

  const [participants, setParticipants] = useState<RaceParticipantDraft[]>([
    { id: makeId("p"), kind: "human", name: "You" },
    {
      id: makeId("p"),
      kind: "llm",
      name: "gpt-5-mini",
      model: modelList.includes("gpt-5-mini") ? "gpt-5-mini" : modelList[0],
    },
  ]);

  useEffect(() => {
    setParticipants((prev) =>
      prev.map((p) => {
        if (p.kind !== "llm") return p;
        if (p.model && modelList.includes(p.model)) return p;
        return { ...p, model: modelList[0] };
      })
    );
  }, [modelList]);

  const hasLlm = participants.some((p) => p.kind === "llm");
  const pagesValid =
    startPage.trim().length > 0 &&
    targetPage.trim().length > 0 &&
    startPage.trim() !== targetPage.trim();
  const canStart =
    pagesValid && participants.length > 0 && (!hasLlm || isAuthenticated);

  const selectRandomArticle = (setter: (article: string) => void) => {
    if (popularNodes.length > 0) {
      const randomIndex = Math.floor(Math.random() * popularNodes.length);
      setter(popularNodes[randomIndex]);
    }
  };

  const addHuman = () => {
    setParticipants((prev) => [
      ...prev,
      { id: makeId("p"), kind: "human", name: `Player ${prev.length + 1}` },
    ]);
  };

  const addLlm = () => {
    const model = modelList.includes("gpt-5-mini") ? "gpt-5-mini" : modelList[0];
    setParticipants((prev) => [
      ...prev,
      {
        id: makeId("p"),
        kind: "llm",
        name: model || "LLM",
        model,
      },
    ]);
  };

  const updateParticipant = (id: string, patch: Partial<RaceParticipantDraft>) => {
    setParticipants((prev) => prev.map((p) => (p.id === id ? { ...p, ...patch } : p)));
  };

  const removeParticipant = (id: string) => {
    setParticipants((prev) => prev.filter((p) => p.id !== id));
  };

  const startRace = () => {
    const config: RaceConfig = {
      title: title.trim().length > 0 ? title.trim() : undefined,
      startPage,
      targetPage,
      participants: participants.map((p) => ({
        ...p,
        name: p.name.trim().length > 0 ? p.name.trim() : p.kind === "human" ? "Human" : "LLM",
      })),
      rules,
    };
    onStartRace(config);
  };

  return (
    <div className="space-y-6">
      <Card className="p-6">
        <div className="flex flex-col gap-4 md:flex-row md:items-start md:justify-between">
          <div className="space-y-1">
            <div className="flex items-center gap-2">
              <Trophy className="h-5 w-5 text-primary" />
              <h3 className="text-xl font-semibold">Start a race</h3>
            </div>
            <p className="text-sm text-muted-foreground">
              Add multiple humans (hotseat) and/or multiple models, then race from
              one Wikipedia page to another.
            </p>
          </div>

          <div className="flex items-center gap-2">
            <Dialog>
              <DialogTrigger asChild>
                <Button variant="outline" size="sm" className="gap-2">
                  <Settings2 className="h-4 w-4" />
                  Advanced
                </Button>
              </DialogTrigger>
              <DialogContent className="max-w-2xl">
                <DialogHeader>
                  <DialogTitle>Advanced race settings</DialogTitle>
                  <DialogDescription>
                    Keep the main setup simple; tune limits and provider options here.
                  </DialogDescription>
                </DialogHeader>

                <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                  <div className="space-y-2">
                    <Label htmlFor="race-title">Race title (optional)</Label>
                    <Input
                      id="race-title"
                      value={title}
                      onChange={(e) => setTitle(e.target.value)}
                      placeholder="Capybara → Pokémon showdown"
                    />
                  </div>

                  <div className="space-y-2">
                    <Label htmlFor="max-hops">Max hops</Label>
                    <Input
                      id="max-hops"
                      type="number"
                      min={1}
                      max={200}
                      value={rules.maxHops}
                      onChange={(e) =>
                        setRules((r) => ({
                          ...r,
                          maxHops: Number.parseInt(e.target.value || "0"),
                        }))
                      }
                    />
                  </div>

                  <div className="space-y-2">
                    <Label htmlFor="max-links">Max links per page (LLMs)</Label>
                    <Input
                      id="max-links"
                      type="number"
                      min={1}
                      max={1000}
                      value={rules.maxLinks}
                      onChange={(e) =>
                        setRules((r) => ({
                          ...r,
                          maxLinks: Number.parseInt(e.target.value || "0"),
                        }))
                      }
                    />
                  </div>

                  <div className="space-y-2">
                    <Label htmlFor="max-tokens">Max tokens (LLMs)</Label>
                    <Input
                      id="max-tokens"
                      type="number"
                      min={1}
                      max={10000}
                      value={rules.maxTokens}
                      onChange={(e) =>
                        setRules((r) => ({
                          ...r,
                          maxTokens: Number.parseInt(e.target.value || "0"),
                        }))
                      }
                    />
                  </div>
                </div>

                <DialogFooter>
                  <DialogClose asChild>
                    <Button type="button" variant="secondary">
                      Done
                    </Button>
                  </DialogClose>
                </DialogFooter>
              </DialogContent>
            </Dialog>
          </div>
        </div>

        <Separator className="my-6" />

        <div className="grid grid-cols-1 md:grid-cols-12 gap-6">
          <div className="md:col-span-7 space-y-6">
            <div className="space-y-3">
              <div className="flex items-center justify-between">
                <h4 className="text-sm font-medium">Pages</h4>
                <div className="text-xs text-muted-foreground">
                  Tip: use Random to get fun matchups quickly.
                </div>
              </div>

              <div className="grid grid-cols-1 gap-4">
                <div>
                  <Label className="text-sm">Start</Label>
                  <div className="flex items-center mt-2">
                    <VirtualizedCombobox
                      options={allArticles}
                      value={startPage}
                      onValueChange={setStartPage}
                    />
                    <Button
                      variant="outline"
                      size="sm"
                      className="h-9 ml-2 whitespace-nowrap"
                      onClick={() => selectRandomArticle(setStartPage)}
                    >
                      <Shuffle className="h-3.5 w-3.5 mr-1" />
                      Random
                    </Button>
                    <div className="flex-1" />
                  </div>
                </div>

                <div>
                  <Label className="text-sm">Target</Label>
                  <div className="flex items-center mt-2">
                    <VirtualizedCombobox
                      options={allArticles}
                      value={targetPage}
                      onValueChange={setTargetPage}
                    />
                    <Button
                      variant="outline"
                      size="sm"
                      className="h-9 ml-2 whitespace-nowrap"
                      onClick={() => selectRandomArticle(setTargetPage)}
                    >
                      <Shuffle className="h-3.5 w-3.5 mr-1" />
                      Random
                    </Button>
                    <div className="flex-1" />
                  </div>
                </div>
              </div>
            </div>

            <div className="space-y-3">
              <div className="flex items-center justify-between">
                <h4 className="text-sm font-medium">Race preset</h4>
                <div className="text-xs text-muted-foreground">
                  {preset.description}
                </div>
              </div>

              <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
                {PRESETS.map((p) => (
                  <button
                    key={p.id}
                    type="button"
                    onClick={() => setPresetId(p.id)}
                    className={cn(
                      "text-left rounded-lg border p-3 transition-colors",
                      presetId === p.id
                        ? "border-primary/50 bg-primary/5"
                        : "hover:bg-muted/50 border-border"
                    )}
                  >
                    <div className="font-medium">{p.name}</div>
                    <div className="text-xs text-muted-foreground mt-1">
                      {p.rules.maxHops} hops • {p.rules.maxLinks} links •{" "}
                      {p.rules.maxTokens} tokens
                    </div>
                  </button>
                ))}
              </div>
            </div>
          </div>

          <div className="md:col-span-5 space-y-4">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2">
                <Users className="h-4 w-4 text-muted-foreground" />
                <h4 className="text-sm font-medium">Participants</h4>
              </div>
              <div className="flex items-center gap-2">
                <Button size="sm" variant="outline" className="gap-1" onClick={addHuman}>
                  <Plus className="h-4 w-4" />
                  Human
                </Button>
                <Button size="sm" variant="outline" className="gap-1" onClick={addLlm}>
                  <Plus className="h-4 w-4" />
                  Model
                </Button>
              </div>
            </div>

            <div className="space-y-3">
              {participants.map((p) => (
                <div
                  key={p.id}
                  className="rounded-lg border p-3 bg-card flex flex-col gap-3"
                >
                  <div className="flex items-center justify-between gap-3">
                    <div className="flex items-center gap-2">
                      {p.kind === "human" ? (
                        <Users className="h-4 w-4 text-muted-foreground" />
                      ) : (
                        <Bot className="h-4 w-4 text-muted-foreground" />
                      )}
                      <div className="text-sm font-medium">
                        {p.kind === "human" ? "Human" : "Model"}
                      </div>
                    </div>
                    <Button
                      size="sm"
                      variant="ghost"
                      className="h-8 px-2 text-muted-foreground"
                      onClick={() => removeParticipant(p.id)}
                      disabled={participants.length <= 1}
                    >
                      Remove
                    </Button>
                  </div>

                  <div className="grid grid-cols-1 gap-3">
                    <div className="space-y-2">
                      <Label className="text-xs text-muted-foreground">
                        Display name
                      </Label>
                      <Input
                        value={p.name}
                        onChange={(e) => updateParticipant(p.id, { name: e.target.value })}
                        placeholder={p.kind === "human" ? "Player name" : "Model nickname"}
                      />
                    </div>

                    {p.kind === "llm" && (
                      <>
                        <div className="space-y-2">
                          <ModelPicker
                            label="Model"
                            value={p.model}
                            onValueChange={(v) => updateParticipant(p.id, { model: v })}
                            options={modelList}
                            description="Pick from the list or type any LiteLLM model string."
                          />
                        </div>

                        <details className="rounded-md border bg-muted/30 p-3">
                          <summary className="cursor-pointer text-xs font-medium text-muted-foreground">
                            Provider overrides (advanced)
                          </summary>
                          <div className="mt-3 grid grid-cols-1 gap-3">
                            <div className="space-y-2">
                              <Label className="text-xs text-muted-foreground">
                                `api_base` (optional)
                              </Label>
                              <Input
                                value={p.apiBase || ""}
                                onChange={(e) =>
                                  updateParticipant(p.id, {
                                    apiBase: e.target.value || undefined,
                                  })
                                }
                                placeholder="e.g. http://localhost:8000"
                              />
                            </div>
                            <div className="space-y-2">
                              <Label className="text-xs text-muted-foreground">
                                `reasoning_effort` (optional)
                              </Label>
                              <Input
                                value={p.reasoningEffort || ""}
                                onChange={(e) =>
                                  updateParticipant(p.id, {
                                    reasoningEffort: e.target.value || undefined,
                                  })
                                }
                                placeholder="e.g. low / medium / high"
                              />
                            </div>
                          </div>
                        </details>
                      </>
                    )}
                  </div>
                </div>
              ))}
            </div>

            {!isServerConnected && (
              <div className="text-xs text-yellow-900 bg-yellow-50 border border-yellow-200 rounded-md p-3">
                Server connection issue. The game may be unavailable until the API is
                running.
              </div>
            )}

            {!pagesValid && (
              <div className="text-xs text-red-800 bg-red-50 border border-red-200 rounded-md p-3">
                Pick two different pages to race between.
              </div>
            )}

            <div className="pt-2">
              <TooltipProvider>
                <Tooltip>
                  <TooltipTrigger asChild>
                    <div className="w-full">
                      <Button
                        className="w-full"
                        size="lg"
                        onClick={startRace}
                        disabled={!canStart}
                      >
                        Start race
                      </Button>
                    </div>
                  </TooltipTrigger>
                  {!canStart && hasLlm && !isAuthenticated && (
                    <TooltipContent>
                      <p className="max-w-xs">
                        Please sign in with Hugging Face to run LLM participants.
                      </p>
                    </TooltipContent>
                  )}
                </Tooltip>
              </TooltipProvider>
              <div className="mt-2 text-xs text-muted-foreground">
                Humans play “hotseat”: pick an active player, then click links.
              </div>
            </div>
          </div>
        </div>
      </Card>
    </div>
  );
}


