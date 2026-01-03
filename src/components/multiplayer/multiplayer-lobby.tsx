"use client";

import { useMemo, useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { StatusChip } from "@/components/ui/status-chip";
import { Separator } from "@/components/ui/separator";
import { ErrorCallout } from "@/components/ui/callouts";
import AddAiForm from "@/components/race/add-ai-form";
import type { MultiplayerRoomV1 } from "@/lib/multiplayer-types";
import { addLlmParticipant, cancelRun, restartRun, startRoom } from "@/lib/multiplayer-store";
import { llmDisplayNameOverride, llmModelLabel, llmSettingsSubtext } from "@/lib/llm-display";
import { useMediaQuery } from "@/lib/use-media-query";

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

  const isMobile = useMediaQuery("(max-width: 639px)");

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

	  return (
	    <div className="space-y-4">
	      {error && (
	        <ErrorCallout>{error}</ErrorCallout>
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

                <AddAiForm
                  mode="inline"
                  modelList={modelList}
                  defaults={room.rules}
                  existingRuns={room.runs}
                  onAddAi={addLlmParticipant}
                />
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
