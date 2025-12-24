import { useSyncExternalStore } from "react";
import { API_BASE } from "@/lib/constants";
import type {
  AddLlmRunRequest,
  CreateRoomRequest,
  CreateRoomResponse,
  JoinRoomResponse,
  MultiplayerRoomV1,
} from "@/lib/multiplayer-types";

type WebSocketStatus = "disconnected" | "connecting" | "connected";

type StoreState = {
  room: MultiplayerRoomV1 | null;
  player_id: string | null;
  player_name: string | null;
  join_url: string | null;
  ws_status: WebSocketStatus;
  error: string | null;
};

// Room + player identity is stored in sessionStorage so multiple tabs can join
// the same room as different players without clobbering each other.
const ROOM_ID_KEY = "wikirace:multiplayer:room-id";
const PLAYER_ID_KEY = "wikirace:multiplayer:player-id";

const JOIN_URL_KEY = "wikirace:multiplayer:join-url";

// We keep the last-used name in localStorage for convenience.
const PLAYER_NAME_KEY = "wikirace:multiplayer:player-name";

function normalizeRoomId(roomId: string) {
  const raw = roomId.trim();
  if (!raw) return raw;

  if (raw.toLowerCase().startsWith("room_")) {
    const rest = raw.slice("room_".length);
    return `room_${rest.toUpperCase()}`;
  }

  return `room_${raw.toUpperCase()}`;
}

const listeners = new Set<() => void>();

function emit() {
  for (const listener of listeners) listener();
}

function safeGetItem(key: string) {
  if (typeof window === "undefined") return null;
  try {
    return window.localStorage.getItem(key);
  } catch {
    return null;
  }
}

function safeGetSessionItem(key: string) {
  if (typeof window === "undefined") return null;
  try {
    return window.sessionStorage.getItem(key);
  } catch {
    return null;
  }
}

function safeSetSessionItem(key: string, value: string) {
  if (typeof window === "undefined") return;
  try {
    window.sessionStorage.setItem(key, value);
  } catch {
    // ignore
  }
}

function safeRemoveSessionItem(key: string) {
  if (typeof window === "undefined") return;
  try {
    window.sessionStorage.removeItem(key);
  } catch {
    // ignore
  }
}

function safeSetItem(key: string, value: string) {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(key, value);
  } catch {
    // ignore
  }
}

function safeRemoveItem(key: string) {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.removeItem(key);
  } catch {
    // ignore
  }
}

function loadInitialState(): StoreState {
  const roomId = safeGetSessionItem(ROOM_ID_KEY) || safeGetItem(ROOM_ID_KEY);
  const playerId = safeGetSessionItem(PLAYER_ID_KEY) || safeGetItem(PLAYER_ID_KEY);
  const playerName = safeGetItem(PLAYER_NAME_KEY);

  const normalizedRoomId = roomId ? normalizeRoomId(roomId) : null;
  const storedJoinUrl = safeGetSessionItem(JOIN_URL_KEY);
  let join_url: string | null = null;

  if (storedJoinUrl && normalizedRoomId) {
    try {
      const parsed = new URL(storedJoinUrl);
      const roomParam = parsed.searchParams.get("room");
      if (roomParam && normalizeRoomId(roomParam) === normalizedRoomId) {
        join_url = storedJoinUrl;
      }
    } catch {
      // ignore
    }
  }

  // Migration: older builds stored ids in localStorage.
  if (roomId && !safeGetSessionItem(ROOM_ID_KEY)) safeSetSessionItem(ROOM_ID_KEY, roomId);
  if (playerId && !safeGetSessionItem(PLAYER_ID_KEY)) safeSetSessionItem(PLAYER_ID_KEY, playerId);

  return {
    room: null,
    player_id: playerId || null,
    player_name: playerName || null,
    join_url: join_url || (normalizedRoomId ? `${window.location.origin}/?room=${normalizedRoomId}` : null),
    ws_status: "disconnected",
    error: null,
  };
}

let state: StoreState =
  typeof window === "undefined"
    ? {
        room: null,
        player_id: null,
        player_name: null,
        join_url: null,
        ws_status: "disconnected",
        error: null,
      }
    : loadInitialState();

let ws: WebSocket | null = null;
let wsReconnectTimer: number | null = null;
let wsReconnectAttempt = 0;
let wsShouldReconnect = false;

function setState(next: StoreState) {
  state = next;
  emit();
}

function setError(error: string | null) {
  if (state.error === error) return;
  setState({ ...state, error });
}

function persistRoomIdentity(
  roomId: string | null,
  playerId: string | null,
  name: string | null,
  joinUrl?: string | null
) {
  if (roomId) safeSetSessionItem(ROOM_ID_KEY, roomId);
  else safeRemoveSessionItem(ROOM_ID_KEY);

  if (playerId) safeSetSessionItem(PLAYER_ID_KEY, playerId);
  else safeRemoveSessionItem(PLAYER_ID_KEY);

  if (joinUrl) safeSetSessionItem(JOIN_URL_KEY, joinUrl);
  else safeRemoveSessionItem(JOIN_URL_KEY);

  // Also keep legacy keys clean so other tabs don't unexpectedly bootstrap.
  safeRemoveItem(ROOM_ID_KEY);
  safeRemoveItem(PLAYER_ID_KEY);

  if (name) safeSetItem(PLAYER_NAME_KEY, name);
  else safeRemoveItem(PLAYER_NAME_KEY);
}

function getApiOrigin(): string {
  if (API_BASE && API_BASE.startsWith("http")) return API_BASE;
  if (typeof window !== "undefined") return window.location.origin;
  return "";
}

function getWsUrl(roomId: string, playerId: string | null) {
  const base = getApiOrigin();
  const url = new URL(base);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  url.pathname = `/rooms/${encodeURIComponent(roomId)}/ws`;
  url.search = "";
  if (playerId) url.searchParams.set("player_id", playerId);
  return url.toString();
}

async function apiJson<T>(path: string, init?: RequestInit): Promise<T> {
  const base = getApiOrigin();
  const url = base ? `${base}${path}` : path;
  const response = await fetch(url, {
    ...init,
    headers: {
      "Content-Type": "application/json",
      ...(init?.headers || {}),
    },
  });

  if (!response.ok) {
    let detail = `${response.status} ${response.statusText}`;
    try {
      const data = (await response.json()) as { detail?: unknown };
      if (typeof data?.detail === "string" && data.detail.trim()) detail = data.detail;
    } catch {
      // ignore
    }
    throw new Error(detail);
  }

  return (await response.json()) as T;
}

function closeWebSocket() {
  wsShouldReconnect = false;
  wsReconnectAttempt = 0;
  if (wsReconnectTimer) {
    window.clearTimeout(wsReconnectTimer);
    wsReconnectTimer = null;
  }
  if (ws) {
    try {
      ws.close();
    } catch {
      // ignore
    }
  }
  ws = null;
  if (state.ws_status !== "disconnected") {
    setState({ ...state, ws_status: "disconnected" });
  }
}

function scheduleReconnect(roomId: string, playerId: string | null) {
  if (!wsShouldReconnect) return;
  if (wsReconnectTimer) return;

  const attempt = wsReconnectAttempt;
  const delay = Math.min(10_000, 800 * Math.pow(2, attempt));
  wsReconnectAttempt += 1;

  wsReconnectTimer = window.setTimeout(() => {
    wsReconnectTimer = null;
    connectWebSocket(roomId, playerId);
  }, delay);
}

export function connectWebSocket(roomId: string, playerId: string | null) {
  if (typeof window === "undefined") return;
  if (!roomId) return;

  closeWebSocket();
  wsShouldReconnect = true;
  setState({ ...state, ws_status: "connecting" });

  const socket = new WebSocket(getWsUrl(roomId, playerId));
  ws = socket;

  socket.onopen = () => {
    if (ws !== socket) return;
    wsReconnectAttempt = 0;
    setState({ ...state, ws_status: "connected" });
  };

  socket.onclose = () => {
    if (ws !== socket) return;
    ws = null;
    setState({ ...state, ws_status: "disconnected" });
    scheduleReconnect(roomId, playerId);
  };

  socket.onerror = () => {
    // Let onclose drive the reconnect logic.
  };

  socket.onmessage = (event) => {
    if (ws !== socket) return;
    let data: unknown;
    try {
      data = JSON.parse(event.data);
    } catch {
      return;
    }

    if (!data || typeof data !== "object") return;
    const msg = data as { type?: unknown; room?: unknown };
    if (msg.type !== "room_state") return;
    if (!msg.room || typeof msg.room !== "object") return;
    setState({ ...state, room: msg.room as MultiplayerRoomV1, error: null });
  };
}

export async function bootstrapMultiplayer() {
  const storedRoomId = safeGetSessionItem(ROOM_ID_KEY) || safeGetItem(ROOM_ID_KEY);
  const storedPlayerId = safeGetSessionItem(PLAYER_ID_KEY) || safeGetItem(PLAYER_ID_KEY);
  if (!storedRoomId) return;

  const normalizedRoomId = normalizeRoomId(storedRoomId);

  if (storedRoomId) safeSetSessionItem(ROOM_ID_KEY, normalizedRoomId);
  if (storedPlayerId) safeSetSessionItem(PLAYER_ID_KEY, storedPlayerId);

  try {
    const room = await apiJson<MultiplayerRoomV1>(`/rooms/${encodeURIComponent(normalizedRoomId)}`);

    const storedJoinUrl = safeGetSessionItem(JOIN_URL_KEY);
    const join_url = storedJoinUrl
      ? storedJoinUrl
      : `${window.location.origin}/?room=${normalizedRoomId}`;

    setState({
      ...state,
      room,
      error: null,
      join_url,
    });
    connectWebSocket(normalizedRoomId, storedPlayerId);
  } catch (err) {
    setError(err instanceof Error ? err.message : String(err));
  }
}

export async function createRoom(request: CreateRoomRequest) {
  const body: CreateRoomRequest = {
    ...request,
    rules: request.rules
      ? {
          max_hops: request.rules.max_hops ?? 20,
          max_links: request.rules.max_links ?? null,
          max_tokens: request.rules.max_tokens ?? null,
        }
      : undefined,
  };

  setError(null);
  let response: CreateRoomResponse;
  try {
    response = await apiJson<CreateRoomResponse>("/rooms", {
      method: "POST",
      body: JSON.stringify(body),
    });
  } catch (err) {
    setError(err instanceof Error ? err.message : String(err));
    return null;
  }

  persistRoomIdentity(
    response.room_id,
    response.owner_player_id,
    request.owner_name?.trim() || "Host",
    response.join_url
  );

  setState({
    ...state,
    room: response.room,
    player_id: response.owner_player_id,
    player_name: request.owner_name?.trim() || "Host",
    join_url: response.join_url,
    error: null,
  });

  connectWebSocket(response.room_id, response.owner_player_id);
  return response;
}

export async function joinRoom(roomId: string, name: string) {
  const trimmed = name.trim();
  if (!trimmed) throw new Error("Name is required");

  const normalizedRoomId = normalizeRoomId(roomId);

  setError(null);
  let response: JoinRoomResponse;
  try {
    response = await apiJson<JoinRoomResponse>(
      `/rooms/${encodeURIComponent(normalizedRoomId)}/join`,
      {
        method: "POST",
        body: JSON.stringify({ name: trimmed }),
      }
    );
  } catch (err) {
    setError(err instanceof Error ? err.message : String(err));
    return null;
  }

  persistRoomIdentity(
    response.room.id,
    response.player_id,
    trimmed,
    `${window.location.origin}/?room=${response.room.id}`
  );
  setState({
    ...state,
    room: response.room,
    player_id: response.player_id,
    player_name: trimmed,
    join_url: `${window.location.origin}/?room=${response.room.id}`,
    error: null,
  });
  connectWebSocket(response.room.id, response.player_id);
  return response;
}

export async function startRoom() {
  const roomId = state.room?.id;
  const playerId = state.player_id;
  if (!roomId || !playerId) throw new Error("Not connected to a room");

  setError(null);
  try {
    const room = await apiJson<MultiplayerRoomV1>(
      `/rooms/${encodeURIComponent(roomId)}/start`,
      {
        method: "POST",
        body: JSON.stringify({ player_id: playerId }),
      }
    );
    setState({ ...state, room, error: null });
  } catch (err) {
    setError(err instanceof Error ? err.message : String(err));
  }
}

export async function setupNewRound(startArticle: string, destinationArticle: string) {
  const roomId = state.room?.id;
  const playerId = state.player_id;
  if (!roomId || !playerId) {
    setError("Not connected to a room");
    return null;
  }

  setError(null);
  try {
    const room = await apiJson<MultiplayerRoomV1>(
      `/rooms/${encodeURIComponent(roomId)}/new_round`,
      {
        method: "POST",
        body: JSON.stringify({
          player_id: playerId,
          start_article: startArticle,
          destination_article: destinationArticle,
        }),
      }
    );
    setState({ ...state, room, error: null });
    return room;
  } catch (err) {
    setError(err instanceof Error ? err.message : String(err));
    return null;
  }
}

export async function addLlmParticipant(
  request: Omit<AddLlmRunRequest, "requested_by_player_id">
) {
  const roomId = state.room?.id;
  const playerId = state.player_id;
  if (!roomId || !playerId) {
    setError("Not connected to a room");
    return null;
  }

  setError(null);
  try {
    const room = await apiJson<MultiplayerRoomV1>(
      `/rooms/${encodeURIComponent(roomId)}/add_llm`,
      {
        method: "POST",
        body: JSON.stringify({
          ...request,
          requested_by_player_id: playerId,
        }),
      }
    );
    setState({ ...state, room, error: null });
    return room;
  } catch (err) {
    setError(err instanceof Error ? err.message : String(err));
    return null;
  }
}

export async function cancelRun(runId: string) {
  const roomId = state.room?.id;
  const playerId = state.player_id;
  if (!roomId || !playerId) {
    setError("Not connected to a room");
    return null;
  }
  const trimmed = runId.trim();
  if (!trimmed) return null;

  setError(null);
  try {
    const room = await apiJson<MultiplayerRoomV1>(
      `/rooms/${encodeURIComponent(roomId)}/runs/${encodeURIComponent(trimmed)}/cancel`,
      {
        method: "POST",
        body: JSON.stringify({ requested_by_player_id: playerId }),
      }
    );
    setState({ ...state, room, error: null });
    return room;
  } catch (err) {
    setError(err instanceof Error ? err.message : String(err));
    return null;
  }
}

export async function abandonRun(runId: string) {
  const roomId = state.room?.id;
  const playerId = state.player_id;
  if (!roomId || !playerId) {
    setError("Not connected to a room");
    return null;
  }
  const trimmed = runId.trim();
  if (!trimmed) return null;

  setError(null);
  try {
    const room = await apiJson<MultiplayerRoomV1>(
      `/rooms/${encodeURIComponent(roomId)}/runs/${encodeURIComponent(trimmed)}/abandon`,
      {
        method: "POST",
        body: JSON.stringify({ requested_by_player_id: playerId }),
      }
    );
    setState({ ...state, room, error: null });
    return room;
  } catch (err) {
    setError(err instanceof Error ? err.message : String(err));
    return null;
  }
}

export async function restartRun(runId: string) {
  const roomId = state.room?.id;
  const playerId = state.player_id;
  if (!roomId || !playerId) {
    setError("Not connected to a room");
    return null;
  }
  const trimmed = runId.trim();
  if (!trimmed) return null;

  setError(null);
  try {
    const room = await apiJson<MultiplayerRoomV1>(
      `/rooms/${encodeURIComponent(roomId)}/runs/${encodeURIComponent(trimmed)}/restart`,
      {
        method: "POST",
        body: JSON.stringify({ requested_by_player_id: playerId }),
      }
    );
    setState({ ...state, room, error: null });
    return room;
  } catch (err) {
    setError(err instanceof Error ? err.message : String(err));
    return null;
  }
}

export async function makeMove(toArticle: string): Promise<MultiplayerRoomV1 | null> {
  const roomId = state.room?.id;
  const playerId = state.player_id;
  if (!roomId || !playerId) {
    setError("Not connected to a room");
    return null;
  }
  const trimmed = toArticle.trim();
  if (!trimmed) return null;

  setError(null);
  try {
    const room = await apiJson<MultiplayerRoomV1>(
      `/rooms/${encodeURIComponent(roomId)}/move`,
      {
        method: "POST",
        body: JSON.stringify({ player_id: playerId, to_article: trimmed }),
      }
    );
    setState({ ...state, room, error: null });
    return room;
  } catch (err) {
    setError(err instanceof Error ? err.message : String(err));
    return null;
  }
}

export function leaveRoom() {
  closeWebSocket();
  persistRoomIdentity(null, null, null);
  setState({
    room: null,
    player_id: null,
    player_name: null,
    join_url: null,
    ws_status: "disconnected",
    error: null,
  });
}

export function getMultiplayerState() {
  return state;
}

export function useMultiplayerStore() {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    () => state
  );
}
