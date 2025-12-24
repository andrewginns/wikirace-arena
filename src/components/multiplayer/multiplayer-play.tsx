"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import MultiplayerSetup from "@/components/multiplayer/multiplayer-setup";
import MultiplayerRoundSetup from "@/components/multiplayer/multiplayer-round-setup";
import MultiplayerLobby from "@/components/multiplayer/multiplayer-lobby";
import MultiplayerArena from "@/components/multiplayer/multiplayer-arena";
import {
  bootstrapMultiplayer,
  leaveRoom,
  useMultiplayerStore,
} from "@/lib/multiplayer-store";

export default function MultiplayerPlay({
  allArticles,
  isServerConnected,
  modelList = [],
  onGoToViewerTab,
}: {
  allArticles: string[];
  isServerConnected: boolean;
  modelList?: string[];
  onGoToViewerTab?: () => void;
}) {
  const { room, player_id, player_name, join_url, ws_status, error } = useMultiplayerStore();
  const [bootstrapped, setBootstrapped] = useState(false);
  const [roundSetupOpen, setRoundSetupOpen] = useState(false);

  useEffect(() => {
    if (bootstrapped) return;
    setBootstrapped(true);
    void bootstrapMultiplayer();
  }, [bootstrapped]);

  useEffect(() => {
    if (room) return;
    if (!roundSetupOpen) return;
    setRoundSetupOpen(false);
  }, [room, roundSetupOpen]);

  const prefillRoomId = useMemo(() => {
    if (typeof window === "undefined") return "";
    const value = new URLSearchParams(window.location.search).get("room");
    return value ? value.trim() : "";
  }, []);

  const prevRoomIdRef = useRef<string | null>(null);
  useEffect(() => {
    if (typeof window === "undefined") return;

    const prevRoomId = prevRoomIdRef.current;
    const nextRoomId = room?.id || null;
    prevRoomIdRef.current = nextRoomId;

    const url = new URL(window.location.href);

    if (nextRoomId) {
      if (url.searchParams.get("room") !== nextRoomId) {
        url.searchParams.set("room", nextRoomId);
        window.history.replaceState({}, "", url.toString());
      }
      return;
    }

    if (prevRoomId && url.searchParams.has("room")) {
      url.searchParams.delete("room");
      window.history.replaceState({}, "", url.toString());
    }
  }, [room]);

  if (!room) {
    return (
      <MultiplayerSetup
        allArticles={allArticles}
        isServerConnected={isServerConnected}
        prefillRoomId={prefillRoomId}
      />
    );
  }

  const isHost = Boolean(player_id && player_id === room.owner_player_id);
  if (roundSetupOpen && isHost) {
    return (
      <MultiplayerRoundSetup
        room={room}
        allArticles={allArticles}
        isServerConnected={isServerConnected}
        error={error}
        onCancel={() => setRoundSetupOpen(false)}
      />
    );
  }

  if (room.status === "lobby") {
    return (
      <MultiplayerLobby
        room={room}
        playerId={player_id}
        playerName={player_name}
        joinUrl={join_url}
        wsStatus={ws_status}
        error={error}
        onLeave={leaveRoom}
        modelList={modelList}
      />
    );
  }

  return (
    <MultiplayerArena
      room={room}
      playerId={player_id}
      playerName={player_name}
      joinUrl={join_url}
      wsStatus={ws_status}
      error={error}
      onLeave={leaveRoom}
      onNewRound={isHost ? () => setRoundSetupOpen(true) : undefined}
      modelList={modelList}
      isServerConnected={isServerConnected}
      onGoToViewerTab={onGoToViewerTab}
    />
  );
}
