import type { RunV1, SessionV1, SessionRulesV1, StepV1 } from "@/lib/session-types";

export type WinRunSummaryV1 = {
  schema_version: 1;
  recorded_at: string;

  session_id: string;
  session_title: string;
  start_article: string;
  destination_article: string;
  rules: SessionRulesV1 | null;

  run_id: string;
  finished_at: string | null;
  kind: RunV1["kind"];

  player_name: string | null;
  model: string | null;
  api_base: string | null;
  reasoning_effort: string | null;

  max_steps: number | null;
  max_links: number | null;
  max_tokens: number | null;

  hops: number | null;
  duration_ms: number | null;

  steps: StepV1[];
};

type StoreState = {
  summaries: WinRunSummaryV1[];
};

const STORAGE_KEY = "wikirace:win-summaries:v1";
const MAX_SUMMARIES = 200;

function nowIso() {
  return new Date().toISOString();
}

function safeParseJson<T>(value: string | null): T | null {
  if (!value) return null;
  try {
    return JSON.parse(value) as T;
  } catch {
    return null;
  }
}

function loadInitialState(): StoreState {
  const stored = safeParseJson<StoreState>(window.localStorage.getItem(STORAGE_KEY));
  if (!stored || !Array.isArray(stored.summaries)) {
    return { summaries: [] };
  }
  return stored;
}

let state: StoreState =
  typeof window === "undefined" ? { summaries: [] } : loadInitialState();

function persist() {
  window.localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
}

export function listWinRunSummaries() {
  return state.summaries;
}

export function addWinRunSummary({
  session,
  run,
}: {
  session: SessionV1;
  run: RunV1;
}) {
  if (typeof window === "undefined") return null;
  if (run.result !== "win") return null;

  const existingKey = `${session.id}:${run.id}`;
  const alreadyStored = state.summaries.some(
    (s) => `${s.session_id}:${s.run_id}` === existingKey
  );
  if (alreadyStored) return null;

  const summary: WinRunSummaryV1 = {
    schema_version: 1,
    recorded_at: nowIso(),

    session_id: session.id,
    session_title: session.title?.trim() ? session.title.trim() : `${session.start_article} → ${session.destination_article}`,
    start_article: session.start_article,
    destination_article: session.destination_article,
    rules: session.rules || null,

    run_id: run.id,
    finished_at: run.finished_at || null,
    kind: run.kind,

    player_name: run.player_name || null,
    model: run.kind === "llm" ? run.model || null : null,
    api_base: run.kind === "llm" ? run.api_base || null : null,
    reasoning_effort: run.kind === "llm" ? run.reasoning_effort || null : null,

    max_steps: typeof run.max_steps === "number" ? run.max_steps : null,
    max_links: typeof run.max_links === "number" ? run.max_links : null,
    max_tokens: typeof run.max_tokens === "number" ? run.max_tokens : null,

    hops: typeof run.hops === "number" ? run.hops : null,
    duration_ms: typeof run.duration_ms === "number" ? run.duration_ms : null,

    steps: Array.isArray(run.steps) ? run.steps : [],
  };

  state = {
    summaries: [summary, ...state.summaries].slice(0, MAX_SUMMARIES),
  };
  persist();
  return summary;
}

