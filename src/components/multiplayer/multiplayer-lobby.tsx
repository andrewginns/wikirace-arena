"use client";

import { useEffect, useMemo, useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { StatusChip } from "@/components/ui/status-chip";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Separator } from "@/components/ui/separator";
import ModelPicker from "@/components/model-picker";
import type { MultiplayerRoomV1 } from "@/lib/multiplayer-types";
import { addLlmParticipant, cancelRun, restartRun, startRoom } from "@/lib/multiplayer-store";
import { llmDisplayNameOverride, llmModelLabel, llmSettingsSubtext } from "@/lib/llm-display";
import { useMediaQuery } from "@/lib/use-media-query";
import { AlertTriangle } from "lucide-react";

function toOptionalPositiveInt(value: string): number | undefined {
  const trimmed = value.trim();
  if (!trimmed) return undefined;
  const parsed = Number(trimmed);
  if (!Number.isFinite(parsed)) return undefined;
  const asInt = Math.floor(parsed);
  return asInt > 0 ? asInt : undefined;
}

export default function MultiplayerLobby({
  room,
  playerId,
  playerName,
  joinUrl,
  wsStatus,
  error,
  onLeave,
  modelList = [],
}: {
  room: MultiplayerRoomV1;
  playerId: string | null;
  playerName: string | null;
  joinUrl: string | null;
  wsStatus: string;
  error: string | null;
  onLeave: () => void;
  modelList?: string[];
}) {
  const [copyStatus, setCopyStatus] = useState<"idle" | "copied" | "failed">(
    "idle"
  );
  const [startLoading, setStartLoading] = useState(false);
  const [addAiLoading, setAddAiLoading] = useState(false);
  const [aiPresetsOpen, setAiPresetsOpen] = useState(false);

  const [aiModel, setAiModel] = useState(() => modelList[0] || "");
  const [aiName, setAiName] = useState("");
  const [aiApiBase, setAiApiBase] = useState("");
  const [aiOpenaiApiMode, setAiOpenaiApiMode] = useState("");
  const [aiOpenaiReasoningEffort, setAiOpenaiReasoningEffort] = useState("");
  const [aiMaxSteps, setAiMaxSteps] = useState("");
  const [aiMaxLinks, setAiMaxLinks] = useState("");
  const [aiMaxTokens, setAiMaxTokens] = useState("");

  const isMobile = useMediaQuery("(max-width: 639px)");

  useEffect(() => {
    if (aiModel.trim().length > 0) return;
    if (modelList.length === 0) return;
    setAiModel(modelList[0] || "");
  }, [aiModel, modelList]);

  const isHost = playerId && playerId === room.owner_player_id;

  const displayRoomCode = room.id.startsWith("room_") ? room.id.slice("room_".length) : room.id;

  const inviteLink = useMemo(() => {
    if (joinUrl) return joinUrl;
    if (typeof window === "undefined") return null;
    return `${window.location.origin}/?room=${room.id}`;
  }, [joinUrl, room.id]);

  const qrUrl = useMemo(() => {
    if (!inviteLink) return null;
    return `https://api.qrserver.com/v1/create-qr-code/?size=240x240&data=${encodeURIComponent(inviteLink)}`;
  }, [inviteLink]);

  const llmRuns = useMemo(() => {
    return room.runs.filter((r) => r.kind === "llm");
  }, [room.runs]);

  const addAiPreset = async (
    drafts: Array<{
      model: string;
      player_name?: string;
      api_base?: string;
      openai_api_mode?: string;
      openai_reasoning_effort?: string;
      openai_reasoning_summary?: string;
      anthropic_thinking_budget_tokens?: number;
      google_thinking_config?: Record<string, unknown>;
    }>
  ) => {
    const keyForDraft = (draft: {
      model: string;
      api_base?: string;
      openai_api_mode?: string;
      openai_reasoning_effort?: string;
      anthropic_thinking_budget_tokens?: number;
    }) => {
      return `llm:${draft.model}:${draft.api_base || ""}:${draft.openai_api_mode || ""}:${draft.openai_reasoning_effort || ""}:${draft.anthropic_thinking_budget_tokens || ""}`;
    };

    const existingKeys = new Set(
      room.runs
        .filter((run) => run.kind === "llm")
        .map((run) =>
          keyForDraft({
            model: run.model || "",
            api_base: run.api_base || undefined,
            openai_api_mode: run.openai_api_mode || undefined,
            openai_reasoning_effort: run.openai_reasoning_effort || undefined,
            anthropic_thinking_budget_tokens: run.anthropic_thinking_budget_tokens,
          })
        )
    );

    setAddAiLoading(true);
    try {
      for (const draft of drafts) {
        const model = draft.model.trim();
        if (!model) continue;

        const key = keyForDraft({
          model,
          api_base: draft.api_base,
          openai_api_mode: draft.openai_api_mode,
          openai_reasoning_effort: draft.openai_reasoning_effort,
          anthropic_thinking_budget_tokens: draft.anthropic_thinking_budget_tokens,
        });
        if (existingKeys.has(key)) continue;

        const result = await addLlmParticipant({
          model,
          player_name: draft.player_name,
          api_base: draft.api_base,
          openai_api_mode: draft.openai_api_mode,
          openai_reasoning_effort: draft.openai_reasoning_effort,
          openai_reasoning_summary: draft.openai_reasoning_summary,
          anthropic_thinking_budget_tokens: draft.anthropic_thinking_budget_tokens,
          google_thinking_config: draft.google_thinking_config,
        });
        if (!result) break;

        existingKeys.add(key);
      }
    } finally {
      setAddAiLoading(false);
    }
  };

  return (
    <div className="space-y-4">
      {error && (
        <div className="flex items-start gap-2 rounded-md border border-status-error/30 bg-status-error/10 p-3 text-sm text-foreground">
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-status-error" aria-hidden="true" />
          <div>{error}</div>
        </div>
      )}

      <Card className="p-4">
        <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
          <div>
            <div className="flex items-center gap-2">
              <div className="text-sm font-medium">Multiplayer lobby</div>
              <Badge variant="outline" className="text-[11px]">
                {wsStatus}
              </Badge>
            </div>
            <div className="mt-1 text-xs text-muted-foreground">
              Room code <span className="font-mono">{displayRoomCode}</span>
              {playerName ? (
                <span>
                  {" "}• You are <span className="font-medium">{playerName}</span>
                </span>
              ) : null}
            </div>
            <div className="mt-2 text-sm">
              <span className="font-medium">{room.start_article}</span> →{" "}
              <span className="font-medium">{room.destination_article}</span>
            </div>
            {room.title ? (
              <div className="mt-1 text-xs text-muted-foreground">{room.title}</div>
            ) : null}
          </div>

          <div className="flex flex-wrap items-center gap-2">
            <Button
              variant="secondary"
              size="sm"
              disabled={!inviteLink}
              onClick={() => {
                if (!inviteLink) return;
                void (async () => {
                  try {
                    await navigator.clipboard.writeText(inviteLink);
                    setCopyStatus("copied");
                    window.setTimeout(() => setCopyStatus("idle"), 1500);
                  } catch {
                    setCopyStatus("failed");
                    window.setTimeout(() => setCopyStatus("idle"), 1500);
                  }
                })();
              }}
            >
              {copyStatus === "copied"
                ? "Copied"
                : copyStatus === "failed"
                  ? "Copy failed"
                  : "Copy invite link"}
            </Button>

            <Button variant="outline" size="sm" onClick={onLeave}>
              Leave
            </Button>
          </div>
        </div>

        <Separator className="my-3" />

        {isMobile && inviteLink ? (
          <div className="rounded-md border bg-muted/10 p-3 text-xs text-muted-foreground break-all">
            Invite: {inviteLink}
          </div>
        ) : null}

        <div className="grid grid-cols-1 gap-4 lg:grid-cols-12">
          <div className="order-last lg:order-none lg:col-span-7">
            <div className="text-sm font-medium">Players</div>
            <div className="mt-2 space-y-2">
              {room.players.map((p) => (
                <div
                  key={p.id}
                  className="flex items-center justify-between rounded-md border bg-background/60 px-3 py-2"
                >
                  <div className="min-w-0">
                    <div className="truncate text-sm font-medium">
                      {p.name}
                      {p.id === room.owner_player_id ? (
                        <span className="ml-2 text-[11px] text-muted-foreground">(host)</span>
                      ) : null}
                    </div>
                    <div className="truncate text-[11px] text-muted-foreground">
                      {p.id}
                    </div>
                  </div>
                  <StatusChip status={p.connected ? "active" : "neutral"}>
                    {p.connected ? "Connected" : "Offline"}
                  </StatusChip>
                </div>
              ))}
            </div>

            <div className="mt-4 text-sm font-medium">AI racers</div>
            <div className="mt-2 space-y-2">
              {llmRuns.length === 0 ? (
                <div className="rounded-md border bg-muted/20 p-3 text-xs text-muted-foreground">
                  No AI racers yet.
                </div>
              ) : (
                llmRuns.map((run) => {
                  const modelLabel = llmModelLabel({
                    model: run.model,
                    openaiReasoningEffort: run.openai_reasoning_effort,
                    anthropicThinkingBudgetTokens: run.anthropic_thinking_budget_tokens,
                  });
                  const customName = llmDisplayNameOverride({
                    playerName: run.player_name,
                    model: run.model,
                  });
                  const title = customName || modelLabel || run.model || "AI";

                  const settingsLine = llmSettingsSubtext({
                    apiBase: run.api_base,
                    openaiApiMode: run.openai_api_mode,
                  });

                  const subtitleParts: string[] = [];
                  if (customName && modelLabel && customName !== modelLabel) {
                    subtitleParts.push(modelLabel);
                  }
                  subtitleParts.push(run.status);
                  const subtitle = subtitleParts.join(" • ");

                  return (
                    <div
                      key={run.id}
                      className="flex items-center justify-between gap-3 rounded-md border bg-background/60 px-3 py-2"
                    >
                      <div className="min-w-0">
                        <div className="truncate text-sm font-medium">{title}</div>
                        <div className="truncate text-[11px] text-muted-foreground">
                          {subtitle}
                        </div>
                        {settingsLine ? (
                          <div className="truncate text-[11px] text-muted-foreground">
                            {settingsLine}
                          </div>
                        ) : null}
                      </div>
                      <div className="flex items-center gap-2">
                        <StatusChip
                          status={
                            run.status === "running"
                              ? "running"
                              : run.status === "finished"
                                ? run.result === "win"
                                  ? "finished"
                                  : run.result === "lose"
                                    ? "error"
                                    : "neutral"
                                : "neutral"
                          }
                        >
                          {run.status === "finished"
                            ? run.result || "finished"
                            : run.status.replaceAll("_", " ")}
                        </StatusChip>

                        {isHost && !isMobile ? (
                          <Button
                            variant="outline"
                            size="sm"
                            onClick={() => {
                              if (run.status === "finished") {
                                void restartRun(run.id);
                                return;
                              }
                              void cancelRun(run.id);
                            }}
                          >
                            {run.status === "finished" ? "Restart" : "Remove"}
                          </Button>
                        ) : null}
                      </div>
                    </div>
                  );
                })
              )}
            </div>

            {isHost && !isMobile ? (
              <div className="mt-4 rounded-md border bg-muted/20 p-3">
                <div className="text-xs font-medium">Add AI</div>
                <div className="mt-1 text-[11px] text-muted-foreground">
                  Server runs AI moves; everyone watches live.
                </div>

                <div className="mt-3 flex flex-wrap items-center gap-2">
                  <div className="text-[11px] text-muted-foreground">Quick add:</div>
                  {modelList.length > 0 ? (
                    <>
                      <Button
                        type="button"
                        variant="outline"
                        size="sm"
                        disabled={addAiLoading}
                        onClick={() => {
                          const model = modelList[0];
                          if (!model) return;
                          setAddAiLoading(true);
                          void (async () => {
                            try {
                              await addLlmParticipant({ model });
                            } finally {
                              setAddAiLoading(false);
                            }
                          })();
                        }}
                      >
                        Add {modelList[0]}
                      </Button>
                    </>
                  ) : null}

                  <Popover open={aiPresetsOpen} onOpenChange={setAiPresetsOpen}>
                    <PopoverTrigger asChild>
                      <Button type="button" variant="outline" size="sm" disabled={addAiLoading}>
                        Presets
                      </Button>
                    </PopoverTrigger>
                    <PopoverContent className="p-1 w-72" align="start">
                      <div className="px-2 py-1.5 text-xs text-muted-foreground">
                        Add multiple AI racers at once (additive).
                      </div>
                      <Button
                        type="button"
                        variant="ghost"
                        className="w-full justify-start"
                        disabled={addAiLoading || modelList.length === 0}
                        onClick={() => {
                          setAiPresetsOpen(false);
                          const models = Array.from(
                            new Set(modelList.map((m) => m.trim()).filter(Boolean))
                          );
                          void addAiPreset(models.map((model) => ({ model })));
                        }}
                      >
                        All preset models
                      </Button>
                      <Button
                        type="button"
                        variant="ghost"
                        className="w-full justify-start"
                        disabled={addAiLoading}
                        onClick={() => {
                          setAiPresetsOpen(false);
                          const model = "openai-responses:gpt-5.2";
                          const variants: Array<{
                            label: string;
                            openai_reasoning_effort?: string;
                          }> = [
                            { label: "default" },
                            { label: "low", openai_reasoning_effort: "low" },
                            { label: "medium", openai_reasoning_effort: "medium" },
                            { label: "high", openai_reasoning_effort: "high" },
                          ];

                          void addAiPreset(
                            variants.map((variant) => ({
                              model,
                              player_name: `${model} (${variant.label})`,
                              openai_reasoning_effort: variant.openai_reasoning_effort,
                            }))
                          );
                        }}
                      >
                        GPT-5.2 reasoning sweep
                      </Button>
                    </PopoverContent>
                  </Popover>
                </div>

                <div className="mt-3 grid grid-cols-1 gap-3 sm:grid-cols-2">
                  <div className="sm:col-span-2">
                    <ModelPicker
                      label="Model"
                      value={aiModel}
                      onValueChange={setAiModel}
                      options={modelList}
                      placeholder="Type any PydanticAI model id"
                    />
                  </div>
                  <div>
                    <Label className="text-xs">Display name (optional)</Label>
                    <Input
                      value={aiName}
                      onChange={(e) => setAiName(e.target.value)}
                      placeholder="e.g. Bot #1"
                      className="mt-1"
                    />
                  </div>
                  <div>
                    <Label className="text-xs">OpenAI reasoning effort (optional)</Label>
                    <Input
                      value={aiOpenaiReasoningEffort}
                      onChange={(e) => setAiOpenaiReasoningEffort(e.target.value)}
                      placeholder="low / medium / high / xhigh"
                      className="mt-1"
                    />
                  </div>
                  <div>
                    <Label className="text-xs">API base override (optional)</Label>
                    <Input
                      value={aiApiBase}
                      onChange={(e) => setAiApiBase(e.target.value)}
                      placeholder="http://localhost:8001/v1"
                      className="mt-1"
                    />
                  </div>
                  <div>
                    <Label className="text-xs">OpenAI API mode (optional)</Label>
                    <Input
                      value={aiOpenaiApiMode}
                      onChange={(e) => setAiOpenaiApiMode(e.target.value)}
                      placeholder="chat / responses"
                      className="mt-1"
                    />
                  </div>
                </div>

                <div className="mt-3 grid grid-cols-1 gap-3 sm:grid-cols-3">
                  <div>
                    <Label className="text-xs">Max steps</Label>
                    <Input
                      value={aiMaxSteps}
                      onChange={(e) => setAiMaxSteps(e.target.value)}
                      inputMode="numeric"
                      placeholder={`Default (${room.rules.max_hops})`}
                      className="mt-1"
                    />
                  </div>
                  <div>
                    <Label className="text-xs">Max links</Label>
                    <Input
                      value={aiMaxLinks}
                      onChange={(e) => setAiMaxLinks(e.target.value)}
                      inputMode="numeric"
                      placeholder={
                        room.rules.max_links === null
                          ? "Default (Unlimited)"
                          : `Default (${room.rules.max_links})`
                      }
                      className="mt-1"
                    />
                  </div>
                  <div>
                    <Label className="text-xs">Max tokens</Label>
                    <Input
                      value={aiMaxTokens}
                      onChange={(e) => setAiMaxTokens(e.target.value)}
                      inputMode="numeric"
                      placeholder={
                        room.rules.max_tokens === null
                          ? "Default (Unlimited)"
                          : `Default (${room.rules.max_tokens})`
                      }
                      className="mt-1"
                    />
                  </div>
                </div>

                <Button
                  size="sm"
                  className="mt-3"
                  disabled={addAiLoading || aiModel.trim().length === 0}
                  onClick={() => {
                    if (aiModel.trim().length === 0) return;
                    setAddAiLoading(true);
                    void (async () => {
                      try {
                        await addLlmParticipant({
                          model: aiModel.trim(),
                          player_name: aiName.trim() || undefined,
                          api_base: aiApiBase.trim() || undefined,
                          openai_api_mode: aiOpenaiApiMode.trim() || undefined,
                          openai_reasoning_effort:
                            aiOpenaiReasoningEffort.trim() || undefined,
                          max_steps: toOptionalPositiveInt(aiMaxSteps),
                          max_links: toOptionalPositiveInt(aiMaxLinks),
                          max_tokens: toOptionalPositiveInt(aiMaxTokens),
                        });
                        setAiName("");
                        setAiApiBase("");
                        setAiOpenaiApiMode("");
                        setAiOpenaiReasoningEffort("");
                        setAiMaxSteps("");
                        setAiMaxLinks("");
                        setAiMaxTokens("");
                      } finally {
                        setAddAiLoading(false);
                      }
                    })();
                  }}
                >
                  {addAiLoading ? "Adding…" : "Add AI"}
                </Button>
              </div>
            ) : null}
          </div>

          {!isMobile && (
            <div className="order-first lg:order-none lg:col-span-5">
              <div className="text-sm font-medium">Start race</div>
              <div className="mt-1 text-xs text-muted-foreground">
                The host starts the race for everyone.
              </div>
              <div className="mt-3 space-y-2">
                <Button
                  className="w-full"
                  disabled={!isHost || startLoading}
                  onClick={() => {
                    if (!isHost) return;
                    setStartLoading(true);
                    void (async () => {
                      try {
                        await startRoom();
                      } finally {
                        setStartLoading(false);
                      }
                    })();
                  }}
                >
                  {!isHost
                    ? "Waiting for host…"
                    : startLoading
                      ? "Starting…"
                      : "Start race"}
                </Button>

                <div className="rounded-md border bg-muted/30 p-3 text-xs text-muted-foreground">
                  Open the invite link on other devices, join the lobby, then press Start.
                </div>

                {qrUrl && inviteLink && (
                  <div className="rounded-md border bg-muted/10 p-3">
                    <div className="text-xs font-medium">Scan to join</div>
                    <div className="mt-2 flex flex-col items-center gap-2 sm:flex-row sm:items-start">
                      <img
                        src={qrUrl}
                        alt="Room invite QR code"
                        className="h-[180px] w-[180px] rounded bg-white p-2"
                      />
                      <div className="text-[11px] text-muted-foreground break-all">
                        {inviteLink}
                      </div>
                    </div>
                    <div className="mt-2 text-[11px] text-muted-foreground">
                      (QR image is fetched from qrserver.com.)
                    </div>
                  </div>
                )}
              </div>
            </div>
          )}
        </div>
      </Card>
    </div>
  );
}
