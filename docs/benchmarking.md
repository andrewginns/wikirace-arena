# WikiRacing Arena — Unified LLM Benchmarking Plan

---

## 1) Goals / Non‑Goals

Status note:
- The benchmark package now emits canonical `run + step + attempt` records, supports `import-session` for exported game sessions, and publishes leaderboard JSON with slice-aware metrics plus behavior/weakness analysis.
- The canonical fixed suite is `benchmarks/matchups/frontier_local_simplewiki_standard_v1/`, including `all.jsonl` plus `hard99.jsonl` and `companion101.jsonl` for Frontier 200 reruns.
- Feasibility for the shipped graph-native suite is available via `python -m parallel_eval.benchmark probe-fixed-suite --suite-id frontier_local_simplewiki_standard_v1`.
- Official suite generation and published leaderboard runs should use the frozen benchmark DB at `parallel_eval/releases/wikihop-benchmark-simplewiki-20260123.db`.

### Goals (v1)

- **Reproducible** model comparisons on a fixed, versioned task suite.
- **UI + CLI parity**: any AI run done via the UI can be converted into benchmark artifacts.
- **Challenging, high‑ceiling** benchmark (tiered matchups; frontier tier stays unsaturated).
- **Artifact-first telemetry**: tokens/latency/settings live in files (not just Logfire traces).
- **Stable scoring**: multi-metric reporting + a composite score with explicit, versioned weights.

### Non-goals (v1)

- A general web/tool agent benchmark track (we’ll add a separate track later).
- Global shortest-path ground truth for the entire DB (we’ll compute for shipped pairs when feasible).
- Requiring external observability backends for “official” results (Logfire remains optional).

---

## 2) Big Fork Decisions (Final)

These are the choices that define the unified benchmark architecture.

1) **Agent track(s)**
   - **Decision:** Benchmark the current **choose-link agent** only (LLM selects `<answer>N</answer>` from outgoing link titles).
   - **Later:** Add a **tool-augmented** track (separate leaderboard; not comparable).

2) **Ground-truth path length**
   - **Decision:** Use **proxy metrics** now (win rate / hops / tokens / time), but **compute exact shortest-path hops for shipped benchmark pairs when feasible** and store it as optional metadata.
   - **Avoid:** “Human baseline” as a required dependency for v1.

3) **Benchmark suite size**
   - **Decision:** Ship **Frontier 200** as the canonical tracked suite, with optional local smoke datasets for quick iteration.
   - **Later:** Grow toward 1000+ only after the pipeline is stable.

4) **How we select “hard” matchups**
   - **Decision:** **Hybrid**:
     - graph-driven candidate filtering (dead-ends + hub management)
     - distance-based selection for shipped pairs (forward BFS exact within a cap)
     - optional empirical screening to ensure frontier tier stays hard

5) **Hub policy**
   - **Decision:** **Exclude hubs as start/target** (dataset-fixed hub list), but allow hubs as intermediates in the main track.
   - **Later:** Add an **anti-hub track** (bans/penalties) for more headroom.

6) **Telemetry source of truth**
   - **Decision:** **Local artifacts** are the benchmark record of truth (canonical JSONL).
   - **Optional:** Logfire traces remain useful for debugging/perf breakdowns.

7) **UI benchmark capture**
   - **Decision:** Start with **artifact-based ingestion**:
     - Use existing **Arena export → Viewer JSON** as the UI artifact.
     - Provide a CLI importer: Viewer JSON → canonical benchmark JSONL.
   - **Later (optional):** Server-side auto-logging behind `WIKIRACE_BENCHMARK_LOG_DIR=...`.

8) **Leaderboard philosophy**
   - **Decision:** Provide **multi-metric reporting** + **composite score**.
   - Prefer **per-matchup scoring** aggregated by tier, with stable weights per dataset+track.

9) **Testing bar**
   - **Decision:** Add minimal but real tests early:
     - synthetic-graph BFS tests
     - scoring edge cases
     - schema round-trip tests (JSONL → summary → viewer JSON)

---

## 3) Where This Fits in the Current Codebase

### Existing runners / data flows

- **Server (UI runs):**
  - Local AI: `POST /llm/local_run/step` in `api.py` (uses PydanticAI via `llm_client.py`)
  - Multiplayer AI: server-side `_run_llm_room_task` in `api.py`
  - Token usage already flows into step metadata for server runs when providers return it.
- **CLI/batch:**
  - `parallel_eval/game.py` (single run)
  - `parallel_eval/proctor.py` (cross-product batch eval)
  - These currently produce viewer-compatible JSON but **do not reliably persist tokens/latency** in artifacts.
- **UI export:**
  - `src/components/race/race-arena.tsx` can export **Viewer JSON** and save to the in-browser viewer.

### Important gap to close (v1)

- **Step latency is not consistently present in artifacts today** (though it’s visible in Logfire traces). v1 requires explicit `latency_ms` measurement around model calls in both server and CLI.

---

## 4) Unified Architecture (Artifacts + Modules)

### 4.1 Artifacts (the contract)

**Dataset (versioned, in repo)**
- `benchmarks/matchups/frontier_local_simplewiki_standard_v1/all.jsonl` (Frontier 200)
- `benchmarks/matchups/frontier_local_simplewiki_standard_v1/hard99.jsonl`
- `benchmarks/matchups/frontier_local_simplewiki_standard_v1/companion101.jsonl`
- `benchmarks/matchups/frontier_local_simplewiki_standard_v1/benchmark_metadata.json` (provenance + composition)

**Run records (source of truth)**
- `results/benchmarks/<auto>.jsonl` (canonical JSONL; auto-named by default, includes model/budget metadata)

**Derived outputs**
- `results/benchmarks/<run_id>.summary.json` (metrics + per-tier breakdowns + weights)
- `results/benchmarks/<run_id>.viewer.json` (compatible with the existing View Runs UI)
- Optional snapshots:
  - `results/benchmarks/leaderboard.json`
  - `results/benchmarks/leaderboard.md`

### 4.2 Implementation modules (Python)

Add a first-class benchmark package:

- `parallel_eval/benchmark/`
  - `schema.py` — Pydantic models for dataset + run records + summary.
  - `prompt.py` — canonical prompt builder + answer parser (shared by CLI + `api.py` to prevent drift).
  - `graph.py` — DB readers, degree/hub computation, BFS distance utilities.
  - `matchups.py` — dataset generator + validators.
  - `runner.py` — runs a dataset for a model and writes JSONL + derived outputs.
  - `import_viewer.py` — converts exported Viewer JSON into canonical JSONL.
  - `scoring.py` — per-matchup scoring + aggregation + composite score.
  - `__main__.py` — CLI entrypoint (`python -m parallel_eval.benchmark ...`).

---

## 5) Dataset Design (Hard Matchups)

### 5.1 Matchup JSONL format

One JSON object per line:

```json
{"id":"v1-hard-0137","tier":"hard","start":"Capybara","target":"Pokémon","tags":["nonhub"],"shortest_path_hops":null}
```

Tier values: `baseline | hard | frontier`.

Dataset metadata goes into `benchmarks/matchups/v1.meta.json`:
- `created_at`
- DB provenance (dump wiki/date if known; `db_sha256` if available)
- hub list parameters + hub list hash
- generator version (git SHA or semantic version)
- selection caps (e.g. BFS max depth)

### 5.2 Hybrid generation algorithm (v1)

1) **Graph stats**
   - Build degree stats from `wikihop.db` (`core_articles(title, links_json)`):
     - out-degree (direct)
     - in-degree (one pass counting link occurrences)
   - Identify a hub list:
     - top-K by out-degree and top-K by in-degree (configurable)
   - Identify dead-ends (0 outgoing links) and exclude from candidates.

2) **Candidate pools**
   - Start/target candidates = non-dead-end nodes excluding hubs.
   - Optional filtering:
     - exclude extremely low-degree nodes (brittle / too many forced moves)
     - exclude near-hubs above a degree threshold

3) **Distance-based selection for shipped pairs**
   - Sample candidate start/target pairs.
   - Compute exact shortest-path distance with **forward BFS up to a cap** (e.g. 20–30).
     - Note: bidirectional BFS would require an incoming-edge index; we can add that as an optimization later.
   - Keep solvable pairs with long distances to populate `hard` and `frontier`.

4) **Empirical screening (recommended for frontier)**
   - Run a strong reference model under fixed budgets and keep pairs with:
     - low win rate, or
     - high cost (tokens/time) even when solved
   - This keeps the frontier tier challenging without relying purely on graph heuristics.

5) **Finalize tier quotas**
   - For ~200 pairs (illustrative):
     - 60 baseline, 90 hard, 50 frontier

### 5.3 Hub policy (main track)

- Hubs are **not allowed** as start/target in v1 dataset generation.
- Hubs are allowed as intermediates (no bans), keeping the benchmark close to “the shipped game.”

Later track: **anti_hub** (explicit bans/penalties on hub intermediates).

---

## 6) Canonical Benchmark Run Schema (JSONL)

We store two record types in a single `.jsonl` file:

### 6.1 `run` record (one per attempt)

Required fields (v1):
- `type: "run"`
- `run_id`
- `dataset_id` (e.g. `matchups/v1`)
- `matchup_id`
- `tier`
- model identity: `model`, `api_base` (nullable), provider overrides (nullable)
- budgets: `max_hops`, `max_links`, `max_tokens` (nullable)
- outcome: `result` (`win|lose`), `hops`, `duration_ms`
- totals: `prompt_tokens`, `completion_tokens`, `total_tokens` (nullable)
- totals: `llm_latency_ms` (nullable)
- provenance: `git_sha`, DB provenance (e.g. `db_sha256` or dump date)

### 6.2 `step` record (one per LLM decision)

Required fields (v1):
- `type: "step"`
- `run_id`
- `hop` (1-based hop index)
- `at` (ISO timestamp)
- `step_type` (`move|win|lose`)
- `article`
- choice: `selected_index` (nullable), `tries`, `answer_errors` (nullable)
- usage: `prompt_tokens`, `completion_tokens`, `total_tokens` (nullable)
- `latency_ms` (nullable but required when measurable)

### 6.3 Storage policy for raw LLM outputs

- Default: do **not** store `llm_output` (or store truncated, disabled by default).
- Provide a debug flag to include it (with truncation) for research runs.

---

## 7) CLI UX (Single Entry Point)

Fetch the frozen benchmark DB before running the official suite:

- `scripts/fetch-benchmark-db.sh --tag benchmark-db-simplewiki-20260123 --asset-base wikihop-benchmark-simplewiki-20260123 --out parallel_eval/releases/wikihop-benchmark-simplewiki-20260123.db`

All benchmark operations are under one CLI namespace:

- Run a dataset:
  - `uv run python -m parallel_eval.benchmark run --dataset benchmarks/matchups/frontier_local_simplewiki_standard_v1/all.jsonl --model openai-responses:gpt-5.2`
    - Prints the output JSONL path (defaults to an auto-generated name under `results/benchmarks/`).
    - Use `--out ...` to force a specific filename (errors if it already exists unless `--overwrite`).
- Summarize:
  - `uv run python -m parallel_eval.benchmark summarize results/benchmarks/<run_id>.jsonl`
- Import UI runs (Viewer JSON):
  - `uv run python -m parallel_eval.benchmark import-viewer viewer-export.json --dataset benchmarks/matchups/frontier_local_simplewiki_standard_v1/all.jsonl`

- Build a leaderboard across many model runs:
  - `uv run python -m parallel_eval.benchmark leaderboard --inputs $(find results/benchmarks -name records.jsonl -print) --out results/benchmarks/leaderboard.json`

The runner always writes derived outputs (`.summary.json` + `.viewer.json`) so the existing **View Runs** UI can load them.

---

## 8) UI Integration (v1)

No new API endpoint is required for v1.

- Users run races normally in the UI (Local or Multiplayer).
- Export the run suite via Arena: **Export → Viewer JSON**.
- Use the importer to convert to canonical JSONL, optionally linking to the official dataset if the matchup matches.

Optional later (better UX, but gated):
- If `WIKIRACE_BENCHMARK_LOG_DIR` is set, the server can auto-append canonical records during:
  - `POST /llm/local_run/step`
  - multiplayer LLM task steps

---

## 9) Scoring & Reporting

### 9.1 Required reporting (v1)

- Win rate (overall + per tier)
- Hops on wins (min/median/mean)
- Duration on wins (median/mean)
- Token usage on wins (median/mean; null-safe)
- Efficiency: tokens-per-hop, latency-per-hop (on wins)

### 9.2 Composite score (v1)

Per matchup:
- lose → `0`
- win → `base - α*hops - β*log1p(total_tokens) - γ*log1p(duration_ms)`

Aggregate:
- sum across matchups, with per-tier breakdowns.

Notes:
- Weights (`base`, `α`, `β`, `γ`) must be recorded in the summary and kept stable for the dataset+track version.
- If `total_tokens` is null, the token penalty is skipped (or treated as unknown and reported separately).

### 9.3 When shortest-path becomes available

When `shortest_path_hops` is present for a matchup, we can report:
- `hops_over_optimal = hops - shortest_path_hops`
- `optimality_ratio = hops / shortest_path_hops`

These are additive metrics; they do not block v1.

---

## 10) Implementation Roadmap (Phases)

### Phase 0 — Schemas + summarizer + importer (foundation)

- Add `parallel_eval/benchmark/schema.py` (Pydantic models).
- Implement:
  - canonical JSONL writer
  - summarizer → `*.summary.json` + `*.viewer.json`
  - importer: Viewer JSON → canonical JSONL (link to dataset if matchups align)

Deliverable: one `results/benchmarks/<run_id>.jsonl` can always be summarized and viewed.

### Phase 1 — Make telemetry real in artifacts (latency + tokens) + prompt parity

- **Prompt drift fix:** centralize prompt builder + answer parser in `parallel_eval/benchmark/prompt.py` and import it from:
  - `api.py`
  - `parallel_eval/game.py`
- **Latency measurement:**
  - Add explicit `latency_ms` around the model call in:
    - server `_call_llm` (`api.py`)
    - CLI `AgentPlayer.get_move` (`parallel_eval/game.py`)
- **Token usage:**
  - Ensure CLI persists per-step and per-run token totals using `llm_client.achat()` usage.

Deliverable: CLI and server produce comparable metrics.

### Phase 2 — Dataset generation tooling + Frontier 200 dataset

- Implement `parallel_eval/benchmark/graph.py` + `matchups.py`:
  - degrees/hubs/dead-ends
  - BFS distance for candidate pairs (capped)
  - dataset generation + validation
- Produce:
  - `benchmarks/matchups/frontier_local_simplewiki_standard_v1/all.jsonl`
  - `benchmarks/matchups/frontier_local_simplewiki_standard_v1/benchmark_metadata.json`

Deliverable: a stable, hard, tiered dataset in-repo.

### Phase 3 — Benchmark runner (standardized execution)

- Implement `parallel_eval/benchmark/runner.py`:
  - execute dataset for one model
  - configurable concurrency (recorded in provenance)
  - canonical JSONL + derived outputs

Deliverable: one command can run the official benchmark for a model.

### Phase 4 — Scoring + leaderboard snapshots

- Implement `parallel_eval/benchmark/scoring.py`:
  - per-matchup scoring + composite aggregation
  - per-tier breakdowns
- Implement a small leaderboard aggregator:
  - many `*.summary.json` → `leaderboard.json`/`leaderboard.md`

Deliverable: repeatable scoring and ranking outputs.

### Phase 5 — Optional tracks (post-v1)

- `anti_hub` track (hub bans/penalties on intermediates).
- tool-augmented agent track (separate).

---

## 11) Minimal Test Plan (No New Dependencies)

Use `unittest` (stdlib) to avoid adding pytest as a dependency in v1.

Add:
- `parallel_eval/benchmark/tests/test_graph.py`
  - small synthetic graphs for BFS correctness
  - hub exclusion rules
- `parallel_eval/benchmark/tests/test_scoring.py`
  - composite scoring edge cases (no wins, null tokens, etc.)
- `parallel_eval/benchmark/tests/test_roundtrip.py`
  - JSONL → summary → viewer JSON shape validation

Run:
- `uv run python -m unittest parallel_eval.benchmark.tests.test_graph`
- `uv run python -m unittest parallel_eval.benchmark.tests.test_scoring`

---

## 12) Practical Notes / Risks

- **Provider variability:** token usage may be missing; schema must accept nulls and reporting must be null-safe.
- **Latency stability:** wall-clock time depends on concurrency; we record both run duration and summed LLM call latency.
- **Artifact size:** raw outputs are large; keep `llm_output` off by default (enable with truncation).
- **Overfitting risk:** a public fixed dataset is optimizable; mitigate via tiers, occasional dataset version bumps, and (optionally) a private holdout set for internal testing.
