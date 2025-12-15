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
  baseline_llm_run_id?: string
  runs: RunV1[]
}

export type RunKind = 'human' | 'llm'

export type RunStatus = 'running' | 'finished' | 'abandoned'

export type RunResult = 'win' | 'lose' | 'abandoned'

export type StepType = 'start' | 'move' | 'win' | 'lose'

export type StepV1 = {
  type: StepType
  article: string
  metadata?: Record<string, unknown>
}

export type RunV1 = {
  id: string
  kind: RunKind

  player_name?: string
  model?: string
  api_base?: string
  reasoning_effort?: string

  started_at: string
  finished_at?: string
  status: RunStatus

  result?: RunResult
  hops?: number
  duration_ms?: number

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
