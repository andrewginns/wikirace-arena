"use client";

import { useEffect, useMemo, useState } from "react";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { StatusChip } from "@/components/ui/status-chip";
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
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { VirtualizedCombobox } from "@/components/ui/virtualized-combobox";
import ModelPicker from "@/components/model-picker";
import WikiArticlePreview from "@/components/wiki-article-preview";
import { prefersReducedMotion } from "@/lib/motion";
import { cn } from "@/lib/utils";
import {
  AlertTriangle,
  ArrowLeftRight,
  Bot,
  HelpCircle,
  Plus,
  Settings2,
  Shuffle,
  Trash2,
  Trophy,
  Users,
  WifiOff,
} from "lucide-react";
import popularNodes from "../../../results/popular_nodes.json";
import type { RaceConfig, RaceParticipantDraft, RaceRules } from "./race-types";
import { RaceSetupStickyBar } from "./race-setup-sticky-bar";

function makeId(prefix: string) {
  const randomId =
    typeof crypto !== "undefined" && crypto.randomUUID
      ? crypto.randomUUID()
      : `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  return `${prefix}_${randomId}`;
}

function rulesEqual(a: RaceRules, b: RaceRules) {
  return a.maxHops === b.maxHops && a.maxLinks === b.maxLinks && a.maxTokens === b.maxTokens;
}

function participantKey(p: RaceParticipantDraft) {
  if (p.kind === "human") {
    const normalized = p.name.trim().toLowerCase();
    return `human:${normalized || "human"}`;
  }
  return `llm:${p.model || ""}:${p.apiBase || ""}:${p.openaiApiMode || ""}:${p.openaiReasoningEffort || ""}:${p.anthropicThinkingBudgetTokens || ""}`;
}

function normalizedHumanName(name: string) {
  const trimmed = name.trim();
  return trimmed.length > 0 ? trimmed : "Human";
}

function participantDuplicateLabel(p: RaceParticipantDraft) {
  if (p.kind === "human") return normalizedHumanName(p.name);
  const model = p.model || "llm";
  const openaiEffort = p.openaiReasoningEffort?.trim();
  const apiBase = p.apiBase?.trim();
  const openaiApiMode = p.openaiApiMode?.trim();
  const anthropicBudget =
    typeof p.anthropicThinkingBudgetTokens === "number"
      ? p.anthropicThinkingBudgetTokens
      : null;
  const parts: string[] = [];
  if (openaiEffort) parts.push(`openai_effort: ${openaiEffort}`);
  if (openaiApiMode) parts.push(`openai_api_mode: ${openaiApiMode}`);
  if (anthropicBudget) parts.push(`anthropic_thinking: ${anthropicBudget}`);
  if (apiBase) parts.push(`api_base: ${apiBase}`);
  return parts.length > 0 ? `${model} (${parts.join(" • ")})` : model;
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
    rules: {
      maxHops: 12,
      maxLinks: 200,
      maxTokens: 1500,
      includeImageLinks: false,
      disableLinksView: false,
    },
  },
  {
    id: "classic",
    name: "Classic",
    description: "Balanced default.",
    rules: {
      maxHops: 20,
      maxLinks: null,
      maxTokens: null,
      includeImageLinks: false,
      disableLinksView: false,
    },
  },
  {
    id: "marathon",
    name: "Marathon",
    description: "More hops + more thinking time.",
    rules: {
      maxHops: 35,
      maxLinks: null,
      maxTokens: null,
      includeImageLinks: false,
      disableLinksView: false,
    },
  },
];

export default function RaceSetup({
  initialStartPage,
  initialTargetPage,
  allArticles,
  modelList,
  isServerConnected,
  onStartRace,
}: {
  initialStartPage?: string;
  initialTargetPage?: string;
  allArticles: string[];
  modelList: string[];
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
  const [rules, setRules] = useState<RaceRules>(PRESETS[1].rules);
  const [autoStartOnFirstAction, setAutoStartOnFirstAction] = useState<boolean>(true);
  const matchedPreset = useMemo(
    () => PRESETS.find((p) => rulesEqual(p.rules, rules)) || null,
    [rules]
  );

  useEffect(() => {
    if (initialStartPage) setStartPage(initialStartPage);
  }, [initialStartPage]);
  useEffect(() => {
    if (initialTargetPage) setTargetPage(initialTargetPage);
  }, [initialTargetPage]);

  const preferredModel = "openai-responses:gpt-5-mini";

  const [participants, setParticipants] = useState<RaceParticipantDraft[]>([
    { id: makeId("p"), kind: "human", name: "You" },
    {
      id: makeId("p"),
      kind: "llm",
      name: "",
      model: modelList.includes(preferredModel) ? preferredModel : modelList[0],
    },
  ]);

  const [participantPresetsOpen, setParticipantPresetsOpen] = useState(false);
  const [highlightSection, setHighlightSection] = useState<
    "pages" | "participants" | "start" | null
  >(null);

  useEffect(() => {
    if (!highlightSection) return;
    const timeout = window.setTimeout(() => setHighlightSection(null), 1600);
    return () => window.clearTimeout(timeout);
  }, [highlightSection]);

  useEffect(() => {
    setParticipants((prev) =>
      prev.map((p) => {
        if (p.kind !== "llm") return p;
        if (p.model && modelList.includes(p.model)) return p;
        return { ...p, model: modelList[0] };
      })
    );
  }, [modelList]);

  const pagesValid =
    startPage.trim().length > 0 &&
    targetPage.trim().length > 0 &&
    startPage.trim() !== targetPage.trim();

  const duplicateParticipants = useMemo(() => {
    const counts = new Map<string, number>();
    const firstByKey = new Map<string, RaceParticipantDraft>();

    for (const p of participants) {
      const key = participantKey(p);
      counts.set(key, (counts.get(key) ?? 0) + 1);
      if (!firstByKey.has(key)) firstByKey.set(key, p);
    }

    const duplicateKeys = new Set<string>();
    const duplicateIds = new Set<string>();
    const labels: Array<{ label: string; count: number }> = [];

    for (const [key, count] of counts.entries()) {
      if (count <= 1) continue;
      duplicateKeys.add(key);
      const first = firstByKey.get(key);
      labels.push({
        label: first ? participantDuplicateLabel(first) : key,
        count,
      });
    }

    labels.sort((a, b) => a.label.localeCompare(b.label));

    for (const p of participants) {
      const key = participantKey(p);
      if (duplicateKeys.has(key)) duplicateIds.add(p.id);
    }

    return { duplicateKeys, duplicateIds, labels };
  }, [participants]);

  const duplicateSummary =
    duplicateParticipants.duplicateKeys.size > 0
      ? duplicateParticipants.labels
          .map(({ label, count }) => `${label} (×${count})`)
          .join(", ")
      : null;

  const errors: string[] = [];
  if (!pagesValid) errors.push("Pick two different pages.");
  if (participants.length === 0) errors.push("Add at least one participant.");

  const canStart = pagesValid && participants.length > 0 && duplicateSummary === null;
  const participantsValid = participants.length > 0 && duplicateSummary === null;
  const activeSetupStep: "pages" | "participants" | null = !pagesValid
    ? "pages"
    : !participantsValid
    ? "participants"
    : null;

  const scrollToSetupSection = (section: "pages" | "participants" | "start") => {
    const id =
      section === "pages"
        ? "pages-section"
        : section === "participants"
        ? "participants-section"
        : "start-race-section";
    const el = document.getElementById(id);
    el?.scrollIntoView({
      behavior: prefersReducedMotion() ? "auto" : "smooth",
      block: "start",
    });
    setHighlightSection(section);
  };

  const pickModel = (...candidates: Array<string | undefined>) => {
    for (const candidate of candidates) {
      if (candidate && modelList.includes(candidate)) return candidate;
    }
    return modelList[0] || "llm";
  };

  const applyParticipantPreset = (
    presetId: "you_vs_fast" | "you_vs_two" | "model_showdown" | "hotseat"
  ) => {
    const fastModel = pickModel(
      "openai-responses:gpt-5-mini",
      "openai-responses:gpt-5-nano",
      modelList[0]
    );
    const secondModel = pickModel(
      "openai-responses:gpt-5-nano",
      "openai-responses:gpt-5.2",
      modelList[1],
      modelList[0]
    );
    const bigModel = pickModel(
      "openai-responses:gpt-5.2",
      "openai-responses:gpt-5.1",
      modelList[0]
    );

    if (presetId === "you_vs_fast") {
      setParticipants([
        { id: makeId("p"), kind: "human", name: "You" },
        { id: makeId("p"), kind: "llm", name: "", model: fastModel },
      ]);
      return;
    }

    if (presetId === "you_vs_two") {
      setParticipants([
        { id: makeId("p"), kind: "human", name: "You" },
        { id: makeId("p"), kind: "llm", name: "", model: fastModel },
        { id: makeId("p"), kind: "llm", name: "", model: secondModel },
      ]);
      return;
    }

    if (presetId === "model_showdown") {
      setParticipants([
        { id: makeId("p"), kind: "llm", name: "", model: bigModel },
        { id: makeId("p"), kind: "llm", name: "", model: fastModel },
      ]);
      return;
    }

    if (presetId === "hotseat") {
      setParticipants([
        { id: makeId("p"), kind: "human", name: "You" },
        { id: makeId("p"), kind: "human", name: "Player 2" },
      ]);
    }
  };

  const selectRandomArticle = (setter: (article: string) => void) => {
    if (popularNodes.length > 0) {
      const randomIndex = Math.floor(Math.random() * popularNodes.length);
      setter(popularNodes[randomIndex]);
    }
  };

  const selectRandomMatchup = () => {
    if (popularNodes.length === 0) return;
    const pick = () => popularNodes[Math.floor(Math.random() * popularNodes.length)];

    const start = pick();
    let target = pick();
    let tries = 0;
    while (target === start && tries < 10) {
      target = pick();
      tries += 1;
    }

    setStartPage(start);
    setTargetPage(target);
  };

  const applyRecommendedPlayers = (
    presetId: "you_vs_fast" | "you_vs_two" | "model_showdown" | "hotseat"
  ) => {
    applyParticipantPreset(presetId);
    setHighlightSection("participants");
  };

  const swapPages = () => {
    setStartPage(targetPage);
    setTargetPage(startPage);
  };

  const addHuman = () => {
    setParticipants((prev) => [
      ...prev,
      { id: makeId("p"), kind: "human", name: `Player ${prev.length + 1}` },
    ]);
  };

  const addLlm = () => {
    const model = modelList.includes(preferredModel) ? preferredModel : modelList[0];
    setParticipants((prev) => [
      ...prev,
      {
        id: makeId("p"),
        kind: "llm",
        name: "",
        model,
      },
    ]);
  };

  const addParticipantDrafts = (drafts: RaceParticipantDraft[]) => {
    if (drafts.length === 0) return;
    setParticipants((prev) => {
      const existing = new Set(prev.map(participantKey));
      const next = [...prev];

      for (const draft of drafts) {
        const key = participantKey(draft);
        if (existing.has(key)) continue;
        existing.add(key);
        next.push(draft);
      }

      return next;
    });
  };

  const addAllPresetModels = () => {
    const models = Array.from(new Set(modelList)).filter(Boolean);
    addParticipantDrafts(
      models.map((model) => ({
        id: makeId("p"),
        kind: "llm",
        name: "",
        model,
      }))
    );
  };

  const addGpt52ReasoningSweep = () => {
    const model = "openai-responses:gpt-5.2";
    const variants: Array<{ label: string; openaiReasoningEffort?: string }> = [
      { label: "default" },
      { label: "low", openaiReasoningEffort: "low" },
      { label: "medium", openaiReasoningEffort: "medium" },
      { label: "high", openaiReasoningEffort: "high" },
    ];
    addParticipantDrafts(
      variants.map((variant) => ({
        id: makeId("p"),
        kind: "llm",
        name: `${model} (${variant.label})`,
        model,
        openaiReasoningEffort: variant.openaiReasoningEffort,
      }))
    );
  };

  const clearParticipants = () => {
    setParticipants([]);
    setParticipantPresetsOpen(false);
  };

  const updateParticipant = (id: string, patch: Partial<RaceParticipantDraft>) => {
    setParticipants((prev) => prev.map((p) => (p.id === id ? { ...p, ...patch } : p)));
  };

  const removeParticipant = (id: string) => {
    setParticipants((prev) => prev.filter((p) => p.id !== id));
  };

  const removeDuplicateParticipants = () => {
    setParticipants((prev) => {
      const seen = new Set<string>();
      return prev.filter((p) => {
        const key = participantKey(p);
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      });
    });
  };

  const startRace = () => {
    const config: RaceConfig = {
      title: title.trim().length > 0 ? title.trim() : undefined,
      startPage,
      targetPage,
      participants: participants.map((p) => ({
        ...p,
        name:
          p.name.trim().length > 0
            ? p.name.trim()
            : p.kind === "human"
            ? "Human"
            : p.model || "LLM",
      })),
      rules,
      humanTimer: { autoStartOnFirstAction },
    };
    onStartRace(config);
  };

  return (
    <div className="space-y-6 pb-24 md:pb-0">
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

          <div className="flex flex-wrap items-center justify-end gap-2">
            <Badge variant="outline" className="text-[11px]">
              Limit: {rules.maxHops} hops
            </Badge>
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
                    <div className="flex items-center gap-2">
                      <Label htmlFor="max-hops">Max hops</Label>
                      <TooltipProvider>
                        <Tooltip>
                          <TooltipTrigger asChild>
                            <button
                              type="button"
                              className="inline-flex items-center justify-center rounded-sm text-muted-foreground hover:text-foreground"
                              aria-label="About hops"
                            >
                              <HelpCircle className="h-4 w-4" />
                            </button>
                          </TooltipTrigger>
                          <TooltipContent side="top" align="start">
                            A hop is one link-click between articles. The run ends if the hop limit is reached.
                          </TooltipContent>
                        </Tooltip>
                      </TooltipProvider>
                    </div>
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

                  <details className="md:col-span-2 rounded-lg border bg-muted/20 p-3">
                    <summary className="cursor-pointer text-sm font-medium text-muted-foreground">
                      Race length presets
                      <span className="ml-2 text-xs font-normal text-muted-foreground/80">
                        ({matchedPreset ? matchedPreset.name : "Custom"})
                      </span>
                    </summary>
                    <div className="mt-1 text-xs text-muted-foreground">
                      {matchedPreset ? matchedPreset.description : "Sets hop limits and LLM budgets quickly."}
                    </div>
                    <div className="mt-3 grid grid-cols-1 gap-2 sm:grid-cols-3">
                      {PRESETS.map((p) => (
                        <button
                          key={p.id}
                          type="button"
                          onClick={() =>
                            setRules((r) => ({
                              ...p.rules,
                              includeImageLinks: r.includeImageLinks,
                              disableLinksView: r.disableLinksView,
                            }))
                          }
                          className={cn(
                            "rounded-md border bg-background/60 p-2 text-left transition-colors hover:bg-muted/40",
                            matchedPreset?.id === p.id &&
                              "border-primary/60 bg-primary/10"
                          )}
                        >
                          <div className="text-sm font-medium">{p.name}</div>
                          <div className="mt-1 text-[11px] text-muted-foreground">
                            {p.rules.maxHops} hops
                          </div>
                          <div className="text-[11px] text-muted-foreground/80">
                            LLM: {p.rules.maxLinks ?? "∞"} links • {p.rules.maxTokens ?? "∞"} tokens
                          </div>
                        </button>
                      ))}
                    </div>
                    <div className="mt-2 text-[11px] text-muted-foreground">
                      Fine-tune limits below.
                    </div>
                  </details>

	                  <div className="space-y-2">
	                    <div className="flex items-center gap-2">
	                      <Label htmlFor="max-links">Max links per page (LLMs)</Label>
	                      <TooltipProvider>
	                        <Tooltip>
	                          <TooltipTrigger asChild>
	                            <button
	                              type="button"
	                              className="inline-flex items-center justify-center rounded-sm text-muted-foreground hover:text-foreground"
	                              aria-label="About max links"
	                            >
	                              <HelpCircle className="h-4 w-4" />
	                            </button>
	                          </TooltipTrigger>
	                          <TooltipContent side="top" align="start">
	                            Limits how many outgoing links we show the model per step. Lower can be faster/cheaper.
	                          </TooltipContent>
	                        </Tooltip>
	                      </TooltipProvider>
	                    </div>
	                    <Input
	                      id="max-links"
	                      type="number"
	                      min={1}
	                      max={1000}
	                      placeholder="Unlimited"
	                      value={rules.maxLinks === null ? "" : String(rules.maxLinks)}
	                      onChange={(e) => {
	                        const raw = e.target.value;
	                        const parsed = Number.parseInt(raw, 10);
	                        setRules((r) => ({
	                          ...r,
	                          maxLinks:
	                            raw.trim().length === 0
	                              ? null
	                              : Number.isFinite(parsed) && parsed > 0
	                              ? parsed
	                              : null,
	                        }));
	                      }}
	                    />
	                  </div>

	                  <div className="space-y-2">
	                    <div className="flex items-center gap-2">
	                      <Label htmlFor="max-tokens">Max tokens (LLMs)</Label>
	                      <TooltipProvider>
	                        <Tooltip>
	                          <TooltipTrigger asChild>
	                            <button
	                              type="button"
	                              className="inline-flex items-center justify-center rounded-sm text-muted-foreground hover:text-foreground"
	                              aria-label="About max tokens"
	                            >
	                              <HelpCircle className="h-4 w-4" />
	                            </button>
	                          </TooltipTrigger>
	                          <TooltipContent side="top" align="start">
	                            Caps the model’s token budget. Leave blank for unlimited.
	                          </TooltipContent>
	                        </Tooltip>
	                      </TooltipProvider>
	                    </div>
	                    <Input
	                      id="max-tokens"
	                      type="number"
	                      min={1}
	                      max={10000}
	                      placeholder="Unlimited"
	                      value={rules.maxTokens === null ? "" : String(rules.maxTokens)}
	                      onChange={(e) => {
	                        const raw = e.target.value;
	                        const parsed = Number.parseInt(raw, 10);
	                        setRules((r) => ({
	                          ...r,
	                          maxTokens:
	                            raw.trim().length === 0
	                              ? null
	                              : Number.isFinite(parsed) && parsed > 0
	                              ? parsed
	                              : null,
	                        }));
	                      }}
	                    />
	                  </div>

                  <div className="md:col-span-2 rounded-lg border bg-muted/20 p-3 flex items-start justify-between gap-3">
                    <div className="space-y-0.5">
                      <div className="flex items-center gap-2 text-sm font-medium">
                        Auto-start human timer on first action
                        <TooltipProvider>
                          <Tooltip>
                            <TooltipTrigger asChild>
                              <button
                                type="button"
                                className="inline-flex items-center justify-center rounded-sm text-muted-foreground hover:text-foreground"
                                aria-label="About auto-start timers"
                              >
                                <HelpCircle className="h-4 w-4" />
                              </button>
                            </TooltipTrigger>
                            <TooltipContent side="top" align="start">
                              Starts the active human’s timer when they make their first move (link click / Enter). Turn it off if you want to manually start each turn.
                            </TooltipContent>
                          </Tooltip>
                        </TooltipProvider>
                      </div>
                      <div className="text-xs text-muted-foreground">
                        Enabled by default (recommended for hotseat play).
                      </div>
                    </div>

                    <input
                      type="checkbox"
                      className="mt-1 h-4 w-4"
                      checked={autoStartOnFirstAction}
                      onChange={(e) => setAutoStartOnFirstAction(e.target.checked)}
                      aria-label="Auto-start human timer on first action"
                    />
                  </div>

                  <div className="md:col-span-2 rounded-lg border bg-muted/20 p-3 flex items-start justify-between gap-3">
                    <div className="space-y-0.5">
                      <div className="flex items-center gap-2 text-sm font-medium">
                        Include image-only links
                        <TooltipProvider>
                          <Tooltip>
                            <TooltipTrigger asChild>
                              <button
                                type="button"
                                className="inline-flex items-center justify-center rounded-sm text-muted-foreground hover:text-foreground"
                                aria-label="About image-only links"
                              >
                                <HelpCircle className="h-4 w-4" />
                              </button>
                            </TooltipTrigger>
                            <TooltipContent side="top" align="start">
                              Some pages include links only via small icons/images (e.g. flags).
                              Enable this to show and allow those links.
                            </TooltipContent>
                          </Tooltip>
                        </TooltipProvider>
                      </div>
                      <div className="text-xs text-muted-foreground">
                        Disabled by default so the Links list matches visible text.
                      </div>
                    </div>

                    <input
                      type="checkbox"
                      className="mt-1 h-4 w-4"
                      checked={rules.includeImageLinks}
                      onChange={(e) =>
                        setRules((r) => ({ ...r, includeImageLinks: e.target.checked }))
                      }
                      aria-label="Include image-only links"
                    />
                  </div>

                  <div className="md:col-span-2 rounded-lg border bg-muted/20 p-3 flex items-start justify-between gap-3">
                    <div className="space-y-0.5">
                      <div className="flex items-center gap-2 text-sm font-medium">
                        Disable links view
                      </div>
                      <div className="text-xs text-muted-foreground">
                        Hides the Links/Split panel controls (link clicking in the article still works).
                      </div>
                    </div>

                    <input
                      type="checkbox"
                      className="mt-1 h-4 w-4"
                      checked={rules.disableLinksView}
                      onChange={(e) =>
                        setRules((r) => ({ ...r, disableLinksView: e.target.checked }))
                      }
                      aria-label="Disable links view"
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

	    <Separator className="my-2" />

        <div className="rounded-lg border bg-muted/20 p-3">
          <div className="text-xs font-medium text-muted-foreground">Setup steps</div>
          <div className="mt-2 grid grid-cols-1 gap-2 sm:grid-cols-3">
            <button
              type="button"
              onClick={() => scrollToSetupSection("pages")}
              className={cn(
                "rounded-md border p-3 text-left transition-colors",
                activeSetupStep === "pages"
                  ? "border-primary/60 bg-primary/10"
                  : "hover:bg-muted/40 border-border"
              )}
            >
              <div className="flex items-center gap-2">
                <div
                  className={cn(
                    "h-5 w-5 rounded-full flex items-center justify-center text-[11px] font-semibold",
                    pagesValid
                      ? "bg-primary text-primary-foreground"
                      : "bg-muted text-muted-foreground"
                  )}
                >
                  1
                </div>
                <div className="text-sm font-medium">Choose pages</div>
              </div>
              <div className="mt-1 text-[11px] text-muted-foreground">
                Start → target matchup
              </div>
            </button>

            <button
              type="button"
              onClick={() => scrollToSetupSection("participants")}
              className={cn(
                "rounded-md border p-3 text-left transition-colors",
                activeSetupStep === "participants"
                  ? "border-primary/60 bg-primary/10"
                  : "hover:bg-muted/40 border-border"
              )}
            >
              <div className="flex items-center gap-2">
                <div
                  className={cn(
                    "h-5 w-5 rounded-full flex items-center justify-center text-[11px] font-semibold",
                    participantsValid
                      ? "bg-primary text-primary-foreground"
                      : "bg-muted text-muted-foreground"
                  )}
                >
                  2
                </div>
                <div className="text-sm font-medium">Choose players</div>
              </div>
              <div className="mt-1 text-[11px] text-muted-foreground">
                You, AIs, or hotseat
              </div>
            </button>

            <button
              type="button"
              onClick={() => scrollToSetupSection("start")}
              className="rounded-md border border-border p-3 text-left transition-colors hover:bg-muted/40"
            >
              <div className="flex items-center gap-2">
                <div
                  className={cn(
                    "h-5 w-5 rounded-full flex items-center justify-center text-[11px] font-semibold",
                    canStart
                      ? "bg-primary text-primary-foreground"
                      : "bg-muted text-muted-foreground"
                  )}
                >
                  3
                </div>
                <div className="text-sm font-medium">Start race</div>
              </div>
              <div className="mt-1 text-[11px] text-muted-foreground">
                Begin the arena
              </div>
            </button>
          </div>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-12 gap-6">
          <div className="md:col-span-7 lg:col-span-6 space-y-6">
            <div
              className={cn(
                "space-y-3",
                highlightSection === "pages" &&
                  "rounded-lg ring-2 ring-primary/30 ring-offset-2 ring-offset-background"
              )}
              id="pages-section"
            >
              <div className="flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between">
                <div className="space-y-1">
                  <h4 className="text-sm font-medium">Pages</h4>
                  <div className="text-xs text-muted-foreground">
                    Tip: use Random to get fun matchups quickly.
                  </div>
                </div>
                <div className="flex flex-wrap items-center gap-2">
                  <Button
                    variant="outline"
                    size="sm"
                    className="gap-2"
                    onClick={selectRandomMatchup}
                  >
                    <Shuffle className="h-4 w-4" />
                    Random matchup
                  </Button>
                  <Button variant="outline" size="sm" className="gap-2" onClick={swapPages}>
                    <ArrowLeftRight className="h-4 w-4" />
                    Swap
                  </Button>
                </div>
              </div>

	          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
	            <div>
	              <Label className="text-sm">Start</Label>
	              <div className="mt-2 space-y-2">
	                <VirtualizedCombobox
	                  options={allArticles}
	                  width="100%"
	                  value={startPage}
	                  onValueChange={setStartPage}
	                  wrapValue
	                />
	                <div className="flex items-center justify-between gap-2">
	                  <WikiArticlePreview title={startPage} size={44} />
	                  <Button
	                    variant="outline"
	                    size="sm"
	                    className="h-9 whitespace-nowrap"
	                    onClick={() => selectRandomArticle(setStartPage)}
	                  >
	                    <Shuffle className="h-3.5 w-3.5 mr-1" />
	                    Random
	                  </Button>
	                </div>
	              </div>
	            </div>

	            <div>
	              <Label className="text-sm">Target</Label>
	              <div className="mt-2 space-y-2">
	                <VirtualizedCombobox
	                  options={allArticles}
	                  width="100%"
	                  value={targetPage}
	                  onValueChange={setTargetPage}
	                  wrapValue
	                />
	                <div className="flex items-center justify-between gap-2">
	                  <WikiArticlePreview title={targetPage} size={44} />
	                  <Button
	                    variant="outline"
	                    size="sm"
	                    className="h-9 whitespace-nowrap"
	                    onClick={() => selectRandomArticle(setTargetPage)}
	                  >
	                    <Shuffle className="h-3.5 w-3.5 mr-1" />
	                    Random
	                  </Button>
	                </div>
	              </div>
	            </div>
	          </div>
            </div>

            <div className="rounded-lg border bg-muted/20 p-3">
              <div className="flex items-start justify-between gap-3">
                <div className="space-y-0.5">
                  <div className="text-sm font-medium">Quick start</div>
                  <div className="text-xs text-muted-foreground">
                    Pick a recommended player setup (start/target stay as selected).
                  </div>
                </div>
              </div>

              <div className="mt-3 grid grid-cols-1 gap-2 sm:grid-cols-2">
                <button
                  type="button"
                  className="rounded-md border bg-background/60 p-2 text-left transition-colors hover:bg-muted/40"
                  onClick={() => applyRecommendedPlayers("you_vs_fast")}
                >
                  <div className="text-sm font-medium">You vs AI (fast)</div>
                  <div className="text-[11px] text-muted-foreground">
                    One human + one model
                  </div>
                </button>
                <button
                  type="button"
                  className="rounded-md border bg-background/60 p-2 text-left transition-colors hover:bg-muted/40"
                  onClick={() => applyRecommendedPlayers("you_vs_two")}
                >
                  <div className="text-sm font-medium">You vs 2 AIs</div>
                  <div className="text-[11px] text-muted-foreground">
                    A quick multi-player race
                  </div>
                </button>
                <button
                  type="button"
                  className="rounded-md border bg-background/60 p-2 text-left transition-colors hover:bg-muted/40"
                  onClick={() => applyRecommendedPlayers("model_showdown")}
                >
                  <div className="text-sm font-medium">Model showdown</div>
                  <div className="text-[11px] text-muted-foreground">
                    Two AIs race head-to-head
                  </div>
                </button>
                <button
                  type="button"
                  className="rounded-md border bg-background/60 p-2 text-left transition-colors hover:bg-muted/40"
                  onClick={() => applyRecommendedPlayers("hotseat")}
                >
                  <div className="text-sm font-medium">Hotseat (2 humans)</div>
                  <div className="text-[11px] text-muted-foreground">
                    Take turns on one device
                  </div>
                </button>
              </div>
            </div>
          </div>

	          <div
	            className="md:col-span-5 lg:col-span-6 md:sticky md:top-6 md:self-start"
	            id="participants-section"
	          >
	            <div
	              className={cn(
	                "rounded-xl border bg-muted/10 overflow-hidden md:max-h-[calc(100vh-8rem)] md:flex md:flex-col md:min-h-0",
	                highlightSection === "participants" &&
	                  "ring-2 ring-primary/30 ring-offset-2 ring-offset-background"
	              )}
	            >
	              <div className="flex flex-col gap-3 p-4 sm:flex-row sm:items-start sm:justify-between border-b bg-background/40">
	                <div className="flex items-center gap-2">
	                  <Users className="h-4 w-4 text-muted-foreground" />
	                  <div className="space-y-0.5">
	                    <div className="flex items-center gap-2">
	                      <h4 className="text-sm font-medium">Participants</h4>
	                      <TooltipProvider>
	                        <Tooltip>
	                          <TooltipTrigger asChild>
	                            <button
	                              type="button"
	                              className="inline-flex items-center justify-center rounded-sm text-muted-foreground hover:text-foreground"
	                              aria-label="About hotseat"
	                            >
	                              <HelpCircle className="h-4 w-4" />
	                            </button>
	                          </TooltipTrigger>
	                          <TooltipContent side="top" align="start">
	                            Hotseat means multiple humans share one device. Select the active player, then click links.
	                          </TooltipContent>
	                        </Tooltip>
	                      </TooltipProvider>
	                    </div>
	                    <div className="text-xs text-muted-foreground">
	                      {participants.length} participant
	                      {participants.length === 1 ? "" : "s"} • hotseat supported
	                    </div>
	                  </div>
	                </div>

	                <div className="flex flex-wrap items-center gap-2 sm:justify-end">
	                  <Button size="sm" variant="outline" className="gap-1" onClick={addHuman}>
	                    <Plus className="h-4 w-4" />
	                    Human
	                  </Button>
	                  <Button size="sm" variant="outline" className="gap-1" onClick={addLlm}>
	                    <Plus className="h-4 w-4" />
	                    Model
	                  </Button>
	                  <Popover
	                    open={participantPresetsOpen}
	                    onOpenChange={setParticipantPresetsOpen}
	                  >
	                    <PopoverTrigger asChild>
	                      <Button size="sm" variant="outline">
	                        Presets
	                      </Button>
	                    </PopoverTrigger>
	                    <PopoverContent className="p-1 w-72" align="end">
	                      <div className="px-2 py-1.5 text-xs text-muted-foreground">
	                        Add multiple participants at once (additive).
	                      </div>
	                      <Button
	                        type="button"
	                        variant="ghost"
	                        className="w-full justify-start"
	                        onClick={() => {
	                          addAllPresetModels();
	                          setParticipantPresetsOpen(false);
	                        }}
	                      >
	                        All preset models
	                      </Button>
	                      <Button
	                        type="button"
	                        variant="ghost"
	                        className="w-full justify-start"
	                        onClick={() => {
	                          addGpt52ReasoningSweep();
	                          setParticipantPresetsOpen(false);
	                        }}
	                      >
	                        GPT-5.2 reasoning sweep
	                      </Button>
	                    </PopoverContent>
	                  </Popover>
	                  <Button
	                    size="sm"
	                    variant="outline"
	                    onClick={clearParticipants}
	                    disabled={participants.length === 0}
	                  >
	                    Clear
	                  </Button>
	                </div>
	              </div>

	              <div className="p-4 md:flex-1 md:min-h-0 md:overflow-y-auto md:pr-1">
	                {participants.length === 0 ? (
	                  <div className="rounded-lg border bg-background/60 p-4 text-sm text-muted-foreground">
	                    No participants yet. Add a Human or Model to race.
	                  </div>
	                ) : (
	                  <div className="grid grid-cols-1 lg:grid-cols-2 gap-3">
							{participants.map((p) => {
							  const isDuplicate = duplicateParticipants.duplicateIds.has(p.id);
							  const optionDetails: string[] = [];
							  if (p.kind === "llm") {
							    const effort = p.openaiReasoningEffort?.trim();
							    const apiMode = p.openaiApiMode?.trim();
							    const apiBase = p.apiBase?.trim();
							    const summary = p.openaiReasoningSummary?.trim();
							    const anthropicBudget =
							      typeof p.anthropicThinkingBudgetTokens === "number"
							        ? p.anthropicThinkingBudgetTokens
							        : null;
							    const googleConfig = p.googleThinkingConfig;

							    if (effort) optionDetails.push(`openai_reasoning_effort: ${effort}`);
							    if (apiMode) optionDetails.push(`openai_api_mode: ${apiMode}`);
							    if (summary) optionDetails.push(`openai_reasoning_summary: ${summary}`);
							    if (anthropicBudget) {
							      optionDetails.push(
							        `anthropic_thinking_budget_tokens: ${anthropicBudget}`
							      );
							    }
							    if (apiBase) optionDetails.push(`api_base: ${apiBase}`);
							    if (googleConfig && Object.keys(googleConfig).length > 0) {
							      try {
							        optionDetails.push(
							          `google_thinking_config: ${JSON.stringify(googleConfig)}`
							        );
							      } catch {
							        optionDetails.push("google_thinking_config: (set)");
							      }
							    }
							  }

							  return (
							    <div
	                          key={p.id}
	                          className={cn(
	                            "rounded-lg border p-3 bg-card flex flex-col gap-3",
	                            isDuplicate && "border-status-error/30 bg-status-error/5"
	                          )}
	                        >
	                          <div className="flex items-center justify-between gap-3">
	                            <div className="flex items-center gap-2">
	                              {p.kind === "human" ? (
	                                <Users className="h-4 w-4 text-muted-foreground" />
	                              ) : (
	                                <Bot className="h-4 w-4 text-muted-foreground" />
	                              )}
	                              <div className="flex items-center gap-2">
	                                <div className="text-sm font-medium">
	                                  {p.kind === "human" ? "Human" : "Model"}
	                                </div>
	                                {isDuplicate && (
	                                  <StatusChip status="error">Duplicate</StatusChip>
	                                )}
	                                {p.kind === "llm" && p.openaiReasoningEffort?.trim() && (
	                                  <Badge variant="outline" className="text-[11px]">
	                                    openai_effort: {p.openaiReasoningEffort.trim()}
	                                  </Badge>
	                                )}
	                              </div>
							        </div>
							        <Button
	                              variant="ghost"
	                              size="icon"
	                              className="text-muted-foreground"
	                              aria-label="Remove participant"
	                              onClick={() => removeParticipant(p.id)}
	                              disabled={participants.length <= 1}
	                            >
	                              <Trash2 className="h-4 w-4" />
							        </Button>
							      </div>

							      {p.kind === "llm" && optionDetails.length > 0 && (
							        <TooltipProvider>
							          <Tooltip>
							            <TooltipTrigger asChild>
							              <button
							                type="button"
							                className="inline-flex items-center gap-1 text-[11px] text-muted-foreground underline decoration-dotted underline-offset-2"
							              >
							                <Settings2 className="h-3 w-3" aria-hidden="true" />
							                Options set ({optionDetails.length})
							              </button>
							            </TooltipTrigger>
							            <TooltipContent side="top" align="start" className="max-w-sm">
							              <div className="space-y-1">
							                <div className="text-xs font-medium">Model options</div>
							                <div className="space-y-0.5">
							                  {optionDetails.map((detail, idx) => (
							                    <div key={`${idx}-${detail}`} className="text-xs">
							                      {detail}
							                    </div>
							                  ))}
							                </div>
							              </div>
							            </TooltipContent>
							          </Tooltip>
							        </TooltipProvider>
							      )}

							      <div className="grid grid-cols-1 gap-3">
	                            {p.kind === "human" && (
	                              <div className="space-y-2">
	                                <Label className="text-xs text-muted-foreground">
	                                  Display name
	                                </Label>
	                                <Input
	                                  value={p.name}
	                                  onChange={(e) =>
	                                    updateParticipant(p.id, { name: e.target.value })
	                                  }
	                                  placeholder="Player name"
	                                />
	                              </div>
	                            )}

	                            {p.kind === "llm" && (
	                              <>
	                                <div className="space-y-2">
	                                  <ModelPicker
	                                    label="Model"
	                                    value={p.model}
	                                    onValueChange={(v) =>
	                                      updateParticipant(p.id, { model: v })
	                                    }
	                                    options={modelList}
	                                    description="Pick from the list or type a PydanticAI model id."
	                                  />
	                                </div>

	                                <details className="rounded-md border bg-muted/30 p-3">
	                                  <summary className="cursor-pointer text-xs font-medium text-muted-foreground">
	                                    Provider overrides (advanced)
	                                  </summary>
	                                  <div className="mt-3 grid grid-cols-1 gap-3">
	                                    <div className="space-y-2">
	                                      <Label className="text-xs text-muted-foreground">
	                                        Display name override (optional)
	                                      </Label>
	                                      <Input
	                                        value={p.name}
	                                        onChange={(e) =>
	                                          updateParticipant(p.id, {
	                                            name: e.target.value,
	                                          })
	                                        }
	                                        placeholder="Defaults to model name"
	                                      />
	                                    </div>
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
	                                        `openai_api_mode` (optional)
	                                      </Label>
	                                      <Input
	                                        value={p.openaiApiMode || ""}
	                                        onChange={(e) =>
	                                          updateParticipant(p.id, {
	                                            openaiApiMode: e.target.value || undefined,
	                                          })
	                                        }
	                                        placeholder="chat / responses"
	                                      />
	                                    </div>
	                                    <div className="space-y-2">
	                                      <Label className="text-xs text-muted-foreground">
	                                        `openai_reasoning_effort` (optional)
	                                      </Label>
	                                      <Input
	                                        value={p.openaiReasoningEffort || ""}
	                                        onChange={(e) =>
	                                          updateParticipant(p.id, {
	                                            openaiReasoningEffort: e.target.value || undefined,
	                                          })
	                                        }
	                                        placeholder="low / medium / high / xhigh"
	                                      />
	                                    </div>
	                                    <div className="space-y-2">
	                                      <Label className="text-xs text-muted-foreground">
	                                        `anthropic_thinking_budget_tokens` (optional)
	                                      </Label>
	                                      <Input
	                                        value={
	                                          typeof p.anthropicThinkingBudgetTokens === "number"
	                                            ? String(p.anthropicThinkingBudgetTokens)
	                                            : ""
	                                        }
	                                        onChange={(e) => {
	                                          const raw = e.target.value.trim();
	                                          const parsed = raw.length > 0 ? Number(raw) : NaN;
	                                          updateParticipant(p.id, {
	                                            anthropicThinkingBudgetTokens:
	                                              Number.isFinite(parsed) && parsed > 0
	                                                ? parsed
	                                                : undefined,
	                                          });
	                                        }}
	                                        inputMode="numeric"
	                                        placeholder="e.g. 1024"
	                                      />
	                                    </div>
	                                  </div>
	                                </details>
	                              </>
	                            )}
	                          </div>
	                        </div>
	                      );
	                    })}
	                  </div>
	                )}
	              </div>

	              <div
	                className={cn(
	                  "border-t bg-background/70 backdrop-blur p-4 space-y-3",
	                  highlightSection === "start" &&
	                    "ring-2 ring-primary/30 ring-offset-2 ring-offset-background"
	                )}
	                id="start-race-section"
	              >
	                {!isServerConnected && (
	                  <div className="flex items-start gap-2 rounded-md border border-status-active/30 bg-status-active/10 p-3 text-xs text-foreground">
	                    <WifiOff className="mt-0.5 h-4 w-4 shrink-0 text-status-active" aria-hidden="true" />
	                    <div>
	                      Server connection issue. The game may be unavailable until the API
	                      is running.
	                    </div>
	                  </div>
	                )}

	                {(errors.length > 0 || duplicateSummary) && (
	                  <div className="rounded-md border border-status-error/30 bg-status-error/10 p-3 text-xs text-foreground">
	                    <div className="flex items-start gap-2">
	                      <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-status-error" aria-hidden="true" />
	                      <div className="space-y-1">
	                        {errors.map((err) => (
	                          <div key={err}>{err}</div>
	                        ))}
	                        {duplicateSummary && (
	                          <div className="flex flex-wrap items-center justify-between gap-2">
	                            <div>Duplicates: {duplicateSummary}</div>
	                            <Button
	                              type="button"
	                              variant="outline"
	                              size="sm"
	                              className="h-7"
	                              onClick={removeDuplicateParticipants}
	                            >
	                              Remove duplicates
	                            </Button>
	                          </div>
	                        )}
	                      </div>
	                    </div>
	                  </div>
	                )}

	                <div className="space-y-2">
	                  <Button
	                    className="w-full"
	                    size="lg"
	                    onClick={startRace}
	                    disabled={!canStart}
	                  >
	                    Start race
	                  </Button>
	                  <div className="text-xs text-muted-foreground">
	                    Humans play “hotseat”: select the active player, then click links.
	                  </div>
	                </div>
	              </div>
	            </div>
	          </div>
	        </div>
	      </Card>

	      <RaceSetupStickyBar
	        startPage={startPage}
	        targetPage={targetPage}
	        participantsCount={participants.length}
	        errorMessages={errors}
	        hasDuplicateParticipants={duplicateSummary !== null}
	        isServerConnected={isServerConnected}
	        canStart={canStart}
	        onStartRace={startRace}
	      />

    </div>
  );
}
