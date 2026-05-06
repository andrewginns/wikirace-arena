# Benchmark Curation

This repo now treats frontier-suite curation as a code-backed process, not pair-by-pair hand editing.

## Goals

- Keep the benchmark around `~200` pairs.
- Target roughly `50%` success for strong frontier models, not high-70s/80s.
- Prefer fair-hard paths over artifact-hard or trivially carrier-driven paths.
- Preserve reproducibility from DB hash, commit, seed, and suite id.

## Pathology Classes

- Artifact-hard:
  year pages, list/meta/timeline/history pages, title-variant leakage, and other low-affordance bridges.
- Carrier-easy:
  broad geography or taxonomy corridors such as `United States`, `Europe`, `City`, `Country`, `U.S. state`, `Water`, `Land`.
- Brittle-single-route:
  shortest-path families with only one route and little informative structure.

## Policy

- Hard reject candidate pairs when sampled shortest paths contain artifact bridges.
- Hard reject candidate pairs when sampled shortest paths expose easy carrier corridors.
- Prefer candidates with informative internal bridges and banded shortest-path counts.
- Use model failures to form rule hypotheses, not to cherry-pick individual pairs.

## Calibration Protocol

- Primary anchor: `gpt-5.4 low`
- Secondary anchor: `gpt-5.2 none`
- Stronger same-family holdout: `gpt-5.4 medium` or `gpt-5.1 low`
- Cross-family holdout: `gemini-3.1-pro-preview`

The suite ships with deterministic internal splits:

- `seen_calibration.jsonl`
- `blind_holdout.jsonl`
- `trajectory_spine.jsonl`

## Release Gates

- Anchor model lands near the intended band on a completed run.
- Holdout results do not drift materially above the intended band.
- Artifact leakage is near-zero in audit samples.
- The suite remains reproducible with zero manual pair edits.
