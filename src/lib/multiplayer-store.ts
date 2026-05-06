import { useSyncExternalStore } from "react";
import { API_BASE } from "@/lib/constants";
import {
  safeLocalStorageGetItem,
  safeLocalStorageRemoveItem,
  safeLocalStorageSetItem,
  safeSessionStorageGetItem,
  safeSessionStorageRemoveItem,
  safeSessionStorageSetItem,
} from "@/lib/storage";
import type {
  AddLlmRunRequest,
  CreateRoomRequest,
  CreateRoomResponse,
  JoinRoomResponse,
  MultiplayerRoomV1,
  RoomWsTicketResponse,
} from "@/lib/multiplayer-types";

type WebSocketStatus = "disconnected" | "connecting" | "connected";

type StoreState = {
  room: MultiplayerRoomV1 | null;
  player_id: string | null;
  player_token: string | null;
  player_name: string | null;
  join_url: string | null;
  ws_status: WebSocketStatus;
  error: string | null;
};

class ApiRequestError extends Error {
  status: number;

  constructor(message: string, status: number) {
    super(message);
    this.name = "ApiRequestError";
    this.status = status;
  }
}

// Room + player identity is stored in sessionStorage so multiple tabs can join
// the same room as different players without clobbering each other.
const ROOM_ID_KEY = "wikirace:multiplayer:room-id";
const PLAYER_ID_KEY = "wikirace:multiplayer:player-id";
const PLAYER_TOKEN_KEY = "wikirace:multiplayer:player-token";

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

function loadInitialState(): StoreState {
  let roomId =
    safeSessionStorageGetItem(ROOM_ID_KEY) || safeLocalStorageGetItem(ROOM_ID_KEY);
  let playerId =
    safeSessionStorageGetItem(PLAYER_ID_KEY) || safeLocalStorageGetItem(PLAYER_ID_KEY);
  let playerToken = safeSessionStorageGetItem(PLAYER_TOKEN_KEY);
  const playerName = safeLocalStorageGetItem(PLAYER_NAME_KEY);

  if (roomId && (!playerId || !playerToken)) {
    roomId = null;
    playerId = null;
    playerToken = null;
    safeSessionStorageRemoveItem(ROOM_ID_KEY);
    safeSessionStorageRemoveItem(PLAYER_ID_KEY);
    safeSessionStorageRemoveItem(PLAYER_TOKEN_KEY);
    safeSessionStorageRemoveItem(JOIN_URL_KEY);
    safeLocalStorageRemoveItem(ROOM_ID_KEY);
    safeLocalStorageRemoveItem(PLAYER_ID_KEY);
  }

  const normalizedRoomId = roomId ? normalizeRoomId(roomId) : null;
  const storedJoinUrl = safeSessionStorageGetItem(JOIN_URL_KEY);
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
  if (roomId && !safeSessionStorageGetItem(ROOM_ID_KEY)) {
    safeSessionStorageSetItem(ROOM_ID_KEY, roomId);
  }
  if (playerId && !safeSessionStorageGetItem(PLAYER_ID_KEY)) {
    safeSessionStorageSetItem(PLAYER_ID_KEY, playerId);
  }

  return {
    room: null,
    player_id: playerId || null,
    player_token: playerToken || null,
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
        player_token: null,
        player_name: null,
        join_url: null,
        ws_status: "disconnected",
        error: null,
      }
    : loadInitialState();

let ws: WebSocket | null = null;
let wsUrl: string | null = null;
let wsReconnectTimer: number | null = null;
let wsReconnectAttempt = 0;
let wsConnectAttemptId = 0;
let wsShouldReconnect = false;
let bootstrapPromise: Promise<void> | null = null;

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
  playerToken: string | null,
  name: string | null,
  joinUrl?: string | null
) {
  if (roomId) safeSessionStorageSetItem(ROOM_ID_KEY, roomId);
  else safeSessionStorageRemoveItem(ROOM_ID_KEY);

  if (playerId) safeSessionStorageSetItem(PLAYER_ID_KEY, playerId);
  else safeSessionStorageRemoveItem(PLAYER_ID_KEY);

  if (playerToken) safeSessionStorageSetItem(PLAYER_TOKEN_KEY, playerToken);
  else safeSessionStorageRemoveItem(PLAYER_TOKEN_KEY);

  if (joinUrl) safeSessionStorageSetItem(JOIN_URL_KEY, joinUrl);
  else safeSessionStorageRemoveItem(JOIN_URL_KEY);

  // Also keep legacy keys clean so other tabs don't unexpectedly bootstrap.
  safeLocalStorageRemoveItem(ROOM_ID_KEY);
  safeLocalStorageRemoveItem(PLAYER_ID_KEY);

  if (name) safeLocalStorageSetItem(PLAYER_NAME_KEY, name);
  else safeLocalStorageRemoveItem(PLAYER_NAME_KEY);
}

function getApiOrigin(): string {
  if (API_BASE && API_BASE.startsWith("http")) return API_BASE;
  if (typeof window !== "undefined") return window.location.origin;
  return "";
}

function getWsUrl(roomId: string, playerId: string | null, wsTicket: string | null) {
  const base = getApiOrigin();
  const url = new URL(base);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  url.pathname = `/rooms/${encodeURIComponent(roomId)}/ws`;
  url.search = "";
  if (playerId && wsTicket) {
    url.searchParams.set("player_id", playerId);
    url.searchParams.set("ws_ticket", wsTicket);
  }
  return url.toString();
}

async function apiJson<T>(path: string, init?: RequestInit): Promise<T> {
  const base = getApiOrigin();
  const url = base ? `${base}${path}` : path;
  const response = await fetch(url, {
    ...init,
    headers: {
      "Content-Type": "application/json",
      ...(state.player_token
        ? { "X-Wikirace-Player-Token": state.player_token }
        : {}),
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
    throw new ApiRequestError(detail, response.status);
  }

  return (await response.json()) as T;
}

function closeWebSocket() {
  wsConnectAttemptId += 1;
  wsShouldReconnect = false;
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
  wsUrl = null;
  if (state.ws_status !== "disconnected") {
    setState({ ...state, ws_status: "disconnected" });
  }
}

function scheduleReconnect(
  roomId: string,
  playerId: string | null,
  playerToken: string | null
) {
  if (!wsShouldReconnect) return;
  if (wsReconnectTimer) return;

  const attempt = wsReconnectAttempt;
  const delay = Math.min(10_000, 800 * Math.pow(2, attempt));
  wsReconnectAttempt += 1;

  wsReconnectTimer = window.setTimeout(() => {
    wsReconnectTimer = null;
    connectWebSocket(roomId, playerId, playerToken);
  }, delay);
}

function terminalWebSocketCloseError(code: number): string | null {
  if (code === 1008) {
    return "Room credentials are invalid or expired. Please join the room again.";
  }
  if (code === 1001) {
    return "This room is no longer available. Please create or join a new room.";
  }
  return null;
}

function storedIdentityMatches(
  roomId: string,
  playerId: string | null,
  playerToken: string | null
) {
  const currentIdentity = currentStoredIdentity();
  return (
    currentIdentity.roomId === roomId &&
    currentIdentity.playerId === (playerId || null) &&
    currentIdentity.playerToken === (playerToken || null)
  );
}

function activeIdentityMatches(
  roomId: string,
  playerId: string | null,
  playerToken: string | null
) {
  return (
    state.room?.id === roomId &&
    state.player_id === (playerId || null) &&
    state.player_token === (playerToken || null)
  );
}

async function fetchWsTicket(roomId: string, playerId: string | null) {
  if (!playerId) return null;
  const response = await apiJson<RoomWsTicketResponse>(
    `/rooms/${encodeURIComponent(roomId)}/ws_ticket`,
    {
      method: "POST",
      body: JSON.stringify({ player_id: playerId }),
    }
  );
  return response.ws_ticket;
}

export function connectWebSocket(
  roomId: string,
  playerId: string | null,
  playerToken: string | null
) {
  if (typeof window === "undefined") return;
  if (!roomId || !playerId || !playerToken) return;

  if (!wsShouldReconnect) {
    wsReconnectAttempt = 0;
  }

  closeWebSocket();
  wsShouldReconnect = true;
  setState({ ...state, ws_status: "connecting" });

  const connectAttemptId = wsConnectAttemptId;

  void (async () => {
    let wsTicket: string | null = null;
    try {
      wsTicket = await fetchWsTicket(roomId, playerId);
    } catch (err) {
      if (connectAttemptId !== wsConnectAttemptId || !wsShouldReconnect) return;
      if (err instanceof ApiRequestError && (err.status === 403 || err.status === 404)) {
        leaveRoom();
        setError(
          err.status === 404
            ? "This room is no longer available. Please create or join a new room."
            : "Room credentials are invalid or expired. Please join the room again."
        );
        return;
      }
      setState({ ...state, ws_status: "disconnected" });
      setError(err instanceof Error ? err.message : String(err));
      scheduleReconnect(roomId, playerId, playerToken);
      return;
    }

    if (
      connectAttemptId !== wsConnectAttemptId ||
      !wsShouldReconnect ||
      !wsTicket ||
      !activeIdentityMatches(roomId, playerId, playerToken)
    ) {
      return;
    }

    const nextWsUrl = getWsUrl(roomId, playerId, wsTicket);
    if (
      ws &&
      wsUrl === nextWsUrl &&
      (ws.readyState === WebSocket.CONNECTING || ws.readyState === WebSocket.OPEN)
    ) {
      return;
    }

    const socket = new WebSocket(nextWsUrl);
    ws = socket;
    wsUrl = nextWsUrl;

    socket.onopen = () => {
      if (ws !== socket) return;
      wsReconnectAttempt = 0;
      setState({ ...state, ws_status: "connected" });
    };

    socket.onclose = (event) => {
      if (ws !== socket) return;
      ws = null;
      wsUrl = null;

      const terminalError = terminalWebSocketCloseError(event.code);
      if (terminalError) {
        leaveRoom();
        setError(terminalError);
        return;
      }

      setState({ ...state, ws_status: "disconnected" });
      scheduleReconnect(roomId, playerId, playerToken);
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
      const msg = data as { type?: unknown; room?: unknown; detail?: unknown };
      if (msg.type === "room_error") {
        leaveRoom();
        setError(
          typeof msg.detail === "string" && msg.detail.trim()
            ? msg.detail
            : "Multiplayer room connection failed."
        );
        return;
      }
      if (msg.type !== "room_state") return;
      if (!msg.room || typeof msg.room !== "object") return;
      setState({ ...state, room: msg.room as MultiplayerRoomV1, error: null });
    };
  })();
}

function currentStoredIdentity() {
  const storedRoomId =
    safeSessionStorageGetItem(ROOM_ID_KEY) || safeLocalStorageGetItem(ROOM_ID_KEY);
  const storedPlayerId =
    safeSessionStorageGetItem(PLAYER_ID_KEY) || safeLocalStorageGetItem(PLAYER_ID_KEY);
  const storedPlayerToken = safeSessionStorageGetItem(PLAYER_TOKEN_KEY);
  return {
    roomId: storedRoomId ? normalizeRoomId(storedRoomId) : null,
    playerId: storedPlayerId || null,
    playerToken: storedPlayerToken || null,
  };
}

async function bootstrapMultiplayerOnce() {
  const {
    roomId: normalizedRoomId,
    playerId: storedPlayerId,
    playerToken: storedPlayerToken,
  } = currentStoredIdentity();
  if (!normalizedRoomId) return;

  if (!storedPlayerId || !storedPlayerToken) {
    leaveRoom();
    return;
  }

  safeSessionStorageSetItem(ROOM_ID_KEY, normalizedRoomId);
  if (storedPlayerId) safeSessionStorageSetItem(PLAYER_ID_KEY, storedPlayerId);

  try {
    const room = await apiJson<MultiplayerRoomV1>(
      `/rooms/${encodeURIComponent(normalizedRoomId)}?player_id=${encodeURIComponent(storedPlayerId)}`
    );
    if (!storedIdentityMatches(normalizedRoomId, storedPlayerId, storedPlayerToken)) {
      return;
    }

    const storedJoinUrl = safeSessionStorageGetItem(JOIN_URL_KEY);
    const join_url = storedJoinUrl
      ? storedJoinUrl
      : `${window.location.origin}/?room=${normalizedRoomId}`;

    setState({
      ...state,
      room,
      error: null,
      join_url,
    });
    connectWebSocket(normalizedRoomId, storedPlayerId, storedPlayerToken || null);
  } catch (err) {
    if (!storedIdentityMatches(normalizedRoomId, storedPlayerId, storedPlayerToken)) {
      return;
    }
    if (err instanceof ApiRequestError && (err.status === 403 || err.status === 404)) {
      leaveRoom();
      setError(
        err.status === 404
          ? "This room is no longer available. Please create or join a new room."
          : "Room credentials are invalid or expired. Please join the room again."
      );
      return;
    }
    setError(err instanceof Error ? err.message : String(err));
  }
}

export async function bootstrapMultiplayer() {
  if (bootstrapPromise) return bootstrapPromise;
  bootstrapPromise = bootstrapMultiplayerOnce().finally(() => {
    bootstrapPromise = null;
  });
  return bootstrapPromise;
}

export async function createRoom(request: CreateRoomRequest) {
  const body: CreateRoomRequest = {
    ...request,
    rules: request.rules
      ? {
          max_hops: request.rules.max_hops ?? 20,
          max_links: request.rules.max_links ?? null,
          max_tokens: request.rules.max_tokens ?? null,
          include_image_links: request.rules.include_image_links ?? false,
          disable_links_view: request.rules.disable_links_view ?? false,
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
    response.owner_player_token,
    request.owner_name?.trim() || "Host",
    response.join_url
  );

  setState({
    ...state,
    room: response.room,
    player_id: response.owner_player_id,
    player_token: response.owner_player_token,
    player_name: request.owner_name?.trim() || "Host",
    join_url: response.join_url,
    error: null,
  });

  connectWebSocket(
    response.room_id,
    response.owner_player_id,
    response.owner_player_token
  );
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
    response.player_token,
    trimmed,
    `${window.location.origin}/?room=${response.room.id}`
  );
  setState({
    ...state,
    room: response.room,
    player_id: response.player_id,
    player_token: response.player_token,
    player_name: trimmed,
    join_url: `${window.location.origin}/?room=${response.room.id}`,
    error: null,
  });
  connectWebSocket(response.room.id, response.player_id, response.player_token);
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
  wsReconnectAttempt = 0;
  persistRoomIdentity(null, null, null, null);
  setState({
    room: null,
    player_id: null,
    player_token: null,
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
