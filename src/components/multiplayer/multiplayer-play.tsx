"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import MultiplayerSetup from "@/components/multiplayer/multiplayer-setup";
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

  useEffect(() => {
    if (bootstrapped) return;
    setBootstrapped(true);
    void bootstrapMultiplayer();
  }, [bootstrapped]);

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
      modelList={modelList}
      isServerConnected={isServerConnected}
      onGoToViewerTab={onGoToViewerTab}
    />
  );
}
