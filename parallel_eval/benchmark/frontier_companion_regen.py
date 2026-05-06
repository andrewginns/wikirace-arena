from __future__ import annotations

import json
from collections import Counter, defaultdict
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Iterable, Optional

from parallel_eval.benchmark.fixed_suite import (
    ALL_DATASET_FILENAME,
    FRONTIER_V1_1_SUITE_ID,
    CandidateMatchup,
    _candidate_to_matchup,
    _carrier_bridge_title,
    _identity_canonical_title,
    _informative_bridge_title,
    _stable_rank,
)
from parallel_eval.benchmark.frontier_companion import _record_to_candidate
from parallel_eval.benchmark.graph import (
    DegreeStats,
    SQLiteGraph,
    bfs_distance,
    compute_degrees,
)
from parallel_eval.benchmark.utils import sha256_file

REPO_ROOT = Path(__file__).resolve().parents[2]
FRONTIER_COMPANION_REGEN_V1_SUITE_ID = "frontier_local_simplewiki_v1_1_companion101_v1_0_regen"
FRONTIER_COMPANION_REGEN_V1_GENERATOR_VERSION = "frontier_local_simplewiki_v1_1_companion101_v1_0_regen_gen1"

FINAL_FAMILY_QUOTAS: dict[str, int] = {
    "diag_bridge_pressure_v2": 30,
    "diag_dead_end_prone_v2": 24,
    "core_rank_v2": 20,
    "route_fragility_v1": 17,
    "target_rarity_coupled_v1": 10,
}
OVERSAMPLE_FAMILY_QUOTAS: dict[str, int] = {
    "diag_bridge_pressure_v2": 39,
    "diag_dead_end_prone_v2": 31,
    "core_rank_v2": 26,
    "route_fragility_v1": 22,
    "target_rarity_coupled_v1": 12,
}
CANARY_FAMILY_COUNTS: dict[str, int] = {
    "diag_bridge_pressure_v2": 12,
    "diag_dead_end_prone_v2": 10,
    "core_rank_v2": 8,
    "route_fragility_v1": 6,
    "target_rarity_coupled_v1": 4,
}
FAMILY_SELECTION_ORDER: tuple[str, ...] = (
    "route_fragility_v1",
    "target_rarity_coupled_v1",
    "diag_bridge_pressure_v2",
    "diag_dead_end_prone_v2",
    "core_rank_v2",
)
REGEN_MAX_PER_START = 2
REGEN_MAX_PER_SIGNATURE = 6
REGEN_DOMINANT_HARD99_MOTIF_LIMIT = 0
PRE_DAG_MIN_SIGNAL_COUNT = 4
PRE_DAG_STRONG_START_SIGNAL = 5
PRE_DAG_PER_START_LIMIT = 6
OFFPATH_DISTANCE_MAX_NODES = 40_000


@dataclass(frozen=True)
class RegenCandidate:
    candidate: CandidateMatchup
    source_status: str
    source_slice_id: str
    source_reasons: tuple[str, ...]
    target_identity_canonical: bool
    shortest_choke_share_max: float
    first_strong_choke_depth: Optional[int]
    strong_choke_count: int
    early_offpath_total: int
    early_dead_end_ratio: float
    early_carrier_ratio: float
    early_informative_escape_count: int
    local_information_poverty: int
    cheap_hard_score: float
    wrong_turn_tax_mean: Optional[float] = None
    rejoinable_ratio: Optional[float] = None
    unreachable_ratio: Optional[float] = None
    hard_score: float = 0.0
    family_labels: tuple[str, ...] = ()
    signature: tuple[str, ...] = ()


def _source_suite_dir() -> Path:
    return REPO_ROOT / "benchmarks" / "matchups" / FRONTIER_V1_1_SUITE_ID


def _source_candidate_pool_path() -> Path:
    return _source_suite_dir() / "candidate_pool.jsonl"


def _source_audit_path() -> Path:
    return _source_suite_dir() / "audit" / "frontier200_item_audit.v0_1.jsonl"


def _load_candidate_pool(path: Path) -> list[dict[str, Any]]:
    return [json.loads(line) for line in path.read_text("utf-8").splitlines() if line.strip()]


def _load_hard99_audit(path: Path) -> list[dict[str, Any]]:
    rows = [json.loads(line) for line in path.read_text("utf-8").splitlines() if line.strip()]
    return [row for row in rows if row.get("primary_slice") == "controller_hard"]


def _top_fraction_titles(
    degrees: dict[str, DegreeStats],
    *,
    fraction: float,
    value_key: str,
) -> set[str]:
    ordered = sorted(
        degrees.items(),
        key=lambda item: getattr(item[1], value_key),
        reverse=True,
    )
    count = max(1, int(len(ordered) * fraction))
    return {title for title, _stats in ordered[:count]}


def _base_regen_filter(record: dict[str, Any]) -> bool:
    reasons = set(record.get("reasons") or [])
    if (record.get("shortest_path_hops") or 0) not in {4, 5, 6}:
        return False
    if "artifact_bridge_in_shortest_family" in reasons:
        return False
    if "all_sampled_shortest_paths_are_easy_carrier_corridors" in reasons:
        return False
    if (record.get("family_artifact_path_count") or 0) > 0:
        return False
    if (record.get("family_easy_corridor_path_count") or 0) >= 3:
        return False
    if (record.get("target_in_degree") or 0) > 25:
        return False
    if str(record.get("start_width_bucket") or "") not in {"narrow", "normal", "broad"}:
        return False
    return True


def _pre_dag_signal_count(record: dict[str, Any]) -> int:
    corridor = int(record.get("family_easy_corridor_path_count") or 0)
    low_degree_bridge = int(record.get("witness_low_degree_bridge_count") or 0)
    informative = int(record.get("witness_informative_bridge_count") or 0)
    target_in_degree = int(record.get("target_in_degree") or 0)
    shortest_path_count = int(record.get("shortest_path_count") or 0)
    slice_id = str(record.get("slice_id") or "")
    path_bucket = str(record.get("path_bucket") or "")

    if corridor > 1:
        return -999
    if (
        slice_id == "diag_canonical_target_v1"
        and not (corridor == 0 and low_degree_bridge > 0 and target_in_degree <= 4)
    ):
        return -999

    score = 0
    score += int(corridor == 0)
    score += int(low_degree_bridge > 0)
    score += int(slice_id in {"diag_dead_end_prone_v1", "diag_bridge_pressure_v1"})
    score += int(target_in_degree <= 4 and slice_id != "diag_canonical_target_v1")
    score += int(shortest_path_count <= 3)
    score += int(path_bucket == "medium")
    score += int(informative <= 1)
    return score


def _pre_dag_filter(records: list[dict[str, Any]]) -> list[dict[str, Any]]:
    by_start: dict[str, list[tuple[int, dict[str, Any]]]] = defaultdict(list)
    for record in records:
        signal_count = _pre_dag_signal_count(record)
        if signal_count < PRE_DAG_MIN_SIGNAL_COUNT:
            continue
        start = str(record.get("start") or "")
        if not start:
            continue
        by_start[start].append((signal_count, record))

    selected: list[dict[str, Any]] = []
    for start, scored_rows in by_start.items():
        strong_row_count = sum(1 for signal_count, _row in scored_rows if signal_count >= PRE_DAG_MIN_SIGNAL_COUNT)
        max_signal = max(signal_count for signal_count, _row in scored_rows)
        if max_signal < PRE_DAG_STRONG_START_SIGNAL and strong_row_count < 2:
            continue
        ranked_rows = sorted(
            scored_rows,
            key=lambda item: (
                -item[0],
                int(item[1].get("family_easy_corridor_path_count") or 0),
                -(int(item[1].get("witness_low_degree_bridge_count") or 0)),
                int(item[1].get("target_in_degree") or 0),
                _stable_rank(0, start, str(item[1].get("target") or "")),
            ),
        )
        selected.extend(record for _signal, record in ranked_rows[:PRE_DAG_PER_START_LIMIT])
    return selected


def _candidate_signature(candidate: CandidateMatchup) -> tuple[str, ...]:
    shortest_bucket = "1" if candidate.shortest_path_count <= 1 else "2-3" if candidate.shortest_path_count <= 3 else "4+"
    target_bucket = "<=4" if candidate.target_in_degree <= 4 else "5-10" if candidate.target_in_degree <= 10 else "11+"
    return (
        candidate.tier,
        candidate.path_bucket,
        str(candidate.start_width_bucket or ""),
        "ld1" if candidate.witness_low_degree_bridge_count > 0 else "ld0",
        "info_low" if candidate.witness_informative_bridge_count <= 1 else "info_hi",
        shortest_bucket,
        target_bucket,
    )


def _dominant_hard99_motif(candidate: CandidateMatchup) -> bool:
    return (
        candidate.tier == "core_rank_v1"
        and candidate.path_bucket == "medium"
        and candidate.witness_informative_bridge_count >= 2
        and candidate.witness_low_degree_bridge_count >= 1
        and candidate.start_width_bucket in {"narrow", "normal"}
    )


def _early_offpath_stats(
    *,
    graph: SQLiteGraph,
    degrees: dict[str, DegreeStats],
    top_any_10: set[str],
    path: list[str],
    max_steps: int = 2,
    per_node_limit: int = 12,
) -> tuple[int, float, float, int, int]:
    total_offpath = 0
    dead_end = 0
    carrier = 0
    informative = 0
    low_info_steps = 0

    examined_path_nodes = path[: max_steps + 1]
    for idx, node in enumerate(examined_path_nodes[:-1]):
        next_node = examined_path_nodes[idx + 1]
        neighbors = [nbr for nbr in graph.links(node) if nbr not in examined_path_nodes and nbr != next_node]
        neighbors = sorted(
            set(neighbors),
            key=lambda title: (-(degrees.get(title).out_degree if title in degrees else 0), title),
        )[:per_node_limit]
        if not neighbors:
            low_info_steps += 1
            continue
        total_offpath += len(neighbors)
        informative_here = 0
        for nbr in neighbors:
            stats = degrees.get(nbr)
            if stats is None or stats.out_degree <= 2:
                dead_end += 1
            if _carrier_bridge_title(nbr, stats=stats, top_any_10=top_any_10):
                carrier += 1
            if _informative_bridge_title(nbr, stats=stats, top_any_10=top_any_10):
                informative += 1
                informative_here += 1
        if informative_here <= 1:
            low_info_steps += 1

    if total_offpath <= 0:
        return 0, 1.0, 1.0, 0, max_steps

    return (
        total_offpath,
        float(dead_end) / float(total_offpath),
        float(carrier) / float(total_offpath),
        informative,
        low_info_steps,
    )


def _cheap_hard_score(candidate: CandidateMatchup, *, choke_profile: dict[str, object], early_stats: tuple[int, float, float, int, int], target_identity_canonical: bool) -> float:
    early_offpath_total, dead_end_ratio, carrier_ratio, informative_escapes, low_info_steps = early_stats
    score = 0.0
    score += 1.4 if candidate.path_bucket == "medium" else 0.8
    score += 1.3 if candidate.family_easy_corridor_path_count == 0 else 0.3
    score += 1.4 if candidate.witness_low_degree_bridge_count > 0 else -0.4
    score += 1.0 if candidate.witness_informative_bridge_count <= 1 else -0.7
    score += 2.4 * float(choke_profile["max_internal_share"])
    score += 0.9 if choke_profile["first_strong_choke_depth"] is not None and int(choke_profile["first_strong_choke_depth"]) <= 2 else 0.0
    score += 1.0 if candidate.shortest_path_count <= 3 else 0.5 if candidate.shortest_path_count <= 8 else -0.2
    score += 0.8 * dead_end_ratio
    score += 0.5 * carrier_ratio
    score += 0.6 * float(low_info_steps)
    score -= 0.35 * float(min(informative_escapes, 4))
    score += 0.25 if early_offpath_total >= 4 else 0.0
    if not target_identity_canonical:
        score -= 1.5
    if candidate.target_in_degree <= 4:
        score += 0.6
    elif candidate.target_in_degree >= 11:
        score -= 0.4
    if _dominant_hard99_motif(candidate):
        score -= 2.5
    return score


def _path_fragility_proxy(
    candidate: CandidateMatchup,
    *,
    degrees: dict[str, DegreeStats],
    top_any_10: set[str],
) -> tuple[float, Optional[int], int]:
    internal_nodes = list(candidate.shortest_path[1:-1])
    strongest_depth: Optional[int] = None
    strong_count = 0
    max_local_score = 0.0

    for depth, title in enumerate(internal_nodes, start=1):
        stats = degrees.get(title)
        if stats is None:
            continue
        local_score = 0.0
        if stats.out_degree <= 3:
            local_score += 0.55
        elif stats.out_degree <= 6:
            local_score += 0.4
        elif stats.out_degree <= 10:
            local_score += 0.2
        if stats.in_degree <= 3:
            local_score += 0.2
        if _carrier_bridge_title(title, stats=stats, top_any_10=top_any_10):
            local_score -= 0.2
        local_score = max(0.0, min(1.0, local_score))
        max_local_score = max(max_local_score, local_score)
        if local_score >= 0.5:
            strong_count += 1
            if strongest_depth is None:
                strongest_depth = depth

    proxy = 0.0
    if candidate.shortest_path_count <= 1:
        proxy += 0.5
    elif candidate.shortest_path_count <= 3:
        proxy += 0.35
    elif candidate.shortest_path_count <= 8:
        proxy += 0.15
    if candidate.witness_low_degree_bridge_count > 0:
        proxy += 0.3
    if candidate.family_easy_corridor_path_count == 0:
        proxy += 0.1
    if candidate.witness_informative_bridge_count <= 1:
        proxy += 0.1
    proxy = max(proxy, max_local_score)
    return min(1.0, proxy), strongest_depth, strong_count


def _expensive_offpath_metrics(
    *,
    graph: SQLiteGraph,
    degrees: dict[str, DegreeStats],
    path: list[str],
    target: str,
    distance_cache: dict[tuple[str, str, int], Optional[int]],
    max_steps: int = 2,
    per_node_limit: int = 6,
) -> tuple[float, float, float]:
    taxes: list[float] = []
    rejoinable = 0
    unreachable = 0
    sampled = 0

    examined_path_nodes = path[: max_steps + 1]
    total_hops = len(path) - 1
    for idx, node in enumerate(examined_path_nodes[:-1]):
        next_node = examined_path_nodes[idx + 1]
        neighbors = [nbr for nbr in graph.links(node) if nbr not in examined_path_nodes and nbr != next_node]
        neighbors = sorted(
            set(neighbors),
            key=lambda title: (-(degrees.get(title).out_degree if title in degrees else 0), title),
        )[:per_node_limit]
        remaining_after_turn = max(0, total_hops - idx - 1)
        max_depth = min(remaining_after_turn + 3, 8)
        for nbr in neighbors:
            sampled += 1
            key = (nbr, target, max_depth)
            if key not in distance_cache:
                distance_cache[key] = bfs_distance(
                    graph,
                    start=nbr,
                    target=target,
                    max_depth=max_depth,
                    max_nodes=OFFPATH_DISTANCE_MAX_NODES,
                )
            dist = distance_cache[key]
            if dist is None:
                taxes.append(3.0)
                unreachable += 1
                continue
            taxes.append(float(max(0, dist - remaining_after_turn)))
            if dist <= remaining_after_turn + 1:
                rejoinable += 1

    if sampled <= 0:
        return 0.0, 1.0, 1.0
    return (
        sum(taxes) / float(len(taxes) or 1),
        float(rejoinable) / float(sampled),
        float(unreachable) / float(sampled),
    )


def _family_labels(candidate: RegenCandidate) -> tuple[str, ...]:
    labels: list[str] = []
    if (
        candidate.candidate.witness_low_degree_bridge_count > 0
        and candidate.candidate.family_easy_corridor_path_count == 0
        and (
            candidate.shortest_choke_share_max >= 0.55
            or (candidate.wrong_turn_tax_mean or 0.0) >= 1.0
            or (candidate.unreachable_ratio or 0.0) >= 0.35
        )
    ):
        labels.append("diag_bridge_pressure_v2")

    if (
        candidate.source_slice_id == "diag_dead_end_prone_v1"
        or candidate.early_dead_end_ratio >= 0.5
        or (candidate.unreachable_ratio or 0.0) >= 0.45
        or candidate.local_information_poverty >= 2
    ):
        labels.append("diag_dead_end_prone_v2")

    if (
        candidate.source_slice_id == "core_rank_v1"
        and candidate.candidate.family_easy_corridor_path_count <= 1
        and candidate.candidate.witness_informative_bridge_count <= 1
        and (
            candidate.shortest_choke_share_max >= 0.45
            or (candidate.wrong_turn_tax_mean or 0.0) >= 0.75
            or candidate.local_information_poverty >= 1
        )
    ):
        labels.append("core_rank_v2")

    if (
        (
            candidate.candidate.shortest_path_count <= 4
            or candidate.shortest_choke_share_max >= 0.6
        )
        and candidate.candidate.family_easy_corridor_path_count == 0
        and candidate.candidate.witness_informative_bridge_count <= 1
        and (
            candidate.candidate.witness_low_degree_bridge_count > 0
            or candidate.local_information_poverty >= 1
            or candidate.first_strong_choke_depth is not None
        )
    ):
        labels.append("route_fragility_v1")

    if (
        candidate.candidate.target_in_degree <= 4
        and candidate.target_identity_canonical
        and (
            "diag_bridge_pressure_v2" in labels
            or "route_fragility_v1" in labels
            or (candidate.wrong_turn_tax_mean or 0.0) >= 1.0
        )
    ):
        labels.append("target_rarity_coupled_v1")

    return tuple(labels)


def _family_score(candidate: RegenCandidate, family: str) -> float:
    score = candidate.hard_score
    if family == "diag_bridge_pressure_v2":
        score += 1.0 * float(candidate.candidate.witness_low_degree_bridge_count > 0)
        score += 0.9 * candidate.shortest_choke_share_max
        score += 0.8 * (candidate.wrong_turn_tax_mean or 0.0)
    elif family == "diag_dead_end_prone_v2":
        score += 1.2 * candidate.early_dead_end_ratio
        score += 1.0 * (candidate.unreachable_ratio or 0.0)
        score += 0.4 if candidate.source_slice_id == "diag_dead_end_prone_v1" else 0.0
    elif family == "core_rank_v2":
        score += 0.7 if candidate.source_slice_id == "core_rank_v1" else 0.0
        score += 0.5 * float(candidate.local_information_poverty)
    elif family == "route_fragility_v1":
        score += 1.6 * candidate.shortest_choke_share_max
        score += 0.8 if candidate.first_strong_choke_depth is not None and candidate.first_strong_choke_depth <= 2 else 0.0
        score += 0.7 if candidate.candidate.shortest_path_count <= 3 else 0.0
    elif family == "target_rarity_coupled_v1":
        score += 0.8 if candidate.candidate.target_in_degree <= 4 else 0.0
        score += 0.6 * max(0.0, (candidate.wrong_turn_tax_mean or 0.0) - 0.5)
    return score


def _hard_score(candidate: RegenCandidate) -> float:
    score = candidate.cheap_hard_score
    score += 1.0 * (candidate.wrong_turn_tax_mean or 0.0)
    score += 1.0 * (candidate.unreachable_ratio or 0.0)
    score += 0.8 * (1.0 - (candidate.rejoinable_ratio or 0.0))
    return score


def _enriched_payload(candidate: RegenCandidate) -> dict[str, Any]:
    return {
        "start": candidate.candidate.start,
        "target": candidate.candidate.target,
        "source_status": candidate.source_status,
        "source_slice_id": candidate.source_slice_id,
        "source_reasons": list(candidate.source_reasons),
        "shortest_path_hops": candidate.candidate.shortest_path_hops,
        "shortest_path": list(candidate.candidate.shortest_path),
        "path_bucket": candidate.candidate.path_bucket,
        "start_width_bucket": candidate.candidate.start_width_bucket,
        "target_in_degree": candidate.candidate.target_in_degree,
        "shortest_path_count": candidate.candidate.shortest_path_count,
        "family_easy_corridor_path_count": candidate.candidate.family_easy_corridor_path_count,
        "witness_low_degree_bridge_count": candidate.candidate.witness_low_degree_bridge_count,
        "witness_informative_bridge_count": candidate.candidate.witness_informative_bridge_count,
        "target_identity_canonical": candidate.target_identity_canonical,
        "shortest_choke_share_max": round(candidate.shortest_choke_share_max, 4),
        "first_strong_choke_depth": candidate.first_strong_choke_depth,
        "strong_choke_count": candidate.strong_choke_count,
        "early_offpath_total": candidate.early_offpath_total,
        "early_dead_end_ratio": round(candidate.early_dead_end_ratio, 4),
        "early_carrier_ratio": round(candidate.early_carrier_ratio, 4),
        "early_informative_escape_count": candidate.early_informative_escape_count,
        "local_information_poverty": candidate.local_information_poverty,
        "cheap_hard_score": round(candidate.cheap_hard_score, 4),
        "wrong_turn_tax_mean": None if candidate.wrong_turn_tax_mean is None else round(candidate.wrong_turn_tax_mean, 4),
        "rejoinable_ratio": None if candidate.rejoinable_ratio is None else round(candidate.rejoinable_ratio, 4),
        "unreachable_ratio": None if candidate.unreachable_ratio is None else round(candidate.unreachable_ratio, 4),
        "hard_score": round(candidate.hard_score, 4),
        "family_labels": list(candidate.family_labels),
        "signature": list(candidate.signature),
    }


def _select_family_quota(
    *,
    family: str,
    quota: int,
    pool: list[RegenCandidate],
    selected: list[RegenCandidate],
    used_pairs: set[tuple[str, str]],
    used_targets: set[str],
    start_counts: Counter[str],
    signature_counts: Counter[tuple[str, ...]],
    required: bool = True,
) -> list[RegenCandidate]:
    chosen: list[RegenCandidate] = []
    ordered = sorted(
        pool,
        key=lambda row: (
            -_family_score(row, family),
            -row.hard_score,
            _stable_rank(0, family, row.candidate.start, row.candidate.target),
        ),
    )
    for row in ordered:
        pair = (row.candidate.start, row.candidate.target)
        if pair in used_pairs or row.candidate.target in used_targets:
            continue
        if start_counts[row.candidate.start] >= REGEN_MAX_PER_START:
            continue
        if signature_counts[row.signature] >= REGEN_MAX_PER_SIGNATURE:
            continue
        if _dominant_hard99_motif(row.candidate):
            continue
        chosen.append(row)
        used_pairs.add(pair)
        used_targets.add(row.candidate.target)
        start_counts[row.candidate.start] += 1
        signature_counts[row.signature] += 1
        if len(chosen) >= quota:
            break
    if required and len(chosen) < quota:
        raise RuntimeError(f"Unable to satisfy family quota for {family}: selected={len(chosen)} needed={quota}")
    selected.extend(chosen)
    return chosen


def _backfill_candidates(
    *,
    quota: int,
    pool: list[RegenCandidate],
    selected: list[RegenCandidate],
    used_pairs: set[tuple[str, str]],
    used_targets: set[str],
    start_counts: Counter[str],
    signature_counts: Counter[tuple[str, ...]],
) -> list[RegenCandidate]:
    chosen: list[RegenCandidate] = []
    ordered = sorted(
        pool,
        key=lambda row: (
            -row.hard_score,
            _stable_rank(0, "backfill", row.candidate.start, row.candidate.target),
        ),
    )
    for row in ordered:
        pair = (row.candidate.start, row.candidate.target)
        if pair in used_pairs or row.candidate.target in used_targets:
            continue
        if start_counts[row.candidate.start] >= REGEN_MAX_PER_START:
            continue
        if signature_counts[row.signature] >= REGEN_MAX_PER_SIGNATURE:
            continue
        if _dominant_hard99_motif(row.candidate):
            continue
        chosen.append(row)
        used_pairs.add(pair)
        used_targets.add(row.candidate.target)
        start_counts[row.candidate.start] += 1
        signature_counts[row.signature] += 1
        if len(chosen) >= quota:
            break
    selected.extend(chosen)
    return chosen


def _primary_family_for_backfill(candidate: RegenCandidate) -> str:
    if not candidate.family_labels:
        raise RuntimeError(
            f"Backfill candidate {candidate.candidate.start!r} -> {candidate.candidate.target!r} has no family labels."
        )
    return max(
        candidate.family_labels,
        key=lambda family: (_family_score(candidate, family), family),
    )


def _manual_review_reasons(candidate: RegenCandidate) -> tuple[str, ...]:
    reasons: list[str] = []
    if candidate.source_status == "rejected":
        reasons.append("source_status_rejected")
    if not candidate.target_identity_canonical:
        reasons.append("non_identity_canonical_target")
    if "target_rarity_coupled_v1" in candidate.family_labels:
        reasons.append("target_rarity_coupled")
    if "route_fragility_v1" in candidate.family_labels and candidate.candidate.shortest_path_count <= 3:
        reasons.append("fragility_via_low_path_count")
    if candidate.candidate.start_width_bucket == "broad":
        reasons.append("broad_start")
    if candidate.candidate.target_in_degree >= 11:
        reasons.append("high_target_in_degree")
    return tuple(reasons)


def _scale_quotas(quotas: dict[str, int], target_total: int) -> dict[str, int]:
    total = sum(quotas.values())
    scaled: dict[str, int] = {}
    remainders: list[tuple[str, float]] = []
    running = 0
    for family, count in quotas.items():
        raw = float(count) * float(target_total) / float(total)
        base = int(raw)
        scaled[family] = base
        running += base
        remainders.append((family, raw - base))
    for family, _frac in sorted(remainders, key=lambda item: (-item[1], item[0]))[: max(0, target_total - running)]:
        scaled[family] += 1
    return scaled


def generate_frontier_companion_regen_fixed_suite(
    *,
    db_path: Path,
    out_dir: Path,
    suite_id: str = FRONTIER_COMPANION_REGEN_V1_SUITE_ID,
    seed: int = 0,
) -> dict[str, list[Any]]:
    if suite_id != FRONTIER_COMPANION_REGEN_V1_SUITE_ID:
        raise ValueError(f"Unsupported regenerated companion suite id: {suite_id!r}")

    candidate_pool = _load_candidate_pool(_source_candidate_pool_path())
    hard99_audit = _load_hard99_audit(_source_audit_path())
    hard99_pairs = {(row["start"], row["target"]) for row in hard99_audit}
    hard99_starts = {row["start"] for row in hard99_audit}
    hard99_targets = {row["target"] for row in hard99_audit}

    degrees = compute_degrees(db_path)
    top_any_10 = _top_fraction_titles(degrees, fraction=0.10, value_key="out_degree") | _top_fraction_titles(
        degrees, fraction=0.10, value_key="in_degree"
    )

    graph = SQLiteGraph(db_path)
    db = SQLiteGraph(db_path)
    try:
        filtered_records = [row for row in candidate_pool if _base_regen_filter(row)]
        pre_dag_records = _pre_dag_filter(filtered_records)

        cheap_candidates: list[RegenCandidate] = []

        for row in pre_dag_records:
            candidate = _record_to_candidate(row)
            pair = (candidate.start, candidate.target)
            if pair in hard99_pairs or candidate.start in hard99_starts or candidate.target in hard99_targets:
                continue
            choke_share, first_strong_depth, strong_choke_count = _path_fragility_proxy(
                candidate,
                degrees=degrees,
                top_any_10=top_any_10,
            )
            early_stats = _early_offpath_stats(
                graph=graph,
                degrees=degrees,
                top_any_10=top_any_10,
                path=candidate.shortest_path,
            )
            target_identity_canonical = _identity_canonical_title(db, candidate.target, degrees=degrees)
            cheap_score = _cheap_hard_score(
                candidate,
                choke_profile={
                    "max_internal_share": choke_share,
                    "first_strong_choke_depth": first_strong_depth,
                    "strong_choke_count": strong_choke_count,
                },
                early_stats=early_stats,
                target_identity_canonical=target_identity_canonical,
            )
            cheap = RegenCandidate(
                candidate=candidate,
                source_status=str(row.get("status") or ""),
                source_slice_id=str(row.get("slice_id") or ""),
                source_reasons=tuple(str(reason) for reason in row.get("reasons") or ()),
                target_identity_canonical=target_identity_canonical,
                shortest_choke_share_max=float(choke_share),
                first_strong_choke_depth=first_strong_depth,
                strong_choke_count=strong_choke_count,
                early_offpath_total=early_stats[0],
                early_dead_end_ratio=early_stats[1],
                early_carrier_ratio=early_stats[2],
                early_informative_escape_count=early_stats[3],
                local_information_poverty=early_stats[4],
                cheap_hard_score=cheap_score,
                signature=_candidate_signature(candidate),
            )
            cheap_candidates.append(cheap)

        family_seed_pools: dict[str, list[RegenCandidate]] = defaultdict(list)
        for row in cheap_candidates:
            provisional = RegenCandidate(
                **{**row.__dict__, "family_labels": _family_labels(row), "hard_score": row.cheap_hard_score}
            )
            for family in provisional.family_labels:
                family_seed_pools[family].append(provisional)

        shortlist: dict[tuple[str, str], RegenCandidate] = {}
        for family, quota in OVERSAMPLE_FAMILY_QUOTAS.items():
            pool = sorted(
                family_seed_pools.get(family, []),
                key=lambda row: (-_family_score(row, family), -row.cheap_hard_score, row.candidate.stable_rank),
            )[: max(quota * 5, 80)]
            for row in pool:
                shortlist[(row.candidate.start, row.candidate.target)] = row

        distance_cache: dict[tuple[str, str, int], Optional[int]] = {}
        enriched_candidates: list[RegenCandidate] = []
        for row in shortlist.values():
            wrong_turn_tax_mean, rejoinable_ratio, unreachable_ratio = _expensive_offpath_metrics(
                graph=graph,
                degrees=degrees,
                path=row.candidate.shortest_path,
                target=row.candidate.target,
                distance_cache=distance_cache,
            )
            enriched = RegenCandidate(
                **{
                    **row.__dict__,
                    "wrong_turn_tax_mean": wrong_turn_tax_mean,
                    "rejoinable_ratio": rejoinable_ratio,
                    "unreachable_ratio": unreachable_ratio,
                }
            )
            enriched = RegenCandidate(
                **{
                    **enriched.__dict__,
                    "hard_score": _hard_score(enriched),
                }
            )
            enriched = RegenCandidate(
                **{
                    **enriched.__dict__,
                    "family_labels": _family_labels(enriched),
                }
            )
            enriched_candidates.append(enriched)

        family_pools: dict[str, list[RegenCandidate]] = defaultdict(list)
        for row in enriched_candidates:
            for family in row.family_labels:
                family_pools[family].append(row)

        used_pairs: set[tuple[str, str]] = set()
        used_targets: set[str] = set()
        start_counts: Counter[str] = Counter()
        signature_counts: Counter[tuple[str, ...]] = Counter()

        oversample_selected: list[RegenCandidate] = []
        oversample_primary_families: dict[tuple[str, str], str] = {}
        for family in FAMILY_SELECTION_ORDER:
            quota = OVERSAMPLE_FAMILY_QUOTAS[family]
            chosen = _select_family_quota(
                family=family,
                quota=quota,
                pool=family_pools.get(family, []),
                selected=oversample_selected,
                used_pairs=used_pairs,
                used_targets=used_targets,
                start_counts=start_counts,
                signature_counts=signature_counts,
                required=False,
            )
            for row in chosen:
                oversample_primary_families[(row.candidate.start, row.candidate.target)] = family
        oversample_target = sum(OVERSAMPLE_FAMILY_QUOTAS.values())
        if len(oversample_selected) < oversample_target:
            chosen = _backfill_candidates(
                quota=oversample_target - len(oversample_selected),
                pool=enriched_candidates,
                selected=oversample_selected,
                used_pairs=used_pairs,
                used_targets=used_targets,
                start_counts=start_counts,
                signature_counts=signature_counts,
            )
            for row in chosen:
                oversample_primary_families[(row.candidate.start, row.candidate.target)] = _primary_family_for_backfill(row)

        final_pool = oversample_selected
        final_family_pools: dict[str, list[RegenCandidate]] = defaultdict(list)
        for row in final_pool:
            for family in row.family_labels:
                final_family_pools[family].append(row)

        used_pairs.clear()
        used_targets.clear()
        start_counts.clear()
        signature_counts.clear()
        final_selected: list[RegenCandidate] = []
        final_primary_families: dict[tuple[str, str], str] = {}
        for family in FAMILY_SELECTION_ORDER:
            quota = FINAL_FAMILY_QUOTAS[family]
            chosen = _select_family_quota(
                family=family,
                quota=quota,
                pool=final_family_pools.get(family, []),
                selected=final_selected,
                used_pairs=used_pairs,
                used_targets=used_targets,
                start_counts=start_counts,
                signature_counts=signature_counts,
            )
            for row in chosen:
                final_primary_families[(row.candidate.start, row.candidate.target)] = family

        canary_pool: dict[str, list[RegenCandidate]] = defaultdict(list)
        for row in final_selected:
            for family in row.family_labels:
                canary_pool[family].append(row)

        used_pairs.clear()
        used_targets.clear()
        start_counts.clear()
        signature_counts.clear()
        canary_selected: list[RegenCandidate] = []
        canary_primary_families: dict[tuple[str, str], str] = {}
        for family in FAMILY_SELECTION_ORDER:
            quota = CANARY_FAMILY_COUNTS[family]
            chosen = _select_family_quota(
                family=family,
                quota=quota,
                pool=canary_pool.get(family, []),
                selected=canary_selected,
                used_pairs=used_pairs,
                used_targets=used_targets,
                start_counts=start_counts,
                signature_counts=signature_counts,
            )
            for row in chosen:
                canary_primary_families[(row.candidate.start, row.candidate.target)] = family

        out_dir.mkdir(parents=True, exist_ok=True)
        final_matchups = [
            _candidate_to_matchup(
                row.candidate,
                suite_id=suite_id,
                slice_id=final_primary_families[(row.candidate.start, row.candidate.target)],
                index=index,
            )
            for index, row in enumerate(final_selected, start=1)
        ]
        oversample_matchups = [
            _candidate_to_matchup(
                row.candidate,
                suite_id=suite_id,
                slice_id=oversample_primary_families[(row.candidate.start, row.candidate.target)],
                index=index,
            )
            for index, row in enumerate(oversample_selected, start=1)
        ]
        canary_matchups = [
            _candidate_to_matchup(
                row.candidate,
                suite_id=suite_id,
                slice_id=canary_primary_families[(row.candidate.start, row.candidate.target)],
                index=index,
            )
            for index, row in enumerate(canary_selected, start=1)
        ]

        def _write_matchups(path: Path, rows: Iterable[Any]) -> None:
            payload = "\n".join(json.dumps(row.model_dump(mode="json"), ensure_ascii=False) for row in rows)
            path.write_text(payload + ("\n" if payload else ""), "utf-8")

        def _write_jsonl(path: Path, rows: Iterable[dict[str, Any]]) -> None:
            payload = "\n".join(json.dumps(row, ensure_ascii=False) for row in rows)
            path.write_text(payload + ("\n" if payload else ""), "utf-8")

        _write_matchups(out_dir / ALL_DATASET_FILENAME, final_matchups)
        _write_matchups(out_dir / "oversample130.jsonl", oversample_matchups)
        _write_matchups(out_dir / "canary.jsonl", canary_matchups)
        _write_jsonl(out_dir / "selection_records.jsonl", (_enriched_payload(row) for row in final_selected))
        _write_jsonl(out_dir / "oversample_records.jsonl", (_enriched_payload(row) for row in oversample_selected))
        _write_jsonl(out_dir / "enriched_pool.jsonl", (_enriched_payload(row) for row in enriched_candidates))

        manual_review_rows = []
        for row in oversample_selected:
            reasons = _manual_review_reasons(row)
            if not reasons:
                continue
            payload = _enriched_payload(row)
            payload["manual_review_reasons"] = list(reasons)
            manual_review_rows.append(payload)
        manual_review_rows.sort(
            key=lambda row: (
                -len(row.get("manual_review_reasons") or []),
                row.get("source_status") != "rejected",
                -float(row.get("hard_score") or 0.0),
                str(row.get("start") or ""),
                str(row.get("target") or ""),
            )
        )
        _write_jsonl(out_dir / "manual_review_queue.jsonl", manual_review_rows[:40])

        report = {
            "source_suite_id": FRONTIER_V1_1_SUITE_ID,
            "source_candidate_pool": str(_source_candidate_pool_path()),
            "source_audit": str(_source_audit_path()),
            "base_filtered_count": len(filtered_records),
            "pre_dag_count": len(pre_dag_records),
            "pre_dag_unique_starts": len({str(row.get("start") or "") for row in pre_dag_records}),
            "cheap_candidate_count": len(cheap_candidates),
            "shortlist_count": len(shortlist),
            "enriched_candidate_count": len(enriched_candidates),
            "family_pool_counts": {family: len(pool) for family, pool in family_pools.items()},
            "oversample_counts": dict(Counter(oversample_primary_families[(row.candidate.start, row.candidate.target)] for row in oversample_selected)),
            "final_counts": dict(Counter(final_primary_families[(row.candidate.start, row.candidate.target)] for row in final_selected)),
            "canary_counts": dict(Counter(canary_primary_families[(row.candidate.start, row.candidate.target)] for row in canary_selected)),
            "final_path_buckets": dict(Counter(row.candidate.path_bucket for row in final_selected)),
            "final_start_width_buckets": dict(Counter(str(row.candidate.start_width_bucket or "") for row in final_selected)),
            "final_target_identity_canonical_false": sum(1 for row in final_selected if not row.target_identity_canonical),
            "final_low_degree_bridge_one_plus": sum(1 for row in final_selected if row.candidate.witness_low_degree_bridge_count > 0),
            "final_easy_corridor_zero": sum(1 for row in final_selected if row.candidate.family_easy_corridor_path_count == 0),
            "final_dominant_hard99_motif_count": sum(1 for row in final_selected if _dominant_hard99_motif(row.candidate)),
            "manual_review_count": min(40, len(manual_review_rows)),
            "mean_hard_score": round(sum(row.hard_score for row in final_selected) / float(len(final_selected) or 1), 4),
            "mean_wrong_turn_tax": round(sum((row.wrong_turn_tax_mean or 0.0) for row in final_selected) / float(len(final_selected) or 1), 4),
            "mean_choke_share": round(sum(row.shortest_choke_share_max for row in final_selected) / float(len(final_selected) or 1), 4),
        }

        manifest = {
            "suite_id": suite_id,
            "source_suite_id": FRONTIER_V1_1_SUITE_ID,
            "generator_version": FRONTIER_COMPANION_REGEN_V1_GENERATOR_VERSION,
            "selection_mode": "db_enriched_regenerated_pool_v1",
            "seed": seed,
            "final_family_quotas": FINAL_FAMILY_QUOTAS,
            "oversample_family_quotas": OVERSAMPLE_FAMILY_QUOTAS,
            "canary_family_counts": CANARY_FAMILY_COUNTS,
            "selection_notes": [
                "Regenerated companion set built from a broader fair frontier candidate universe instead of the reserve-only tail.",
                "Standalone canonical-target softness is removed; target rarity survives only when coupled to controller-hard structure.",
                "Hardness is driven by shortest-path choke, early off-path ambiguity, wrong-turn tax, dead-end burden, and low-information local structure.",
            ],
            "db_path": str(db_path),
            "db_sha256": sha256_file(db_path),
            "selection_artifacts": {
                "oversample": "oversample130.jsonl",
                "canary": "canary.jsonl",
                "selection_records": "selection_records.jsonl",
                "oversample_records": "oversample_records.jsonl",
                "enriched_pool": "enriched_pool.jsonl",
                "manual_review_queue": "manual_review_queue.jsonl",
                "structural_report": "structural_report.json",
            },
            "report_summary": report,
        }
        (out_dir / "suite_manifest.json").write_text(json.dumps(manifest, indent=2) + "\n", "utf-8")
        (out_dir / "structural_report.json").write_text(json.dumps(report, indent=2) + "\n", "utf-8")

        slices: dict[str, list[Any]] = defaultdict(list)
        for matchup, row in zip(final_matchups, final_selected, strict=False):
            primary_family = final_primary_families[(row.candidate.start, row.candidate.target)]
            slices[primary_family].append(matchup)
        return dict(slices)
    finally:
        graph.close()
        db.close()
