import {
  benchmarkEntryDisplayLabel,
  isBenchmarkLeaderboardV2,
  type BenchmarkLeaderboardEntryV2,
} from "@/lib/benchmark-leaderboard";

export type ViewerTraceDataset = {
  name: string;
  data: unknown;
};

export type BenchmarkViewerTraceSource = {
  id: string;
  name: string;
  url: string;
  sliceId: string | null;
};

type ViewerTraceData = {
  runs: Array<Record<string, unknown>>;
  benchmark_meta?: Record<string, unknown>;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function safeString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value : null;
}

function getRunKind(entry: BenchmarkLeaderboardEntryV2): string | null {
  const settings = entry.summary?.meta?.model_settings;
  const first = Array.isArray(settings) ? settings[0] : settings;
  return safeString(first?.run_kind);
}

function dedupeName(baseName: string, counts: Map<string, number>) {
  const count = counts.get(baseName) ?? 0;
  counts.set(baseName, count + 1);
  return count === 0 ? baseName : `${baseName} (${count + 1})`;
}

function assertViewerTraceData(raw: unknown): ViewerTraceData {
  if (!isRecord(raw) || !Array.isArray(raw.runs)) {
    throw new Error("Run trace data is missing a top-level runs[] array.");
  }

  return raw as ViewerTraceData;
}

export function buildViewerTraceDataset({
  raw,
  name,
  sliceId = null,
}: {
  raw: unknown;
  name: string;
  sliceId?: string | null;
}): ViewerTraceDataset {
  const rawDataset = assertViewerTraceData(raw);
  let data: unknown = rawDataset;

  if (sliceId) {
    const filteredRuns = rawDataset.runs.filter(
      (run) => isRecord(run) && run.slice_id === sliceId
    );
    if (filteredRuns.length === 0) {
      throw new Error(`Run trace data does not contain runs for task group ${sliceId}.`);
    }

    const benchmarkMeta =
      rawDataset.benchmark_meta && isRecord(rawDataset.benchmark_meta)
        ? {
            ...rawDataset.benchmark_meta,
            slice_ids: [sliceId],
          }
        : rawDataset.benchmark_meta;

    data = {
      ...rawDataset,
      runs: filteredRuns,
      benchmark_meta: benchmarkMeta,
    };
  }

  return { name, data };
}

export async function loadViewerTraceDataset({
  url,
  name,
  sliceId = null,
  signal,
}: {
  url: string;
  name: string;
  sliceId?: string | null;
  signal?: AbortSignal;
}): Promise<ViewerTraceDataset> {
  const response = await fetch(url, { signal });
  if (!response.ok) {
    throw new Error(`Failed to load run trace data (${response.status})`);
  }

  const raw = (await response.json()) as unknown;
  return buildViewerTraceDataset({ raw, name, sliceId });
}

export async function loadBenchmarkViewerTraceSources({
  leaderboardUrl = "/benchmarks/leaderboard.json",
  signal,
}: {
  leaderboardUrl?: string;
  signal?: AbortSignal;
} = {}): Promise<BenchmarkViewerTraceSource[]> {
  const response = await fetch(leaderboardUrl, { signal });
  if (!response.ok) {
    throw new Error(`Failed to load benchmark leaderboard (${response.status})`);
  }

  const raw = (await response.json()) as unknown;
  if (!isBenchmarkLeaderboardV2(raw)) {
    return [];
  }

  const nameCounts = new Map<string, number>();
  return raw.entries
    .filter((entry) => {
      const runKind = getRunKind(entry);
      return safeString(entry.viewer_url) && runKind !== "human";
    })
    .map((entry, index) => {
      const label = benchmarkEntryDisplayLabel(entry);
      const name = dedupeName(`Benchmark: ${label}`, nameCounts);
      const url = safeString(entry.viewer_url)!;
      return {
        id: `benchmark:${url}:${index}`,
        name,
        url,
        sliceId: null,
      };
    });
}
