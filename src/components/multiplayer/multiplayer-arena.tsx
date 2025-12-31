"use client";

import { useMemo } from "react";
import RaceArena from "@/components/race/race-arena";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import type { MultiplayerRoomV1 } from "@/lib/multiplayer-types";
import { createMultiplayerRaceDriver } from "@/lib/multiplayer-race-driver";
import { roomToRaceState } from "@/lib/race-state";
import { AlertTriangle } from "lucide-react";

export default function MultiplayerArena({
  room,
  playerId,
  playerName,
  joinUrl,
  wsStatus,
  error,
  onLeave,
  onNewRound,
  modelList = [],
  isServerConnected = true,
  onGoToViewerTab,
}: {
  room: MultiplayerRoomV1;
  playerId: string | null;
  playerName: string | null;
  joinUrl: string | null;
  wsStatus: string;
  error: string | null;
  onLeave: () => void;
  onNewRound?: () => void;
  modelList?: string[];
  isServerConnected?: boolean;
  onGoToViewerTab?: () => void;
}) {
  const race = useMemo(() => roomToRaceState(room, playerId), [room, playerId]);
  const driver = useMemo(() => createMultiplayerRaceDriver(race), [race]);

  const isHost = playerId && playerId === room.owner_player_id;

  return (
    <div className="space-y-4">
      {error && (
        <div className="flex items-start gap-2 rounded-md border border-status-error/30 bg-status-error/10 p-3 text-sm text-foreground">
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-status-error" aria-hidden="true" />
          <div>{error}</div>
        </div>
      )}

      <RaceArena
        race={race}
        driver={driver}
        onGoToViewerTab={onGoToViewerTab}
        modelList={modelList}
        isServerConnected={isServerConnected}
        extraHeaderActions={
          <>
            <Badge variant="outline" className="text-[11px]">
              {wsStatus}
            </Badge>
            {playerName ? (
              <Badge variant="outline" className="text-[11px]">
                {isHost ? `Host: ${playerName}` : playerName}
              </Badge>
            ) : null}
            {isHost && onNewRound ? (
              <Button variant="secondary" size="sm" onClick={onNewRound}>
                New round
              </Button>
            ) : null}
            <Button variant="outline" size="sm" onClick={onLeave}>
              Leave
            </Button>
          </>
        }
      />

      {joinUrl ? (
        <div className="rounded-md border bg-muted/10 p-3 text-xs text-muted-foreground break-all">
          Invite: {joinUrl}
        </div>
      ) : null}
    </div>
  );
}
