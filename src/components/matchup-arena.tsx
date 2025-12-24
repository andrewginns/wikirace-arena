"use client";

import { useMemo } from "react";
import RaceArena from "@/components/race/race-arena";
import { createLocalRaceDriver } from "@/lib/local-race-driver";
import { sessionToRaceState } from "@/lib/race-state";
import { useSessionsStore } from "@/lib/session-store";

export default function MatchupArena({
  onGoToViewerTab,
  onNewRace,
  modelList = [],
  isServerConnected = true,
}: {
  onGoToViewerTab?: () => void;
  onNewRace?: () => void;
  modelList?: string[];
  isServerConnected?: boolean;
}) {
  const { sessions, active_session_id } = useSessionsStore();
  const session = active_session_id ? sessions[active_session_id] : null;
  const sessionId = session?.id || null;

  const race = session ? sessionToRaceState(session) : null;
  const driver = useMemo(
    () => (sessionId ? createLocalRaceDriver(sessionId) : null),
    [sessionId]
  );

  return (
    <RaceArena
      race={race}
      driver={driver}
      onGoToViewerTab={onGoToViewerTab}
      onNewRace={onNewRace}
      modelList={modelList}
      isServerConnected={isServerConnected}
    />
  );
}
