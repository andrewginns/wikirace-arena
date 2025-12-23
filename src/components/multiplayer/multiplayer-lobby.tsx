"use client";

import { useMemo, useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Separator } from "@/components/ui/separator";
import type { MultiplayerRoomV1 } from "@/lib/multiplayer-types";
import { startRoom } from "@/lib/multiplayer-store";

export default function MultiplayerLobby({
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
  const [copyStatus, setCopyStatus] = useState<"idle" | "copied" | "failed">(
    "idle"
  );
  const [startLoading, setStartLoading] = useState(false);

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

  return (
    <div className="space-y-4">
      {error && (
        <div className="rounded-md border border-red-200 bg-red-50 p-3 text-sm text-red-800">
          {error}
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

        <div className="grid grid-cols-1 gap-4 lg:grid-cols-12">
          <div className="lg:col-span-7">
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
                  <Badge
                    variant={p.connected ? "default" : "outline"}
                    className="text-[11px]"
                  >
                    {p.connected ? "Connected" : "Offline"}
                  </Badge>
                </div>
              ))}
            </div>
          </div>

          <div className="lg:col-span-5">
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
        </div>
      </Card>
    </div>
  );
}
