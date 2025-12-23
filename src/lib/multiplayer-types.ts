export type MultiplayerRoomStatus = "lobby" | "running" | "finished";

export type MultiplayerRunKind = "human" | "llm";

export type MultiplayerRunStatus = "not_started" | "running" | "finished";

export type MultiplayerRunResult = "win" | "lose";

export type MultiplayerStepType = "start" | "move" | "win" | "lose";

export type MultiplayerRulesV1 = {
  max_hops: number;
  max_links: number | null;
  max_tokens: number | null;
};

export type MultiplayerPlayerV1 = {
  id: string;
  name: string;
  connected: boolean;
  joined_at: string;
};

export type MultiplayerStepV1 = {
  type: MultiplayerStepType;
  article: string;
  at: string;
  metadata?: Record<string, unknown>;
};

export type MultiplayerRunV1 = {
  id: string;
  kind: MultiplayerRunKind;
  player_id?: string;
  player_name?: string;
  model?: string;
  api_base?: string;
  reasoning_effort?: string;
  max_steps?: number;
  max_links?: number | null;
  max_tokens?: number | null;
  started_at?: string;
  finished_at?: string;
  status: MultiplayerRunStatus;
  result?: MultiplayerRunResult;
  steps: MultiplayerStepV1[];
};

export type MultiplayerRoomV1 = {
  id: string;
  created_at: string;
  updated_at: string;
  owner_player_id: string;
  title?: string | null;
  start_article: string;
  destination_article: string;
  rules: MultiplayerRulesV1;
  status: MultiplayerRoomStatus;
  started_at?: string | null;
  finished_at?: string | null;
  players: MultiplayerPlayerV1[];
  runs: MultiplayerRunV1[];
};

export type CreateRoomRequest = {
  start_article: string;
  destination_article: string;
  title?: string;
  owner_name?: string;
  rules?: Partial<MultiplayerRulesV1>;
};

export type CreateRoomResponse = {
  room_id: string;
  owner_player_id: string;
  join_url: string;
  room: MultiplayerRoomV1;
};

export type JoinRoomRequest = {
  name: string;
};

export type JoinRoomResponse = {
  player_id: string;
  room: MultiplayerRoomV1;
};

export type StartRoomRequest = {
  player_id: string;
};

export type MoveRoomRequest = {
  player_id: string;
  to_article: string;
};

