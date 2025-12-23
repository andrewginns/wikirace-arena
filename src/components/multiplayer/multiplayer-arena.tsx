"use client";

import { useEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import { API_BASE } from "@/lib/constants";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Separator } from "@/components/ui/separator";
import type { MultiplayerRoomV1, MultiplayerRunV1 } from "@/lib/multiplayer-types";
import { makeMove } from "@/lib/multiplayer-store";

function computeHops(run: MultiplayerRunV1) {
  return Math.max(0, (run.steps?.length ?? 0) - 1);
}

function currentArticleForRun(room: MultiplayerRoomV1, run: MultiplayerRunV1) {
  const steps = run.steps || [];
  const last = steps.length > 0 ? steps[steps.length - 1] : null;
  return last?.article || room.start_article;
}

function titlesMatch(a: string, b: string) {
  return a.replaceAll("_", " ").trim().toLowerCase() === b.replaceAll("_", " ").trim().toLowerCase();
}

function formatTime(seconds: number) {
  const mins = Math.floor(seconds / 60);
  const secs = seconds % 60;
  return `${mins}:${secs < 10 ? "0" : ""}${secs}`;
}

function parseIsoMs(value: string | null | undefined) {
  if (!value) return null;
  const ms = new Date(value).getTime();
  return Number.isFinite(ms) ? ms : null;
}

function runElapsedMs(run: MultiplayerRunV1, nowMs: number) {
  const startedAtMs = parseIsoMs(run.started_at);
  if (!startedAtMs) return 0;

  if (run.status === "finished") {
    const finishedAtMs = parseIsoMs(run.finished_at);
    if (finishedAtMs) return Math.max(0, finishedAtMs - startedAtMs);
    return 0;
  }

  if (run.status === "running") {
    return Math.max(0, nowMs - startedAtMs);
  }

  return 0;
}

export default function MultiplayerArena({
  room,
  playerId,
  playerName,
  joinUrl,
  wsStatus,
  error,
  onLeave,
}: {
  room: MultiplayerRoomV1;
  playerId: string | null;
  playerName: string | null;
  joinUrl: string | null;
  wsStatus: string;
  error: string | null;
  onLeave: () => void;
}) {
  const [quickMoveTitle, setQuickMoveTitle] = useState("");
  const [copyStatus, setCopyStatus] = useState<"idle" | "copied" | "failed">(
    "idle"
  );
  const [nowMs, setNowMs] = useState(() => Date.now());

  useEffect(() => {
    if (room.status !== "running") return;
    const interval = window.setInterval(() => setNowMs(Date.now()), 1000);
    return () => window.clearInterval(interval);
  }, [room.status]);

  const myRun = useMemo(() => {
    if (!playerId) return null;
    return room.runs.find((r) => r.player_id === playerId) || null;
  }, [playerId, room.runs]);

  const myCurrentArticle = myRun ? currentArticleForRun(room, myRun) : room.start_article;
  const myRunning = room.status === "running" && myRun?.status === "running";
  const myFinished = myRun?.status === "finished";
  const myElapsedSeconds = myRun ? Math.floor(runElapsedMs(myRun, nowMs) / 1000) : 0;

  const displayedArticleRef = useRef(myCurrentArticle);
  useEffect(() => {
    displayedArticleRef.current = myCurrentArticle;
  }, [myCurrentArticle]);

  const lastNavigateRef = useRef<{ title: string; at: number } | null>(null);

  useEffect(() => {
    const allowedOrigins = new Set<string>([window.location.origin]);
    try {
      if (API_BASE.startsWith("http")) allowedOrigins.add(new URL(API_BASE).origin);
    } catch {
      // ignore
    }

    const handleMessage = (event: MessageEvent) => {
      if (!allowedOrigins.has(event.origin)) return;
      const data = event.data;
      if (!data || typeof data !== "object") return;
      const msg = data as { type?: unknown; title?: unknown; requestId?: unknown };
      if (msg.type !== "wikirace:navigate_request") return;

      const title = msg.title;
      const requestId = msg.requestId;
      if (typeof requestId !== "string" || requestId.length === 0) return;

      const respond = (allow: boolean) => {
        try {
          (event.source as WindowProxy | null)?.postMessage(
            { type: "wikirace:navigate_response", requestId, allow },
            event.origin
          );
        } catch {
          // ignore
        }
      };

      if (typeof title !== "string" || title.length === 0) {
        respond(false);
        return;
      }

      // Exploration mode: allow navigation without affecting state.
      if (!myRunning) {
        respond(true);
        return;
      }

      const current = displayedArticleRef.current;
      if (current && titlesMatch(title, current)) return;

      const now = Date.now();
      const last = lastNavigateRef.current;
      if (last && last.title === title && now - last.at < 800) {
        respond(true);
        return;
      }
      lastNavigateRef.current = { title, at: now };

      void (async () => {
        const updated = await makeMove(title);
        respond(Boolean(updated));
      })();
    };

    window.addEventListener("message", handleMessage);
    return () => window.removeEventListener("message", handleMessage);
  }, [myRunning]);

  const wikiSrc = useMemo(() => {
    return `${API_BASE}/wiki/${encodeURIComponent(myCurrentArticle.replaceAll(" ", "_"))}`;
  }, [myCurrentArticle]);

  const inviteLink = useMemo(() => {
    if (joinUrl) return joinUrl;
    if (typeof window === "undefined") return null;
    return `${window.location.origin}/?room=${room.id}`;
  }, [joinUrl, room.id]);

  const qrUrl = useMemo(() => {
    if (!inviteLink) return null;
    return `https://api.qrserver.com/v1/create-qr-code/?size=240x240&data=${encodeURIComponent(inviteLink)}`;
  }, [inviteLink]);

  const displayRoomCode = useMemo(() => {
    return room.id.startsWith("room_") ? room.id.slice("room_".length) : room.id;
  }, [room.id]);

  const runsSorted = useMemo(() => {
    const runs = [...room.runs];
    runs.sort((a, b) => {
      const aFinished = a.status === "finished";
      const bFinished = b.status === "finished";
      if (aFinished !== bFinished) return aFinished ? -1 : 1;
      const aHops = computeHops(a);
      const bHops = computeHops(b);
      return aHops - bHops;
    });
    return runs;
  }, [room.runs]);

  return (
    <div className="space-y-4" id="multiplayer-arena">
      {error && (
        <div className="rounded-md border border-red-200 bg-red-50 p-3 text-sm text-red-800">
          {error}
        </div>
      )}

      <Card className="p-4">
        <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
          <div>
            <div className="flex items-center gap-2">
              <div className="text-sm font-medium">Multiplayer arena</div>
              <Badge variant="outline" className="text-[11px]">
                {wsStatus}
              </Badge>
              <Badge variant="outline" className="text-[11px]">
                {room.status}
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

        <div className="grid grid-cols-1 gap-4 lg:grid-cols-12">
          <div className="lg:col-span-5">
            <div className="text-sm font-medium">Leaderboard</div>
            <div className="mt-2 space-y-2">
              {runsSorted.map((run) => {
                const article = currentArticleForRun(room, run);
                const hops = computeHops(run);
                const elapsedMs = runElapsedMs(run, nowMs);
                const elapsedLabel =
                  run.status === "not_started" ? "--" : formatTime(Math.floor(elapsedMs / 1000));
                const player = run.player_id
                  ? room.players.find((p) => p.id === run.player_id)
                  : null;
                return (
                  <div
                    key={run.id}
                    className="flex items-center justify-between rounded-md border bg-background/60 px-3 py-2"
                  >
                    <div className="min-w-0">
                      <div className="truncate text-sm font-medium">
                        {player?.name || run.player_name || "Player"}
                        {playerId && run.player_id === playerId ? (
                          <span className="ml-2 text-[11px] text-muted-foreground">(you)</span>
                        ) : null}
                      </div>
                      <div className="truncate text-[11px] text-muted-foreground">
                        {article} • {hops}/{room.rules.max_hops} hops • {elapsedLabel}
                      </div>
                    </div>
                    <Badge
                      variant={run.status === "finished" ? "default" : "outline"}
                      className="text-[11px]"
                    >
                      {run.status === "finished" ? run.result || "finished" : run.status}
                    </Badge>
                  </div>
                );
              })}
            </div>

            {room.status === "finished" && (
              <div className="mt-3 rounded-md border bg-muted/30 p-3 text-xs text-muted-foreground">
                Race finished. You can leave and start a new room.
              </div>
            )}

            <div className="mt-3 rounded-md border bg-muted/20 p-3">
              <div className="text-xs font-medium">Quick move (debug)</div>
              <div className="mt-1 text-[11px] text-muted-foreground">
                Useful for automation and recovery. Normally, click links in the Wikipedia view.
              </div>
              <div className="mt-2 flex gap-2">
                <Input
                  value={quickMoveTitle}
                  onChange={(e) => setQuickMoveTitle(e.target.value)}
                  placeholder="Article title"
                  className="h-9"
                  disabled={!myRunning}
                />
                <Button
                  size="sm"
                  className="h-9"
                  disabled={!myRunning || quickMoveTitle.trim().length === 0}
                  onClick={() => {
                    const title = quickMoveTitle.trim();
                    if (!title) return;
                    setQuickMoveTitle("");
                    void makeMove(title);
                  }}
                >
                  Move
                </Button>
              </div>
            </div>

            {qrUrl && inviteLink && (
              <div className="mt-3 rounded-md border bg-muted/10 p-3">
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

          <div className="lg:col-span-7">
            <div className="flex items-center justify-between">
              <div className="text-sm font-medium">Wikipedia view</div>
              {myRun?.status === "running" || myRun?.status === "finished" ? (
                <Badge variant="outline" className="text-[11px]">
                  {formatTime(myElapsedSeconds)}
                </Badge>
              ) : null}
            </div>
            <div className="mt-1 text-xs text-muted-foreground">
              {myRunning
                ? "Click links to make moves. Your move broadcasts to everyone."
                : myFinished
                  ? "Run finished. Explore mode: clicks won’t change the race."
                  : room.status === "running"
                  ? "Waiting for your run to start (refresh if needed)."
                  : "Explore mode: clicks won’t change the race."}
            </div>

            <div className="mt-3 relative w-full h-[560px] overflow-hidden rounded-md border bg-muted/10">
              <iframe
                key={wikiSrc}
                style={
                  {
                    transform: "scale(0.75, 0.75)",
                    width: "calc(100% * 1.333333)",
                    height: "calc(100% * 1.333333)",
                    transformOrigin: "top left",
                    position: "absolute",
                    top: 0,
                    left: 0,
                  } as CSSProperties
                }
                src={wikiSrc}
                className="border-0"
              />
            </div>
          </div>
        </div>
      </Card>
    </div>
  );
}
