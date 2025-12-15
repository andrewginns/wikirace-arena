import type { RunResult, RunV1, SessionV1, StepV1 } from '@/lib/session-types'

export function nowIso() {
  return new Date().toISOString()
}

export function makeId(prefix: string) {
  const randomId =
    typeof crypto !== 'undefined' && crypto.randomUUID
      ? crypto.randomUUID()
      : `${Date.now()}-${Math.random().toString(16).slice(2)}`
  return `${prefix}_${randomId}`
}

export function computeHops(steps: StepV1[]) {
  return Math.max(0, steps.length - 1)
}

export function finalizeRun(run: RunV1, result: RunResult, finishedAtIso?: string) {
  const finished_at = finishedAtIso || nowIso()
  const duration_ms =
    new Date(finished_at).getTime() - new Date(run.started_at).getTime()

  return {
    ...run,
    status: result === 'abandoned' ? 'abandoned' : 'finished',
    result,
    finished_at,
    hops: computeHops(run.steps),
    duration_ms: Math.max(0, duration_ms),
  } satisfies RunV1
}

export function runDisplayName(run: RunV1) {
  if (run.kind === 'human') return run.player_name || 'Human'
  const model = run.model || 'LLM'
  const effort = run.reasoning_effort?.trim()
  if (effort) return `${model} (${effort})`
  return model
}

export function sessionDisplayName(session: SessionV1) {
  if (session.title && session.title.trim().length > 0) return session.title
  return `${session.start_article} → ${session.destination_article}`
}

export function viewerResultFromRun(run: RunV1) {
  if (run.result === 'abandoned') return 'lose'
  return run.result || 'lose'
}
