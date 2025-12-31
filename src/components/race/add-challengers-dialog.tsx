"use client";

import type { ReactElement } from "react";
import { useMemo, useState } from "react";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
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
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { StatusChip } from "@/components/ui/status-chip";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Separator } from "@/components/ui/separator";
import { cn } from "@/lib/utils";
import ModelPicker from "@/components/model-picker";
import { AlertTriangle, Bot, Plus, Shuffle, Trash2, User, Users, WifiOff } from "lucide-react";
import type { RaceParticipantDraft } from "./race-types";
import { startHumanRun, startLlmRun, useSessionsStore } from "@/lib/session-store";
import { sessionDisplayName } from "@/lib/session-utils";
import type { RunV1 } from "@/lib/session-types";

function makeId(prefix: string) {
  const randomId =
    typeof crypto !== "undefined" && crypto.randomUUID
      ? crypto.randomUUID()
      : `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  return `${prefix}_${randomId}`;
}

function participantKey(p: RaceParticipantDraft) {
  if (p.kind === "human") {
    const normalized = p.name.trim().toLowerCase();
    return `human:${normalized || "human"}`;
  }
  return `llm:${p.model || ""}:${p.apiBase || ""}:${p.reasoningEffort || ""}`;
}

function normalizedHumanName(name: string) {
  const trimmed = name.trim();
  return trimmed.length > 0 ? trimmed : "Human";
}

function participantDuplicateLabel(p: RaceParticipantDraft) {
  if (p.kind === "human") return normalizedHumanName(p.name);
  const model = p.model || "llm";
  const effort = p.reasoningEffort?.trim();
  const apiBase = p.apiBase?.trim();
  const parts: string[] = [];
  if (effort) parts.push(`effort: ${effort}`);
  if (apiBase) parts.push(`api_base: ${apiBase}`);
  return parts.length > 0 ? `${model} (${parts.join(" • ")})` : model;
}

const DEFAULT_RULES = { max_hops: 20, max_links: null, max_tokens: null };

export default function AddChallengersDialog({
  modelList,
  isServerConnected,
  trigger,
  onRunsStarted,
}: {
  modelList: string[];
  isServerConnected: boolean;
  trigger: ReactElement;
  onRunsStarted?: (runs: RunV1[]) => void;
}) {
  const { sessions, active_session_id } = useSessionsStore();
  const session = active_session_id ? sessions[active_session_id] : null;

  const [open, setOpen] = useState(false);
  const [participants, setParticipants] = useState<RaceParticipantDraft[]>([]);
  const [participantPresetsOpen, setParticipantPresetsOpen] = useState(false);

  const rules = session?.rules || DEFAULT_RULES;

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

  const canStart = Boolean(session) && participants.length > 0 && duplicateSummary === null;
  const disabledReason = useMemo(() => {
    if (!session) return "No active race session.";
    if (!isServerConnected) return "API server not connected.";
    if (participants.length === 0) return "Add at least one challenger.";
    return null;
  }, [isServerConnected, participants.length, session]);

  const addHuman = () => {
    const nextIndex = participants.filter((p) => p.kind === "human").length + 1;
    setParticipants((prev) => [
      ...prev,
      { id: makeId("p"), kind: "human", name: `Player ${nextIndex}` },
    ]);
  };

  const addLlm = () => {
    const model = modelList.includes("gpt-5-mini") ? "gpt-5-mini" : modelList[0] || "llm";
    setParticipants((prev) => [
      ...prev,
      { id: makeId("p"), kind: "llm", name: "", model },
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
    const model = "gpt-5.2";
    const variants: Array<{ label: string; reasoningEffort?: string }> = [
      { label: "none" },
      { label: "low", reasoningEffort: "low" },
      { label: "medium", reasoningEffort: "medium" },
      { label: "high", reasoningEffort: "high" },
      { label: "xhigh", reasoningEffort: "xhigh" },
    ];
    addParticipantDrafts(
      variants.map((variant) => ({
        id: makeId("p"),
        kind: "llm",
        name: `${model} (${variant.label})`,
        model,
        reasoningEffort: variant.reasoningEffort,
      }))
    );
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

  const clearParticipants = () => {
    setParticipants([]);
    setParticipantPresetsOpen(false);
  };

  const startRuns = () => {
    if (!session) return;
    if (participants.length === 0) return;
    if (duplicateSummary) return;

    const startedRuns: RunV1[] = [];

    for (const p of participants) {
      if (p.kind === "human") {
        const run = startHumanRun({
          sessionId: session.id,
          playerName: p.name?.trim() ? p.name.trim() : "Human",
          maxSteps: rules.max_hops,
        });
        startedRuns.push(run);
      } else {
        const model = p.model || "llm";
        const name = (p.name || "").trim();
        const run = startLlmRun({
          sessionId: session.id,
          model,
          playerName: name.length > 0 && name !== model ? name : undefined,
          apiBase: p.apiBase,
          reasoningEffort: p.reasoningEffort,
          maxSteps: rules.max_hops,
          maxLinks: rules.max_links,
          maxTokens: rules.max_tokens,
        });
        startedRuns.push(run);
      }
    }

    onRunsStarted?.(startedRuns);
    setParticipants([]);
    setOpen(false);
  };

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild disabled={!session}>
        {trigger}
      </DialogTrigger>
      <DialogContent className="sm:max-w-3xl max-h-[85vh] flex flex-col">
        <DialogHeader>
          <DialogTitle>Add challengers</DialogTitle>
          <DialogDescription>
            Add humans or models to <span className="font-medium">{session ? sessionDisplayName(session) : "this race"}</span>. Pages and race rules are locked for this session.
          </DialogDescription>
        </DialogHeader>

        <div className="flex-1 min-h-0 overflow-y-auto pr-1 space-y-4">
          <Card className="p-3">
            <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
              <div className="space-y-1">
                <div className="text-xs text-muted-foreground">Matchup</div>
                <div className="text-sm font-medium">
                  {session ? `${session.start_article} → ${session.destination_article}` : "—"}
                </div>
              </div>
	              <div className="flex items-center gap-2">
	                <Badge variant="outline" className="text-[11px]">
	                  {rules.max_hops} hops
	                </Badge>
	                <Badge variant="outline" className="text-[11px]">
	                  {rules.max_links === null
	                    ? "∞ links"
	                    : `${rules.max_links ?? DEFAULT_RULES.max_links} links`}
	                </Badge>
	                <Badge variant="outline" className="text-[11px]">
	                  {rules.max_tokens === null
	                    ? "∞ tokens"
	                    : `${rules.max_tokens ?? DEFAULT_RULES.max_tokens} tokens`}
	                </Badge>
	              </div>
	            </div>
	          </Card>

          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2">
              <Users className="h-4 w-4 text-muted-foreground" />
              <div className="text-sm font-medium">Challengers</div>
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <Button size="sm" variant="outline" className="gap-1" onClick={addHuman}>
                <Plus className="h-4 w-4" />
                Human
              </Button>
              <Button size="sm" variant="outline" className="gap-1" onClick={addLlm}>
                <Plus className="h-4 w-4" />
                Model
              </Button>
              <Popover open={participantPresetsOpen} onOpenChange={setParticipantPresetsOpen}>
                <PopoverTrigger asChild>
                  <Button size="sm" variant="outline">
                    Presets
                  </Button>
                </PopoverTrigger>
                <PopoverContent className="p-1 w-72" align="end">
                  <div className="px-2 py-1.5 text-xs text-muted-foreground">
                    Add multiple challengers at once (additive).
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

          {participants.length === 0 ? (
            <div className="rounded-lg border bg-muted/20 p-4 text-sm text-muted-foreground">
              Add a human or model to start a new run in this race session.
            </div>
          ) : (
            <div className="space-y-3">
              {participants.map((p) => {
                const isDuplicate = duplicateParticipants.duplicateIds.has(p.id);

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
                        <User className="h-4 w-4 text-muted-foreground" />
                      ) : (
                        <Bot className="h-4 w-4 text-muted-foreground" />
                      )}
                      <div className="text-sm font-medium">
                        {p.kind === "human" ? "Human" : "Model"}
                      </div>
                      {isDuplicate && (
                        <StatusChip status="error">Duplicate</StatusChip>
                      )}
                      {p.kind === "llm" && p.reasoningEffort?.trim() && (
                        <Badge variant="outline" className="text-[11px]">
                          effort: {p.reasoningEffort.trim()}
                        </Badge>
                      )}
                    </div>
                    <Button
                      variant="ghost"
                      size="icon"
                      className="text-muted-foreground"
                      aria-label="Remove challenger"
                      onClick={() => removeParticipant(p.id)}
                    >
                      <Trash2 className="h-4 w-4" />
                    </Button>
                  </div>

                  <div className="grid grid-cols-1 gap-3">
                    {p.kind === "human" && (
                      <div className="space-y-2">
                        <Label className="text-xs text-muted-foreground">Display name</Label>
                        <Input
                          value={p.name}
                          onChange={(e) => updateParticipant(p.id, { name: e.target.value })}
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
                                Display name override (optional)
                              </Label>
                              <Input
                                value={p.name}
                                onChange={(e) => updateParticipant(p.id, { name: e.target.value })}
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
                );
              })}
            </div>
          )}

          {!isServerConnected && (
            <div className="flex items-start gap-2 rounded-md border border-status-active/30 bg-status-active/10 p-3 text-xs text-foreground">
              <WifiOff className="mt-0.5 h-4 w-4 shrink-0 text-status-active" aria-hidden="true" />
              <div>
                Server connection issue. LLM runs may be unavailable until the API is running.
              </div>
            </div>
          )}
        </div>

        {duplicateSummary && (
          <div className="rounded-md border border-status-error/30 bg-status-error/10 p-3 text-xs text-foreground flex flex-wrap items-start justify-between gap-2">
            <div className="flex items-start gap-2">
              <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-status-error" aria-hidden="true" />
              <div>Duplicates: {duplicateSummary}</div>
            </div>
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

        <Separator />

        <DialogFooter className={cn("pt-4", participants.length > 0 ? "sm:justify-between" : "")}>
          <DialogClose asChild>
            <Button type="button" variant="secondary">
              Cancel
            </Button>
          </DialogClose>

          <Button
            type="button"
            onClick={startRuns}
            disabled={!canStart || !isServerConnected}
            className={cn("gap-2", participants.length > 0 && "sm:ml-auto")}
          >
            <Shuffle className="h-4 w-4" />
            Start runs
          </Button>
        </DialogFooter>

        {disabledReason && (
          <div className="text-xs text-muted-foreground -mt-2">{disabledReason}</div>
        )}
      </DialogContent>
    </Dialog>
  );
}
