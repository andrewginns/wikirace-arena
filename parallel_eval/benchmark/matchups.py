from __future__ import annotations

import json
import random
from datetime import datetime, timezone
from pathlib import Path
from typing import Optional

from parallel_eval.benchmark.graph import SQLiteGraph, bfs_distances, compute_degrees, top_hubs
from parallel_eval.benchmark.schema import MatchupV1


def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")


def generate_matchups_dataset(
    *,
    db_path: Path,
    out_path: Path,
    out_meta_path: Optional[Path],
    count: int,
    smoke_count: int,
    seed: int,
    max_distance: int,
    min_distance: int,
    hub_top_k_out: int,
    hub_top_k_in: int,
    min_out_degree: int,
    max_out_degree: int,
    candidate_sample: int,
    pair_sample: int,
) -> None:
    rng = random.Random(seed)

    degrees_all = compute_degrees(db_path)
    hubs = top_hubs(degrees_all, top_k_out=hub_top_k_out, top_k_in=hub_top_k_in)

    candidates = [
        title
        for title, stats in degrees_all.items()
        if title not in hubs
        and stats.out_degree >= min_out_degree
        and stats.out_degree <= max_out_degree
    ]
    if candidate_sample and len(candidates) > candidate_sample:
        candidates = rng.sample(candidates, candidate_sample)

    graph = SQLiteGraph(db_path)
    try:
        scored_pairs: list[tuple[int, str, str]] = []
        seen_pairs: set[tuple[str, str]] = set()

        candidate_set = set(candidates)
        start_seeds = candidates
        if pair_sample and len(start_seeds) > pair_sample:
            start_seeds = rng.sample(start_seeds, pair_sample)

        baseline_min_distance = max(2, min_distance - 3)

        # For each start seed, run one BFS and harvest far targets from the frontier.
        for start in start_seeds:
            dist_map = bfs_distances(graph, start=start, max_depth=max_distance)
            far: list[tuple[int, str]] = []
            for node, dist in dist_map.items():
                if dist < baseline_min_distance:
                    continue
                if node not in candidate_set:
                    continue
                if node == start:
                    continue
                far.append((dist, node))

            if not far:
                continue
            far.sort(key=lambda t: t[0], reverse=True)

            # Take a handful per start to keep the set diverse while limiting
            # the number of BFS expansions needed.
            per_start = 25
            for dist, target in far[:per_start]:
                key = (start, target)
                if key in seen_pairs:
                    continue
                seen_pairs.add(key)
                scored_pairs.append((dist, start, target))

            # Stop early once we have enough candidates to select from.
            if len(scored_pairs) >= max(count * 5, count + 100):
                break

        scored_pairs.sort(key=lambda t: t[0], reverse=True)
        if not scored_pairs:
            raise RuntimeError("No candidate pairs found. Try lowering --min-distance or increasing --pair-sample.")

        dists = [d for d, _, _ in scored_pairs]
        dists.sort(reverse=True)

        # Thresholds:
        # - Frontier should generally be at least `min_distance`.
        # - Baseline should avoid trivially short paths (>= baseline_min_distance).
        frontier_idx = min(len(dists) - 1, int(len(dists) * 0.20))
        hard_idx = min(len(dists) - 1, int(len(dists) * 0.55))
        frontier_cut = max(min_distance, dists[frontier_idx])
        hard_cut = max(baseline_min_distance, dists[hard_idx])

        frontier_pairs = [p for p in scored_pairs if p[0] >= frontier_cut]
        hard_pairs = [p for p in scored_pairs if hard_cut <= p[0] < frontier_cut]
        baseline_pairs = [p for p in scored_pairs if p[0] < hard_cut]

        # Tier quotas (default tuned for 200).
        if count == 200:
            baseline_quota, hard_quota, frontier_quota = 60, 90, 50
        else:
            frontier_quota = max(1, int(round(count * 0.25)))
            hard_quota = max(1, int(round(count * 0.45)))
            baseline_quota = max(0, count - frontier_quota - hard_quota)

        used_pairs: set[tuple[int, str, str]] = set()

        def take_unique(pool: list[tuple[int, str, str]], n: int) -> list[tuple[int, str, str]]:
            picked: list[tuple[int, str, str]] = []
            for item in pool:
                if item in used_pairs:
                    continue
                used_pairs.add(item)
                picked.append(item)
                if len(picked) >= n:
                    break
            return picked

        selected_frontier = take_unique(frontier_pairs, frontier_quota)
        selected_hard = take_unique(hard_pairs, hard_quota)
        selected_baseline = take_unique(baseline_pairs, baseline_quota)

        # Top up shortages from other tiers (harder first).
        if len(selected_frontier) < frontier_quota:
            selected_frontier += take_unique(hard_pairs, frontier_quota - len(selected_frontier))
        if len(selected_hard) < hard_quota:
            selected_hard += take_unique(frontier_pairs, hard_quota - len(selected_hard))
        if len(selected_hard) < hard_quota:
            selected_hard += take_unique(baseline_pairs, hard_quota - len(selected_hard))
        if len(selected_baseline) < baseline_quota:
            selected_baseline += take_unique(hard_pairs, baseline_quota - len(selected_baseline))

        # Final assembly (ensure total count).
        picked: list[MatchupV1] = []

        def append_many(tier: str, pairs: list[tuple[int, str, str]]):
            for dist, start, target in pairs:
                if len(picked) >= count:
                    return
                picked.append(
                    MatchupV1(
                        id=f"v1-{tier}-{len(picked):04d}",
                        tier=tier,  # type: ignore[arg-type]
                        start=start,
                        target=target,
                        tags=["nonhub", f"dist={dist}"],
                        shortest_path_hops=dist,
                    )
                )

        append_many("frontier", selected_frontier)
        append_many("hard", selected_hard)
        append_many("baseline", selected_baseline)

        if len(picked) < count:
            remaining_pairs = take_unique(scored_pairs, count - len(picked))
            append_many("baseline", remaining_pairs)

        out_path.parent.mkdir(parents=True, exist_ok=True)
        with open(out_path, "w", encoding="utf-8") as f:
            for matchup in picked:
                f.write(json.dumps(matchup.model_dump(mode="json"), ensure_ascii=False) + "\n")

        # Smoke: take a stratified sample.
        smoke_out = out_path.with_name("smoke.jsonl")
        if smoke_count > 0:
            by_tier: dict[str, list[MatchupV1]] = {"baseline": [], "hard": [], "frontier": []}
            for m in picked:
                by_tier[m.tier].append(m)
            smoke: list[MatchupV1] = []
            per = max(1, smoke_count // 3)
            for tier in ("baseline", "hard", "frontier"):
                pool = by_tier[tier]
                if not pool:
                    continue
                smoke.extend(rng.sample(pool, min(per, len(pool))))
            if len(smoke) < smoke_count:
                used_ids = {m.id for m in smoke}
                remainder = [m for m in picked if m.id not in used_ids]
                if remainder:
                    smoke.extend(rng.sample(remainder, min(smoke_count - len(smoke), len(remainder))))
            smoke = smoke[:smoke_count]
            with open(smoke_out, "w", encoding="utf-8") as f:
                for matchup in smoke:
                    f.write(json.dumps(matchup.model_dump(mode="json"), ensure_ascii=False) + "\n")

        if out_meta_path is None:
            out_meta_path = out_path.with_suffix(out_path.suffix + ".meta.json")
        meta = {
            "created_at": _now_iso(),
            "db_path": str(db_path),
            "seed": seed,
            "count": count,
            "smoke_count": smoke_count,
            "max_distance": max_distance,
            "min_distance": min_distance,
            "hub_top_k_out": hub_top_k_out,
            "hub_top_k_in": hub_top_k_in,
            "candidate_sample": candidate_sample,
            "pair_sample": pair_sample,
            "notes": "Distances computed via forward BFS on directed outgoing links within max_distance.",
        }
        out_meta_path.write_text(json.dumps(meta, indent=2), "utf-8")
    finally:
        graph.close()
