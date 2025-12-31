export type SessionExportV1 = {
  schema_version: 1
  exported_at: string
  session: SessionV1
}

export type SessionV1 = {
  id: string
  title?: string
  start_article: string
  destination_article: string
  created_at: string
  rules?: SessionRulesV1
  human_timer?: HumanTimerSettingsV1
  baseline_llm_run_id?: string
  runs: RunV1[]
}

export type SessionRulesV1 = {
  max_hops: number
  max_links: number | null
  max_tokens: number | null
  include_image_links: boolean
  disable_links_view: boolean
}

export type HumanTimerSettingsV1 = {
  auto_start_on_first_action: boolean
}

export type RunKind = 'human' | 'llm'

export type RunStatus = 'running' | 'finished' | 'abandoned'

export type RunResult = 'win' | 'lose' | 'abandoned'

export type StepType = 'start' | 'move' | 'win' | 'lose'

export type StepV1 = {
  type: StepType
  article: string
  at?: string
  metadata?: Record<string, unknown>
}

export type RunTimerStateV1 = 'not_started' | 'running' | 'paused'

export type RunV1 = {
  id: string
  kind: RunKind

  player_name?: string
  model?: string
  api_base?: string
  reasoning_effort?: string

  max_steps?: number
  max_links?: number | null
  max_tokens?: number | null

  started_at: string
  finished_at?: string
  status: RunStatus

  result?: RunResult
  hops?: number
  duration_ms?: number

  // Human active-time tracking (hotseat). When absent, fall back to wall clock.
  timer_state?: RunTimerStateV1
  active_ms?: number
  last_resumed_at?: string

  steps: StepV1[]
}

export type SessionSummary = {
  id: string
  title: string
  start_article: string
  destination_article: string
  created_at: string
  run_count: number
}
