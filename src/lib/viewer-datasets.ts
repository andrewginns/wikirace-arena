import { useSyncExternalStore } from 'react'

export type ViewerDatasetRecord = {
  id: string
  name: string
  created_at: string
  data: unknown
}

type StoreState = {
  datasets: ViewerDatasetRecord[]
}

const STORAGE_KEY = 'wikirace:viewer-datasets:v1'

function safeParseJson<T>(value: string | null): T | null {
  if (!value) return null
  try {
    return JSON.parse(value) as T
  } catch {
    return null
  }
}

function loadInitialState(): StoreState {
  const stored = safeParseJson<StoreState>(window.localStorage.getItem(STORAGE_KEY))
  if (!stored || !Array.isArray(stored.datasets)) {
    return { datasets: [] }
  }
  return stored
}

let state: StoreState = typeof window === 'undefined' ? { datasets: [] } : loadInitialState()

const listeners = new Set<() => void>()

function emit() {
  for (const listener of listeners) listener()
}

function persist() {
  window.localStorage.setItem(STORAGE_KEY, JSON.stringify(state))
}

function setState(next: StoreState) {
  state = next
  if (typeof window !== 'undefined') {
    persist()
  }
  emit()
}

function nowIso() {
  return new Date().toISOString()
}

function makeId(prefix: string) {
  const randomId =
    typeof crypto !== 'undefined' && crypto.randomUUID
      ? crypto.randomUUID()
      : `${Date.now()}-${Math.random().toString(16).slice(2)}`
  return `${prefix}_${randomId}`
}

export function addViewerDataset({ name, data }: { name: string; data: unknown }) {
  const record: ViewerDatasetRecord = {
    id: makeId('viewer_dataset'),
    name,
    created_at: nowIso(),
    data,
  }
  setState({ datasets: [record, ...state.datasets] })
  return record
}

export function removeViewerDataset(id: string) {
  setState({ datasets: state.datasets.filter((d) => d.id !== id) })
}

export function listViewerDatasets() {
  return state.datasets
}

export function subscribeViewerDatasets(listener: () => void) {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

export function getViewerDatasetsSnapshot() {
  return state
}

export function useViewerDatasetsStore() {
  return useSyncExternalStore(
    subscribeViewerDatasets,
    getViewerDatasetsSnapshot,
    () => ({ datasets: [] })
  )
}

