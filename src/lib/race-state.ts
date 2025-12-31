import type { MultiplayerRoomV1 } from "@/lib/multiplayer-types";
import type { SessionRulesV1, SessionV1 } from "@/lib/session-types";
import { runDisplayName } from "@/lib/session-utils";

export type RaceMode = "local" | "multiplayer";

export type RaceStatus = "lobby" | "running" | "finished";

export type RaceRunStatus = "not_started" | "running" | "finished" | "abandoned";

export type RaceRunResult = "win" | "lose" | "abandoned";

export type RaceRules = {
  max_hops: number;
  max_links: number | null;
  max_tokens: number | null;
  include_image_links: boolean;
  disable_links_view: boolean;
};

export type RaceStep = {
  type: "start" | "move" | "win" | "lose";
  article: string;
  at?: string;
  metadata?: Record<string, unknown>;
};

export type RaceRun = {
  id: string;
  kind: "human" | "llm";
  display_name: string;

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
  status: RaceRunStatus;
  result?: RaceRunResult;

  hops?: number;
  duration_ms?: number;

  // Local-only (optional) timer metadata.
  timer_state?: string;
  active_ms?: number;
  last_resumed_at?: string;

  steps: RaceStep[];
};

export type RaceState = {
  mode: RaceMode;
  id: string;
  title?: string | null;

  human_timer?: {
    auto_start_on_first_action: boolean;
  };

  start_article: string;
  destination_article: string;
  rules: RaceRules;
  status: RaceStatus;

  owner_player_id?: string | null;
  you_player_id?: string | null;

  runs: RaceRun[];
};

const DEFAULT_RULES: SessionRulesV1 = {
  max_hops: 20,
  max_links: null,
  max_tokens: null,
  include_image_links: false,
  disable_links_view: false,
};

function normalizeRules(rules: SessionRulesV1 | null | undefined): RaceRules {
  const raw = rules ?? DEFAULT_RULES;
  return {
    max_hops: typeof raw.max_hops === "number" ? raw.max_hops : DEFAULT_RULES.max_hops,
    max_links: raw.max_links === null ? null : typeof raw.max_links === "number" ? raw.max_links : null,
    max_tokens: raw.max_tokens === null ? null : typeof raw.max_tokens === "number" ? raw.max_tokens : null,
    include_image_links: Boolean(raw.include_image_links),
    disable_links_view: Boolean(raw.disable_links_view),
  };
}

export function sessionToRaceState(session: SessionV1): RaceState {
  const rules = normalizeRules(session.rules);
  const runs = session.runs.map((run) => {
    const displayName = runDisplayName(run);
    return {
      id: run.id,
      kind: run.kind,
      display_name: displayName,
      player_name: run.player_name,
      model: run.model,
      api_base: run.api_base,
      reasoning_effort: run.reasoning_effort,
      max_steps: run.max_steps,
      max_links: typeof run.max_links === "number" ? run.max_links : run.max_links === null ? null : undefined,
      max_tokens: typeof run.max_tokens === "number" ? run.max_tokens : run.max_tokens === null ? null : undefined,
      started_at: run.started_at,
      finished_at: run.finished_at,
      status: run.status === "abandoned" ? "abandoned" : run.status,
      result: run.result,
      hops: run.hops,
      duration_ms: run.duration_ms,
      timer_state: run.timer_state,
      active_ms: run.active_ms,
      last_resumed_at: run.last_resumed_at,
      steps: run.steps as RaceStep[],
    } satisfies RaceRun;
  });

  const status: RaceStatus =
    runs.length === 0
      ? "lobby"
      : runs.some((r) => r.status === "running")
        ? "running"
        : "finished";

  return {
    mode: "local",
    id: session.id,
    title: session.title ?? null,
    human_timer: session.human_timer
      ? { auto_start_on_first_action: session.human_timer.auto_start_on_first_action }
      : undefined,
    start_article: session.start_article,
    destination_article: session.destination_article,
    rules,
    status,
    runs,
  };
}

export function roomToRaceState(room: MultiplayerRoomV1, youPlayerId: string | null): RaceState {
  const rules: RaceRules = {
    max_hops: room.rules.max_hops,
    max_links: room.rules.max_links,
    max_tokens: room.rules.max_tokens,
    include_image_links: Boolean(room.rules.include_image_links),
    disable_links_view: Boolean(room.rules.disable_links_view),
  };

  const runs = room.runs.map((run) => {
    const player = run.player_id
      ? room.players.find((p) => p.id === run.player_id)
      : null;

    const displayName =
      run.kind === "human"
        ? player?.name || run.player_name || "Human"
        : run.player_name || run.model || "AI";

    return {
      id: run.id,
      kind: run.kind,
      display_name: displayName,
      player_id: run.player_id,
      player_name: run.player_name,
      model: run.model,
      api_base: run.api_base,
      reasoning_effort: run.reasoning_effort,
      max_steps: run.max_steps,
      max_links: run.max_links === null ? null : typeof run.max_links === "number" ? run.max_links : undefined,
      max_tokens: run.max_tokens === null ? null : typeof run.max_tokens === "number" ? run.max_tokens : undefined,
      started_at: run.started_at,
      finished_at: run.finished_at,
      status: run.status,
      result: run.result,
      steps: run.steps as RaceStep[],
    } satisfies RaceRun;
  });

  return {
    mode: "multiplayer",
    id: room.id,
    title: room.title ?? null,
    start_article: room.start_article,
    destination_article: room.destination_article,
    rules,
    status: room.status,
    owner_player_id: room.owner_player_id,
    you_player_id: youPlayerId,
    runs,
  };
}
