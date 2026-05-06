import { useSyncExternalStore } from 'react'
import type {
  HumanTimerSettingsV1,
  RunResult,
  RunTimerStateV1,
  RunV1,
  SessionRulesV1,
  SessionExportV1,
  SessionSummary,
  SessionV1,
  StepV1,
} from '@/lib/session-types'
import { computeHops, finalizeRun, makeId, nowIso, sessionDisplayName } from '@/lib/session-utils'
import {
  safeLocalStorageGetItem,
  safeLocalStorageGetJsonWithStatus,
  safeLocalStorageRemoveItem,
  safeLocalStorageSetItem,
  safeLocalStorageSetJson,
} from '@/lib/storage'

type StoreState = {
  sessions: Record<string, SessionV1>
  active_session_id: string | null
  persistence_error: string | null
  persistence_notice: string | null
}

const SESSIONS_STORAGE_KEY = 'wikirace:sessions:v1'
const ACTIVE_SESSION_STORAGE_KEY = 'wikirace:active-session-id'
const SESSION_PERSIST_DEBOUNCE_MS = 250
const MAX_PERSISTED_SESSIONS = 20
const MAX_PERSISTED_METADATA_STRING_LENGTH = 4096
const MAX_PERSISTED_METADATA_DEPTH = 8

const EMPTY_STORE_STATE: StoreState = {
  sessions: {},
  active_session_id: null,
  persistence_error: null,
  persistence_notice: null,
}

const SESSION_PERSISTENCE_ERROR_MESSAGE =
  'Local race history could not be saved to browser storage. Runs stay available in this tab for export, but a refresh may drop recent changes.'
const SESSION_STORAGE_RECOVERY_NOTICE =
  'One or more malformed saved local race sessions were ignored so Play Game can load. Export any important runs that still appear, then refresh once if you want this warning to clear.'
let storageRecoveryNoticeActive = false

function buildPersistenceNotice(sessions: Record<string, SessionV1>) {
  const omittedCount = Math.max(0, Object.keys(sessions).length - MAX_PERSISTED_SESSIONS)
  if (omittedCount === 0) return null

  const sessionLabel = omittedCount === 1 ? 'session is' : 'sessions are'
  return `${omittedCount} older local race ${sessionLabel} still available in this tab, but only ${MAX_PERSISTED_SESSIONS} sessions are persisted to browser storage and those older sessions will not survive refresh. Export any runs you want to keep before reloading.`
}

const DEFAULT_SESSION_RULES: SessionRulesV1 = {
  max_hops: 20,
  max_links: null,
  max_tokens: null,
  include_image_links: false,
  disable_links_view: false,
}

function normalizeSessionRules(rules: unknown): SessionRulesV1 {
  const raw = rules as Partial<SessionRulesV1> | null | undefined

  const max_hops =
    typeof raw?.max_hops === 'number' && Number.isFinite(raw.max_hops) && raw.max_hops > 0
      ? raw.max_hops
      : DEFAULT_SESSION_RULES.max_hops

  const max_links =
    raw?.max_links === null
      ? null
      : typeof raw?.max_links === 'number' &&
          Number.isFinite(raw.max_links) &&
          raw.max_links > 0
        ? raw.max_links
        : DEFAULT_SESSION_RULES.max_links

  const max_tokens =
    raw?.max_tokens === null
      ? null
      : typeof raw?.max_tokens === 'number' &&
          Number.isFinite(raw.max_tokens) &&
          raw.max_tokens > 0
        ? raw.max_tokens
        : DEFAULT_SESSION_RULES.max_tokens

  const include_image_links =
    typeof raw?.include_image_links === 'boolean'
      ? raw.include_image_links
      : DEFAULT_SESSION_RULES.include_image_links

  const disable_links_view =
    typeof raw?.disable_links_view === 'boolean'
      ? raw.disable_links_view
      : DEFAULT_SESSION_RULES.disable_links_view

  return { max_hops, max_links, max_tokens, include_image_links, disable_links_view }
}

function normalizePositiveInt(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : undefined
}

function normalizeOptionalBudget(value: unknown): number | null | undefined {
  if (value === null) return null
  return normalizePositiveInt(value)
}

function normalizeRun(run: RunV1, startArticle: string): RunV1 {
  const normalizedSteps = ensureRunHasStartStep(run, startArticle).steps
  return {
    ...run,
    max_steps: normalizePositiveInt(run.max_steps),
    max_links: normalizeOptionalBudget(run.max_links),
    max_tokens: normalizeOptionalBudget(run.max_tokens),
    steps: normalizedSteps,
    hops: computeHops(normalizedSteps, startArticle),
  }
}

function ensureRunHasStartStep(run: RunV1, startArticle: string): RunV1 {
  if (run.steps[0]?.type === 'start') return run
  return {
    ...run,
    steps: [
      {
        type: 'start',
        article: startArticle,
        at: run.started_at,
      },
      ...run.steps,
    ],
  }
}

function normalizeSession(session: SessionV1): SessionV1 {
  return {
    ...session,
    rules: normalizeSessionRules(session.rules),
    runs: session.runs.map((run) => normalizeRun(run, session.start_article)),
  }
}

function sessionCreatedAtMs(session: SessionV1) {
  const timestamp = new Date(session.created_at).getTime()
  return Number.isFinite(timestamp) ? timestamp : 0
}

function compactPersistedString(value: string) {
  if (value.length <= MAX_PERSISTED_METADATA_STRING_LENGTH) return value
  const truncatedCount = value.length - MAX_PERSISTED_METADATA_STRING_LENGTH
  return `${value.slice(
    0,
    MAX_PERSISTED_METADATA_STRING_LENGTH
  )}\n\n[Truncated ${truncatedCount} chars in browser storage. Export this run before refreshing to keep the full in-memory output.]`
}

function compactMetadataForStorage(
  value: unknown,
  seen: WeakSet<object>,
  depth = 0
): unknown {
  if (typeof value === 'string') {
    return compactPersistedString(value)
  }

  if (!value || typeof value !== 'object') {
    return value
  }

  if (depth >= MAX_PERSISTED_METADATA_DEPTH) {
    return '[Nested metadata omitted in browser storage.]'
  }

  if (seen.has(value)) {
    return '[Repeated metadata reference omitted in browser storage.]'
  }

  seen.add(value)

  if (Array.isArray(value)) {
    return value.map((item) => compactMetadataForStorage(item, seen, depth + 1))
  }

  const compacted: Record<string, unknown> = {}
  for (const [key, nestedValue] of Object.entries(value as Record<string, unknown>)) {
    compacted[key] = compactMetadataForStorage(nestedValue, seen, depth + 1)
  }
  return compacted
}

function compactStepForStorage(step: StepV1): StepV1 {
  if (!step.metadata) return step
  return {
    ...step,
    metadata: compactMetadataForStorage(step.metadata, new WeakSet()) as Record<string, unknown>,
  }
}

function compactRunForStorage(run: RunV1): RunV1 {
  return {
    ...run,
    steps: run.steps.map(compactStepForStorage),
  }
}

function compactSessionForStorage(session: SessionV1): SessionV1 {
  return {
    ...session,
    runs: session.runs.map(compactRunForStorage),
  }
}

function buildPersistedSessionSnapshot(
  sessions: Record<string, SessionV1>,
  activeSessionId: string | null
) {
  const compactedSessions: Record<string, SessionV1> = {}
  const selected = new Set<string>()

  if (activeSessionId && sessions[activeSessionId]) {
    selected.add(activeSessionId)
    compactedSessions[activeSessionId] = compactSessionForStorage(sessions[activeSessionId])
  }

  const sessionsByRecency = Object.values(sessions).sort(
    (a, b) => sessionCreatedAtMs(b) - sessionCreatedAtMs(a)
  )
  for (const session of sessionsByRecency) {
    if (selected.size >= MAX_PERSISTED_SESSIONS) break
    if (selected.has(session.id)) continue
    selected.add(session.id)
    compactedSessions[session.id] = compactSessionForStorage(session)
  }

  return { sessions: compactedSessions }
}

function buildCombinedPersistenceNotice(
  sessions: Record<string, SessionV1>,
  storageRecoveryNotice: string | null
) {
  return (
    [storageRecoveryNotice, buildPersistenceNotice(sessions)]
      .filter((message): message is string => Boolean(message))
      .join(' ')
      .trim() || null
  )
}

function getPersistableActiveSessionId(
  sessions: Record<string, SessionV1>,
  activeSessionId: string | null
) {
  return activeSessionId && sessions[activeSessionId] ? activeSessionId : null
}

function writePersistedStateSnapshot({
  sessions,
  active_session_id,
}: {
  sessions: Record<string, SessionV1>
  active_session_id: string | null
}) {
  const persistableActiveSessionId = getPersistableActiveSessionId(sessions, active_session_id)
  const sessionsSaved = safeLocalStorageSetJson(
    SESSIONS_STORAGE_KEY,
    buildPersistedSessionSnapshot(sessions, persistableActiveSessionId)
  )
  const activeSessionSaved = persistableActiveSessionId
    ? safeLocalStorageSetItem(ACTIVE_SESSION_STORAGE_KEY, persistableActiveSessionId)
    : safeLocalStorageRemoveItem(ACTIVE_SESSION_STORAGE_KEY)

  return sessionsSaved && activeSessionSaved
}

function loadInitialState(): StoreState {
  const { value: stored, parseFailed: storedSessionsParseFailed } =
    safeLocalStorageGetJsonWithStatus<{ sessions: Record<string, SessionV1> }>(
      SESSIONS_STORAGE_KEY
    )

  const active_session_id = safeLocalStorageGetItem(ACTIVE_SESSION_STORAGE_KEY)

  const sessionsRaw = stored?.sessions || {}
  let changed = storedSessionsParseFailed
  let droppedInvalidSessions = storedSessionsParseFailed
  const sessions: Record<string, SessionV1> = {}

  for (const [id, session] of Object.entries(sessionsRaw)) {
    if (!isSessionV1(session)) {
      changed = true
      droppedInvalidSessions = true
      continue
    }

    const normalized = normalizeSession(session)
    sessions[id] = normalized

    const a = session.rules
    const b = normalized.rules
    const rulesChanged =
      !a ||
      a.max_hops !== b.max_hops ||
      a.max_links !== b.max_links ||
      a.max_tokens !== b.max_tokens ||
      a.include_image_links !== b.include_image_links ||
      a.disable_links_view !== b.disable_links_view
    if (rulesChanged) changed = true
  }

  const nextActiveSessionId = getPersistableActiveSessionId(
    sessions,
    active_session_id || null
  )

  let persistence_error: string | null = null
  if (stored || active_session_id || changed) {
    const persisted = writePersistedStateSnapshot({
      sessions,
      active_session_id: nextActiveSessionId,
    })
    persistence_error = persisted ? null : SESSION_PERSISTENCE_ERROR_MESSAGE
  }

  storageRecoveryNoticeActive = droppedInvalidSessions

  return {
    sessions,
    active_session_id: nextActiveSessionId,
    persistence_error,
    persistence_notice: buildCombinedPersistenceNotice(
      sessions,
      storageRecoveryNoticeActive ? SESSION_STORAGE_RECOVERY_NOTICE : null
    ),
  }
}

let state: StoreState =
  typeof window === 'undefined'
    ? EMPTY_STORE_STATE
    : loadInitialState()

const listeners = new Set<() => void>()
let persistTimerId: number | null = null
let persistLifecycleListenersInstalled = false

function emit() {
  for (const listener of listeners) listener()
}

function setPersistenceError(persistence_error: string | null) {
  if (state.persistence_error === persistence_error) return
  state = {
    ...state,
    persistence_error,
  }
  emit()
}

function persist() {
  if (typeof window === 'undefined') return
  if (persistTimerId !== null) {
    window.clearTimeout(persistTimerId)
    persistTimerId = null
  }
  const persisted = writePersistedStateSnapshot(state)
  setPersistenceError(persisted ? null : SESSION_PERSISTENCE_ERROR_MESSAGE)
}

function installPersistLifecycleListeners() {
  if (typeof window === 'undefined' || persistLifecycleListenersInstalled) return
  persistLifecycleListenersInstalled = true

  window.addEventListener('pagehide', persist)
  window.addEventListener('beforeunload', persist)
  if (typeof document !== 'undefined') {
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'hidden') {
        persist()
      }
    })
  }
}

function schedulePersist() {
  if (typeof window === 'undefined') return
  installPersistLifecycleListeners()
  if (persistTimerId !== null) {
    window.clearTimeout(persistTimerId)
  }
  persistTimerId = window.setTimeout(persist, SESSION_PERSIST_DEBOUNCE_MS)
}

function setState(next: StoreState) {
  state = {
    ...next,
    persistence_notice: buildCombinedPersistenceNotice(
      next.sessions,
      storageRecoveryNoticeActive ? SESSION_STORAGE_RECOVERY_NOTICE : null
    ),
  }
  if (typeof window !== 'undefined') {
    schedulePersist()
  }
  emit()
}

function updateSession(sessionId: string, updater: (session: SessionV1) => SessionV1) {
  const existing = state.sessions[sessionId]
  if (!existing) return null

  const updated = updater(existing)
  if (updated === existing) return existing
  setState({
    ...state,
    sessions: {
      ...state.sessions,
      [sessionId]: updated,
    },
  })

  return updated
}

export function createSession({
  startArticle,
  destinationArticle,
  title,
  rules,
  humanTimer,
}: {
  startArticle: string
  destinationArticle: string
  title?: string
  rules?: SessionRulesV1
  humanTimer?: HumanTimerSettingsV1
}) {
  const id = makeId('session')
  const created_at = nowIso()
  const normalizedRules = normalizeSessionRules(rules)
  const session: SessionV1 = {
    id,
    title,
    start_article: startArticle,
    destination_article: destinationArticle,
    created_at,
    rules: normalizedRules,
    human_timer: humanTimer,
    runs: [],
  }

  setState({
    ...state,
    active_session_id: id,
    sessions: {
      ...state.sessions,
      [id]: session,
    },
  })
  persist()

  return session
}

export function getOrCreateSession({
  startArticle,
  destinationArticle,
  title,
  rules,
  humanTimer,
}: {
  startArticle: string
  destinationArticle: string
  title?: string
  rules?: SessionRulesV1
  humanTimer?: HumanTimerSettingsV1
}) {
  const start = startArticle.trim()
  const destination = destinationArticle.trim()

  let match: SessionV1 | null = null
  for (const session of Object.values(state.sessions)) {
    if (session.start_article === start && session.destination_article === destination) {
      if (!match) {
        match = session
      } else if (new Date(session.created_at).getTime() > new Date(match.created_at).getTime()) {
        match = session
      }
    }
  }

  if (match) {
    const titleToUse = title?.trim()
    const shouldUpdateTitle =
      Boolean(titleToUse) && (!match.title || match.title.trim().length === 0)

    setState({
      ...state,
      active_session_id: match.id,
    })
    persist()

    if (shouldUpdateTitle) {
      return updateSession(match.id, (s) => ({ ...s, title: titleToUse }))!
    }

    return match
  }

  return createSession({
    startArticle: start,
    destinationArticle: destination,
    title,
    rules,
    humanTimer,
  })
}

export function setActiveSessionId(sessionId: string | null) {
  if (sessionId && !state.sessions[sessionId]) return
  setState({ ...state, active_session_id: sessionId })
  persist()
}

export function getActiveSessionId() {
  return state.active_session_id
}

export function getSession(sessionId: string) {
  return state.sessions[sessionId] || null
}

export function listSessions(): SessionSummary[] {
  const sessions = Object.values(state.sessions)
  sessions.sort(
    (a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime()
  )

  return sessions.map((s) => ({
    id: s.id,
    title: sessionDisplayName(s),
    start_article: s.start_article,
    destination_article: s.destination_article,
    created_at: s.created_at,
    run_count: s.runs.length,
  }))
}

export function startHumanRun({
  sessionId,
  playerName,
  maxSteps,
  startedAtIso,
}: {
  sessionId: string
  playerName: string
  maxSteps?: number
  startedAtIso?: string
}) {
  const session = state.sessions[sessionId]
  if (!session) throw new Error('Session not found')

  const timer_state: RunTimerStateV1 = 'not_started'
  const started_at = startedAtIso || nowIso()
  const run: RunV1 = {
    id: makeId('run_human'),
    kind: 'human',
    player_name: playerName,
    max_steps: typeof maxSteps === 'number' ? maxSteps : undefined,
    started_at,
    status: 'running',
    timer_state,
    active_ms: 0,
    steps: [{ type: 'start', article: session.start_article, at: started_at }],
  }

  updateSession(sessionId, (s) => ({ ...s, runs: [...s.runs, run] }))
  return run
}

export function startLlmRun({
  sessionId,
  model,
  playerName,
  apiBase,
  openaiApiMode,
  openaiReasoningEffort,
  openaiReasoningSummary,
  anthropicThinkingBudgetTokens,
  googleThinkingConfig,
  maxSteps,
  maxLinks,
  maxTokens,
  isBaseline,
  startedAtIso,
}: {
  sessionId: string
  model: string
  playerName?: string
  apiBase?: string
  openaiApiMode?: string
  openaiReasoningEffort?: string
  openaiReasoningSummary?: string
  anthropicThinkingBudgetTokens?: number
  googleThinkingConfig?: Record<string, unknown>
  maxSteps?: number
  maxLinks?: number | null
  maxTokens?: number | null
  isBaseline?: boolean
  startedAtIso?: string
}) {
  const session = state.sessions[sessionId]
  if (!session) throw new Error('Session not found')

  const started_at = startedAtIso || nowIso()

  const run: RunV1 = {
    id: makeId(isBaseline ? 'run_llm_baseline' : 'run_llm'),
    kind: 'llm',
    player_name: playerName?.trim() ? playerName.trim() : undefined,
    model,
    api_base: apiBase || undefined,
    openai_api_mode: openaiApiMode || undefined,
    openai_reasoning_effort: openaiReasoningEffort || undefined,
    openai_reasoning_summary: openaiReasoningSummary || undefined,
    anthropic_thinking_budget_tokens:
      typeof anthropicThinkingBudgetTokens === 'number'
        ? anthropicThinkingBudgetTokens
        : undefined,
    google_thinking_config: googleThinkingConfig || undefined,
    max_steps: typeof maxSteps === 'number' ? maxSteps : undefined,
    max_links:
      maxLinks === null ? null : typeof maxLinks === 'number' ? maxLinks : undefined,
    max_tokens:
      maxTokens === null ? null : typeof maxTokens === 'number' ? maxTokens : undefined,
    started_at,
    status: 'running',
    steps: [{ type: 'start', article: session.start_article, at: started_at }],
  }

  updateSession(sessionId, (s) => {
    const next: SessionV1 = { ...s, runs: [...s.runs, run] }
    if (isBaseline && !s.baseline_llm_run_id) {
      next.baseline_llm_run_id = run.id
    }
    return next
  })

  return run
}

function pauseHumanTimer(run: RunV1, atIso: string): RunV1 {
  if (run.kind !== 'human') return run
  if (run.status !== 'running') return run
  if (!run.timer_state) return run
  if (run.timer_state !== 'running') return run

  const lastResumedAt = run.last_resumed_at
  const deltaMs = lastResumedAt
    ? new Date(atIso).getTime() - new Date(lastResumedAt).getTime()
    : 0
  const activeMs = (typeof run.active_ms === 'number' ? run.active_ms : 0) + Math.max(0, deltaMs)

  return {
    ...run,
    timer_state: 'paused',
    active_ms: Math.max(0, activeMs),
    last_resumed_at: undefined,
  }
}

function resumeHumanTimer(run: RunV1, atIso: string): RunV1 {
  if (run.kind !== 'human') return run
  if (run.status !== 'running') return run
  if (!run.timer_state) return run
  if (run.timer_state === 'running') return run

  return {
    ...run,
    timer_state: 'running',
    last_resumed_at: atIso,
    active_ms: typeof run.active_ms === 'number' ? run.active_ms : 0,
  }
}

export function pauseHumanTimers({
  sessionId,
  exceptRunId,
  pausedAtIso,
}: {
  sessionId: string
  exceptRunId?: string | null
  pausedAtIso?: string
}) {
  const atIso = pausedAtIso || nowIso()
  return updateSession(sessionId, (s) => {
    let changed = false
    const nextRuns = s.runs.map((run) => {
      if (run.kind !== 'human') return run
      if (exceptRunId && run.id === exceptRunId) return run
      const next = pauseHumanTimer(run, atIso)
      if (next !== run) changed = true
      return next
    })

    if (!changed) return s
    return { ...s, runs: nextRuns }
  })
}

export function resumeHumanTimerForRun({
  sessionId,
  runId,
  resumedAtIso,
}: {
  sessionId: string
  runId: string
  resumedAtIso?: string
}) {
  const atIso = resumedAtIso || nowIso()
  return updateSession(sessionId, (s) => {
    let changed = false
    const nextRuns = s.runs.map((run) => {
      if (run.id !== runId) return run
      const next = resumeHumanTimer(run, atIso)
      if (next !== run) changed = true
      return next
    })

    if (!changed) return s
    return { ...s, runs: nextRuns }
  })
}

export function pauseHumanTimerForRun({
  sessionId,
  runId,
  pausedAtIso,
}: {
  sessionId: string
  runId: string
  pausedAtIso?: string
}) {
  const atIso = pausedAtIso || nowIso()
  return updateSession(sessionId, (s) => {
    let changed = false
    const nextRuns = s.runs.map((run) => {
      if (run.id !== runId) return run
      const next = pauseHumanTimer(run, atIso)
      if (next !== run) changed = true
      return next
    })

    if (!changed) return s
    return { ...s, runs: nextRuns }
  })
}

export function ensureBaselineLlmRun({
  sessionId,
  model,
  apiBase,
  startedAtIso,
}: {
  sessionId: string
  model: string
  apiBase?: string
  startedAtIso?: string
}) {
  const session = state.sessions[sessionId]
  if (!session) throw new Error('Session not found')

  if (session.baseline_llm_run_id) {
    const existing = session.runs.find((r) => r.id === session.baseline_llm_run_id)
    return existing || null
  }

  return startLlmRun({
    sessionId,
    model,
    apiBase,
    isBaseline: true,
    startedAtIso,
  })
}

export function appendRunStep({
  sessionId,
  runId,
  step,
}: {
  sessionId: string
  runId: string
  step: StepV1
}) {
  const normalizedStep: StepV1 =
    typeof step.at === 'string' && step.at.length > 0
      ? step
      : { ...step, at: nowIso() }

  return updateSession(sessionId, (s) => ({
    ...s,
    runs: s.runs.map((run) => {
      if (run.id !== runId) return run
      if (run.status !== 'running') return run
      return { ...run, steps: [...run.steps, normalizedStep] }
    }),
  }))
}

export function finishRun({
  sessionId,
  runId,
  result,
  finishedAtIso,
}: {
  sessionId: string
  runId: string
  result: RunResult
  finishedAtIso?: string
}) {
  return updateSession(sessionId, (s) => ({
    ...s,
    runs: s.runs.map((run) => {
      if (run.id !== runId) return run
      if (run.status !== 'running') return run
      return finalizeRun(run, result, finishedAtIso, s.start_article)
    }),
  }))
}

export function forceWinRun({
  sessionId,
  runId,
  finishedAtIso,
}: {
  sessionId: string
  runId: string
  finishedAtIso?: string
}) {
  const finished_at = finishedAtIso || nowIso()
  return updateSession(sessionId, (s) => ({
    ...s,
    runs: s.runs.map((run) => {
      if (run.id !== runId) return run
      if (run.status !== 'running') return run

      const steps: StepV1[] =
        run.steps.length > 0
          ? [...run.steps]
          : [{ type: 'start', article: s.start_article }]
      const lastIndex = steps.length - 1
      const last = steps[lastIndex]
      steps[lastIndex] = {
        ...last,
        type: 'win',
        article: s.destination_article,
        at: finished_at,
      }

      return finalizeRun({ ...run, steps }, 'win', finished_at, s.start_article)
    }),
  }))
}

export function abandonRun({ sessionId, runId }: { sessionId: string; runId: string }) {
  const session = state.sessions[sessionId]
  const run = session?.runs.find((r) => r.id === runId)
  const lastArticle = run?.steps?.[run.steps.length - 1]?.article

  if (lastArticle) {
    appendRunStep({
      sessionId,
      runId,
      step: {
        type: 'lose',
        article: lastArticle,
        metadata: { abandoned: true, reason: 'abandoned' },
      },
    })
  }

  return finishRun({ sessionId, runId, result: 'abandoned' })
}

export function deleteRuns({
  sessionId,
  runIds,
}: {
  sessionId: string
  runIds: string[]
}) {
  const runIdSet = new Set(runIds)
  return updateSession(sessionId, (s) => {
    const nextRuns = s.runs.filter((run) => !runIdSet.has(run.id))
    const next: SessionV1 = { ...s, runs: nextRuns }

    if (next.baseline_llm_run_id && runIdSet.has(next.baseline_llm_run_id)) {
      delete next.baseline_llm_run_id
    }

    return next
  })
}


export function exportSession(sessionId: string): SessionExportV1 {
  const session = state.sessions[sessionId]
  if (!session) throw new Error('Session not found')
  return {
    schema_version: 1,
    exported_at: nowIso(),
    session,
  }
}

function isStepV1(value: unknown): value is StepV1 {
  if (!value || typeof value !== 'object') return false
  const v = value as StepV1
  return typeof v.type === 'string' && typeof v.article === 'string'
}

function isRunV1(value: unknown): value is RunV1 {
  if (!value || typeof value !== 'object') return false
  const v = value as RunV1
  if (typeof v.id !== 'string') return false
  if (v.kind !== 'human' && v.kind !== 'llm') return false
  if (typeof v.started_at !== 'string') return false
  if (v.status !== 'running' && v.status !== 'finished' && v.status !== 'abandoned') {
    return false
  }
  if (!Array.isArray(v.steps) || !v.steps.every(isStepV1)) return false
  return true
}

function isSessionV1(value: unknown): value is SessionV1 {
  if (!value || typeof value !== 'object') return false
  const v = value as SessionV1
  if (typeof v.id !== 'string') return false
  if (typeof v.start_article !== 'string') return false
  if (typeof v.destination_article !== 'string') return false
  if (typeof v.created_at !== 'string') return false
  if (!Array.isArray(v.runs) || !v.runs.every(isRunV1)) return false
  return true
}

export function importSessionExport(
  exportObj: unknown,
  options?: { replaceExisting?: boolean }
): { sessionId: string } {
  const obj = exportObj as SessionExportV1
  if (!obj || typeof obj !== 'object') throw new Error('Invalid JSON')
  if (obj.schema_version !== 1) throw new Error('Unsupported session schema_version')
  if (!isSessionV1(obj.session)) throw new Error('Invalid session payload')

  const incoming = normalizeSession(obj.session)
  const exists = Boolean(state.sessions[incoming.id])
  const replaceExisting = Boolean(options?.replaceExisting)

  let sessionToStore: SessionV1 = incoming
  if (exists && !replaceExisting) {
    const newId = makeId('session')
    sessionToStore = {
      ...incoming,
      id: newId,
      title: incoming.title ? `${incoming.title} (imported)` : undefined,
    }
  }

  setState({
    ...state,
    active_session_id: sessionToStore.id,
    sessions: {
      ...state.sessions,
      [sessionToStore.id]: sessionToStore,
    },
  })
  persist()

  return { sessionId: sessionToStore.id }
}

export function subscribeSessions(listener: () => void) {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

export function getSessionsSnapshot() {
  return state
}

export function useSessionsStore() {
  return useSyncExternalStore<StoreState>(
    subscribeSessions,
    getSessionsSnapshot,
    () => EMPTY_STORE_STATE
  )
}
