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
    _identity_canonical_title,
    _stable_rank,
)
from parallel_eval.benchmark.frontier_companion import _record_to_candidate
from parallel_eval.benchmark.frontier_companion_regen import (
    REGEN_MAX_PER_SIGNATURE,
    REGEN_MAX_PER_START,
    RegenCandidate,
    _base_regen_filter,
    _candidate_signature,
    _cheap_hard_score,
    _dominant_hard99_motif,
    _early_offpath_stats,
    _expensive_offpath_metrics,
    _family_labels,
    _hard_score,
    _load_candidate_pool,
    _load_hard99_audit,
    _path_fragility_proxy,
    _pre_dag_filter,
    _source_audit_path,
    _source_candidate_pool_path,
    _top_fraction_titles,
)
from parallel_eval.benchmark.graph import SQLiteGraph, compute_degrees
from parallel_eval.benchmark.utils import sha256_file

REPO_ROOT = Path(__file__).resolve().parents[2]
FRONTIER_COMPANION_REGEN_V2_SUITE_ID = "frontier_local_simplewiki_v1_1_companion101_v2_0"
FRONTIER_COMPANION_REGEN_V2_GENERATOR_VERSION = "frontier_local_simplewiki_v1_1_companion101_v2_0_gen1"

PRIMARY_FAMILY_ORDER: tuple[str, ...] = (
    "route_fragility_v1",
    "target_rarity_coupled_v1",
    "diag_dead_end_prone_v2",
    "diag_bridge_pressure_v2",
)
PRIMARY_FAMILY_QUOTAS: dict[str, int] = {
    "route_fragility_v1": 29,
    "target_rarity_coupled_v1": 28,
    "diag_dead_end_prone_v2": 24,
    "diag_bridge_pressure_v2": 20,
}
SHORTLIST_TOP_PER_PRIMARY: dict[str, int] = {
    "route_fragility_v1": 120,
    "target_rarity_coupled_v1": 100,
    "diag_dead_end_prone_v2": 100,
    "diag_bridge_pressure_v2": 80,
}
CANARY_FAMILY_COUNTS: dict[str, int] = {family: 10 for family in PRIMARY_FAMILY_ORDER}
SHORT_PATH_MAX = 58
MEDIUM_PLUS_MIN = 40
NONCANONICAL_MIN = 10
LOW_DEGREE_BRIDGE_MAX = 80
EASY_CORRIDOR_ZERO_MAX = 78
MEAN_CHOKE_SHARE_MAX = 0.88
MANUAL_REVIEW_MAX = 20
FAMILY_OVERLAP_MAX = 4
TARGET_BUCKET_CAP = 40
MAX_REPAIR_PASSES = 60
V2_MANUAL_REVIEW_LIMIT = 30


@dataclass(frozen=True)
class CompanionV2Candidate:
    regen: RegenCandidate
    primary_family: str
    family_count: int
    offender_score: float
    family_score: float


def _source_suite_dir() -> Path:
    return REPO_ROOT / "benchmarks" / "matchups" / FRONTIER_V1_1_SUITE_ID


def _load_source_records() -> list[dict[str, Any]]:
    candidate_pool = _load_candidate_pool(_source_candidate_pool_path())
    return [row for row in candidate_pool if _base_regen_filter(row)]


def _cheap_primary_family(
    *,
    candidate: CandidateMatchup,
    source_slice_id: str,
    target_identity_canonical: bool,
    early_dead_end_ratio: float,
    early_carrier_ratio: float,
    local_information_poverty: int,
) -> str:
    if (
        source_slice_id in {"diag_target_rarity_v1", "diag_canonical_target_v1"}
        and candidate.target_in_degree <= 8
        and candidate.family_easy_corridor_path_count <= 1
        and (
            candidate.shortest_path_hops >= 5
            or not target_identity_canonical
            or candidate.shortest_path_count <= 4
        )
    ):
        return "target_rarity_coupled_v1"
    if (
        source_slice_id == "diag_dead_end_prone_v1"
        and (
            early_dead_end_ratio >= 0.12
            or local_information_poverty >= 1
            or candidate.shortest_path_hops >= 5
        )
    ):
        return "diag_dead_end_prone_v2"
    if (
        source_slice_id == "core_rank_v1"
        and candidate.shortest_path_hops <= 4
        and candidate.witness_informative_bridge_count <= 1
        and candidate.target_in_degree <= 10
    ):
        return "core_rank_v2"
    if (
        candidate.shortest_path_hops >= 5
        and candidate.shortest_path_count <= 3
        and candidate.witness_low_degree_bridge_count > 0
        and candidate.family_easy_corridor_path_count == 0
    ):
        return "route_fragility_v1"
    if (
        source_slice_id == "diag_bridge_pressure_v1"
        and candidate.witness_low_degree_bridge_count > 0
        and (early_carrier_ratio >= 0.4 or candidate.shortest_path_count <= 3)
    ):
        return "diag_bridge_pressure_v2"
    return "core_rank_v2"


def _family_score_v2(regen: RegenCandidate, family: str) -> float:
    candidate = regen.candidate
    score = regen.hard_score
    if family == "route_fragility_v1":
        score += 1.4 if candidate.shortest_path_hops >= 5 else -0.7
        score += 0.9 if candidate.shortest_path_count <= 2 else 0.5 if candidate.shortest_path_count <= 3 else -0.4
        score += 0.7 if candidate.target_in_degree <= 4 else 0.2 if candidate.target_in_degree <= 8 else -0.5
        score += 0.4 if not regen.target_identity_canonical else 0.0
        score -= 0.7 if candidate.shortest_path_hops <= 4 and regen.target_identity_canonical else 0.0
    elif family == "diag_dead_end_prone_v2":
        score += 1.5 * regen.early_dead_end_ratio
        score += 0.7 * float(regen.local_information_poverty)
        score += 0.5 * (regen.unreachable_ratio or 0.0)
        score += 0.5 if candidate.shortest_path_hops >= 5 else 0.0
        score -= 0.5 if candidate.shortest_path_hops <= 4 and regen.target_identity_canonical else 0.0
    elif family == "target_rarity_coupled_v1":
        score += 0.9 if candidate.target_in_degree <= 2 else 0.5 if candidate.target_in_degree <= 4 else 0.0
        score += 0.9 if not regen.target_identity_canonical else 0.0
        score += 0.6 if candidate.shortest_path_hops >= 5 else 0.0
        score += 0.4 if candidate.shortest_path_count <= 4 else 0.0
        score -= 0.3 if candidate.shortest_path_hops <= 4 and regen.target_identity_canonical else 0.0
    elif family == "core_rank_v2":
        score += 0.9 if regen.source_slice_id == "core_rank_v1" else 0.0
        score += 0.8 if candidate.shortest_path_hops >= 5 else 0.1
        score += 0.4 if candidate.witness_informative_bridge_count <= 1 else -0.3
        score += 0.3 if candidate.target_in_degree <= 8 else -0.2
        score -= 0.7 if candidate.shortest_path_hops <= 4 and regen.target_identity_canonical else 0.0
    elif family == "diag_bridge_pressure_v2":
        score += 0.9 if candidate.witness_low_degree_bridge_count > 0 else 0.0
        score += 0.9 * regen.early_carrier_ratio
        score += 0.7 * (regen.wrong_turn_tax_mean or 0.0)
        score += 0.4 if candidate.shortest_path_hops >= 5 else 0.0
        score -= 0.9 if candidate.shortest_path_hops <= 4 and regen.target_identity_canonical else 0.0
    return score


def _definitive_primary_family(regen: RegenCandidate) -> str:
    candidate = regen.candidate
    if (
        regen.source_slice_id in {"diag_target_rarity_v1", "diag_canonical_target_v1"}
        and candidate.target_in_degree <= 8
        and candidate.family_easy_corridor_path_count <= 1
        and (
            candidate.shortest_path_hops >= 5
            or not regen.target_identity_canonical
            or candidate.shortest_path_count <= 4
        )
    ):
        return "target_rarity_coupled_v1"
    if (
        regen.source_slice_id == "diag_dead_end_prone_v1"
        and (
            regen.early_dead_end_ratio >= 0.10
            or regen.local_information_poverty >= 1
            or (regen.unreachable_ratio or 0.0) >= 0.35
            or candidate.shortest_path_hops >= 5
        )
    ):
        return "diag_dead_end_prone_v2"
    if (
        regen.source_slice_id == "core_rank_v1"
        and candidate.shortest_path_hops <= 4
        and candidate.witness_informative_bridge_count <= 1
        and candidate.target_in_degree <= 10
    ):
        return "core_rank_v2"
    if (
        candidate.shortest_path_hops >= 5
        and candidate.shortest_path_count <= 3
        and candidate.witness_low_degree_bridge_count > 0
        and candidate.family_easy_corridor_path_count == 0
    ):
        return "route_fragility_v1"
    if (
        regen.source_slice_id == "diag_bridge_pressure_v1"
        and candidate.witness_low_degree_bridge_count > 0
        and ((regen.wrong_turn_tax_mean or 0.0) >= 2.75 or regen.early_carrier_ratio >= 0.45)
    ):
        return "diag_bridge_pressure_v2"
    scores = {
        family: _family_score_v2(regen, family)
        for family in PRIMARY_FAMILY_ORDER
    }
    return max(scores.items(), key=lambda item: (item[1], -PRIMARY_FAMILY_ORDER.index(item[0]), item[0]))[0]


def _offender_score(regen: RegenCandidate) -> float:
    candidate = regen.candidate
    return float(
        2 * int(candidate.shortest_path_hops <= 4)
        + 2 * int(regen.target_identity_canonical)
        + 2 * int(candidate.witness_low_degree_bridge_count > 0)
        + 1 * int(candidate.family_easy_corridor_path_count == 0)
        + 1 * int(regen.shortest_choke_share_max >= 0.90)
        + 1 * int(len(regen.family_labels) >= 4)
    )


def _target_bucket(candidate: CandidateMatchup) -> str:
    if candidate.target_in_degree <= 2:
        return "<=2"
    if candidate.target_in_degree <= 4:
        return "3-4"
    if candidate.target_in_degree <= 8:
        return "5-8"
    return "9+"


def _selection_score(row: CompanionV2Candidate) -> float:
    score = row.family_score
    score -= 0.55 * row.offender_score
    score += 0.7 if row.regen.candidate.shortest_path_hops >= 5 else 0.0
    score += 0.4 if not row.regen.target_identity_canonical else 0.0
    score += 0.2 if row.family_count <= 2 else -0.35 if row.family_count >= 4 else 0.0
    return score


def _v2_family_overlap_count(regen: RegenCandidate) -> int:
    candidate = regen.candidate
    count = 0
    count += int(candidate.shortest_path_hops >= 5 and candidate.shortest_path_count <= 3)
    count += int(candidate.target_in_degree <= 4 or not regen.target_identity_canonical)
    count += int(regen.early_dead_end_ratio >= 0.10 or regen.local_information_poverty >= 2)
    count += int(
        candidate.witness_low_degree_bridge_count > 0
        and ((regen.wrong_turn_tax_mean or 0.0) >= 2.75 or regen.early_carrier_ratio >= 0.45)
    )
    return max(1, count)


def _v2_manual_review_reasons(row: CompanionV2Candidate) -> tuple[str, ...]:
    reasons: list[str] = []
    if row.regen.source_status == "rejected":
        reasons.append("source_status_rejected")
    if not row.regen.target_identity_canonical:
        reasons.append("non_identity_canonical_target")
    if row.regen.candidate.start_width_bucket == "broad":
        reasons.append("broad_start")
    if row.regen.candidate.target_in_degree >= 11:
        reasons.append("high_target_in_degree")
    if row.family_count >= 4:
        reasons.append("high_feature_overlap")
    return tuple(reasons)


def _candidate_key(row: CompanionV2Candidate) -> tuple[str, str]:
    return (row.regen.candidate.start, row.regen.candidate.target)


def _build_shortlist(
    cheap_candidates: list[RegenCandidate],
) -> list[RegenCandidate]:
    provisional: list[tuple[str, float, RegenCandidate]] = []
    for row in cheap_candidates:
        family = _cheap_primary_family(
            candidate=row.candidate,
            source_slice_id=row.source_slice_id,
            target_identity_canonical=row.target_identity_canonical,
            early_dead_end_ratio=row.early_dead_end_ratio,
            early_carrier_ratio=row.early_carrier_ratio,
            local_information_poverty=row.local_information_poverty,
        )
        provisional.append((family, _family_score_v2(row, family), row))

    shortlist: dict[tuple[str, str], RegenCandidate] = {}
    by_family: dict[str, list[tuple[float, RegenCandidate]]] = defaultdict(list)
    medium_boost: list[tuple[float, RegenCandidate]] = []
    noncanonical_boost: list[tuple[float, RegenCandidate]] = []

    for family, score, row in provisional:
        by_family[family].append((score, row))
        if row.candidate.shortest_path_hops >= 5:
            medium_boost.append((score, row))
        if not row.target_identity_canonical:
            noncanonical_boost.append((score, row))

    for family, limit in SHORTLIST_TOP_PER_PRIMARY.items():
        ordered = sorted(
            by_family.get(family, []),
            key=lambda item: (
                -item[0],
                -item[1].cheap_hard_score,
                _stable_rank(0, family, item[1].candidate.start, item[1].candidate.target),
            ),
        )
        for _score, row in ordered[:limit]:
            shortlist[(row.candidate.start, row.candidate.target)] = row

    for label, pool, limit in (
        ("medium_boost", medium_boost, 120),
        ("noncanonical_boost", noncanonical_boost, 28),
    ):
        ordered = sorted(
            pool,
            key=lambda item: (
                -item[0],
                _stable_rank(0, label, item[1].candidate.start, item[1].candidate.target),
            ),
        )
        for _score, row in ordered[:limit]:
            shortlist[(row.candidate.start, row.candidate.target)] = row

    return list(shortlist.values())


def _enrich_candidates(
    *,
    db_path: Path,
    shortlisted: list[RegenCandidate],
) -> list[CompanionV2Candidate]:
    degrees = compute_degrees(db_path)
    graph = SQLiteGraph(db_path)
    db = SQLiteGraph(db_path)
    distance_cache: dict[tuple[str, str, int], Optional[int]] = {}
    try:
        enriched: list[CompanionV2Candidate] = []
        for row in shortlisted:
            wrong_turn_tax_mean, rejoinable_ratio, unreachable_ratio = _expensive_offpath_metrics(
                graph=graph,
                degrees=degrees,
                path=row.candidate.shortest_path,
                target=row.candidate.target,
                distance_cache=distance_cache,
            )
            regen = RegenCandidate(
                **{
                    **row.__dict__,
                    "wrong_turn_tax_mean": wrong_turn_tax_mean,
                    "rejoinable_ratio": rejoinable_ratio,
                    "unreachable_ratio": unreachable_ratio,
                }
            )
            regen = RegenCandidate(
                **{
                    **regen.__dict__,
                    "hard_score": _hard_score(regen),
                }
            )
            regen = RegenCandidate(
                **{
                    **regen.__dict__,
                    "family_labels": _family_labels(regen),
                }
            )
            primary_family = _definitive_primary_family(regen)
            family_score = _family_score_v2(regen, primary_family)
            enriched.append(
                CompanionV2Candidate(
                    regen=regen,
                    primary_family=primary_family,
                    family_count=_v2_family_overlap_count(regen),
                    offender_score=_offender_score(regen),
                    family_score=family_score,
                )
            )
        return enriched
    finally:
        graph.close()
        db.close()


def _select_family_quota_v2(
    *,
    family: str,
    quota: int,
    pool: list[CompanionV2Candidate],
    selected: list[CompanionV2Candidate],
    used_pairs: set[tuple[str, str]],
    used_targets: set[str],
    start_counts: Counter[str],
    signature_counts: Counter[tuple[str, ...]],
    target_bucket_counts: Counter[str],
) -> list[CompanionV2Candidate]:
    chosen: list[CompanionV2Candidate] = []
    ordered = sorted(
        pool,
        key=lambda row: (
            -_selection_score(row),
            -row.family_score,
            _stable_rank(0, family, row.regen.candidate.start, row.regen.candidate.target),
        ),
    )
    for row in ordered:
        candidate = row.regen.candidate
        pair = _candidate_key(row)
        target_bucket = _target_bucket(candidate)
        if pair in used_pairs or candidate.target in used_targets:
            continue
        if start_counts[candidate.start] >= REGEN_MAX_PER_START:
            continue
        if signature_counts[row.regen.signature] >= REGEN_MAX_PER_SIGNATURE:
            continue
        if target_bucket_counts[target_bucket] >= TARGET_BUCKET_CAP:
            continue
        if _dominant_hard99_motif(candidate):
            continue
        chosen.append(row)
        used_pairs.add(pair)
        used_targets.add(candidate.target)
        start_counts[candidate.start] += 1
        signature_counts[row.regen.signature] += 1
        target_bucket_counts[target_bucket] += 1
        if len(chosen) >= quota:
            break
    if len(chosen) < quota:
        raise RuntimeError(f"Unable to satisfy v2 family quota for {family}: selected={len(chosen)} needed={quota}")
    selected.extend(chosen)
    return chosen


def _manual_review_count(rows: list[CompanionV2Candidate]) -> int:
    return sum(1 for row in rows if len(_v2_manual_review_reasons(row)) >= 2)


def _structural_stats(rows: list[CompanionV2Candidate]) -> dict[str, Any]:
    short_count = sum(1 for row in rows if row.regen.candidate.path_bucket == "short")
    medium_plus_count = sum(1 for row in rows if row.regen.candidate.path_bucket != "short")
    noncanonical_count = sum(1 for row in rows if not row.regen.target_identity_canonical)
    low_degree_bridge_count = sum(1 for row in rows if row.regen.candidate.witness_low_degree_bridge_count > 0)
    easy_corridor_zero_count = sum(1 for row in rows if row.regen.candidate.family_easy_corridor_path_count == 0)
    mean_choke_share = sum(row.regen.shortest_choke_share_max for row in rows) / float(len(rows) or 1)
    family_overlap_mean = sum(row.family_count for row in rows) / float(len(rows) or 1)
    family_overlap_max = max((row.family_count for row in rows), default=0)
    return {
        "short_count": short_count,
        "medium_plus_count": medium_plus_count,
        "noncanonical_count": noncanonical_count,
        "low_degree_bridge_count": low_degree_bridge_count,
        "easy_corridor_zero_count": easy_corridor_zero_count,
        "mean_choke_share": mean_choke_share,
        "manual_review_count": _manual_review_count(rows),
        "family_overlap_mean": family_overlap_mean,
        "family_overlap_max": family_overlap_max,
    }


def _structural_violations(stats: dict[str, Any]) -> dict[str, float]:
    violations: dict[str, float] = {}
    if stats["short_count"] > SHORT_PATH_MAX:
        violations["short_excess"] = float(stats["short_count"] - SHORT_PATH_MAX)
    if stats["medium_plus_count"] < MEDIUM_PLUS_MIN:
        violations["medium_deficit"] = float(MEDIUM_PLUS_MIN - stats["medium_plus_count"])
    if stats["noncanonical_count"] < NONCANONICAL_MIN:
        violations["noncanonical_deficit"] = float(NONCANONICAL_MIN - stats["noncanonical_count"])
    if stats["low_degree_bridge_count"] > LOW_DEGREE_BRIDGE_MAX:
        violations["bridge_excess"] = float(stats["low_degree_bridge_count"] - LOW_DEGREE_BRIDGE_MAX)
    if stats["easy_corridor_zero_count"] > EASY_CORRIDOR_ZERO_MAX:
        violations["easy_corridor_excess"] = float(stats["easy_corridor_zero_count"] - EASY_CORRIDOR_ZERO_MAX)
    if stats["mean_choke_share"] > MEAN_CHOKE_SHARE_MAX:
        violations["choke_excess"] = float(stats["mean_choke_share"] - MEAN_CHOKE_SHARE_MAX)
    if stats["manual_review_count"] > MANUAL_REVIEW_MAX:
        violations["manual_review_excess"] = float(stats["manual_review_count"] - MANUAL_REVIEW_MAX)
    if stats["family_overlap_max"] > FAMILY_OVERLAP_MAX:
        violations["overlap_excess"] = float(stats["family_overlap_max"] - FAMILY_OVERLAP_MAX)
    return violations


def _would_improve(
    *,
    remove: CompanionV2Candidate,
    add: CompanionV2Candidate,
    violations: dict[str, float],
) -> bool:
    improve = 0
    if "short_excess" in violations and remove.regen.candidate.path_bucket == "short" and add.regen.candidate.path_bucket != "short":
        improve += 1
    if "medium_deficit" in violations and remove.regen.candidate.path_bucket == "short" and add.regen.candidate.path_bucket != "short":
        improve += 1
    if "noncanonical_deficit" in violations and remove.regen.target_identity_canonical and not add.regen.target_identity_canonical:
        improve += 1
    if "bridge_excess" in violations and remove.regen.candidate.witness_low_degree_bridge_count > 0 and add.regen.candidate.witness_low_degree_bridge_count == 0:
        improve += 1
    if "easy_corridor_excess" in violations and remove.regen.candidate.family_easy_corridor_path_count == 0 and add.regen.candidate.family_easy_corridor_path_count > 0:
        improve += 1
    if "choke_excess" in violations and add.regen.shortest_choke_share_max < remove.regen.shortest_choke_share_max:
        improve += 1
    if "manual_review_excess" in violations and len(_v2_manual_review_reasons(add)) < len(_v2_manual_review_reasons(remove)):
        improve += 1
    if "overlap_excess" in violations and add.family_count < remove.family_count:
        improve += 1
    return improve > 0 and _selection_score(add) >= _selection_score(remove) - 1.0


def _repair_selection(
    *,
    selected: list[CompanionV2Candidate],
    alternates_by_family: dict[str, list[CompanionV2Candidate]],
    family_counts: Counter[str],
) -> list[CompanionV2Candidate]:
    rows = list(selected)
    used_pairs = {_candidate_key(row) for row in rows}
    used_targets = {row.regen.candidate.target for row in rows}
    start_counts = Counter(row.regen.candidate.start for row in rows)
    signature_counts = Counter(row.regen.signature for row in rows)
    target_bucket_counts = Counter(_target_bucket(row.regen.candidate) for row in rows)

    for _ in range(MAX_REPAIR_PASSES):
        stats = _structural_stats(rows)
        violations = _structural_violations(stats)
        if not violations:
            break
        replaced = False
        offenders = sorted(
            rows,
            key=lambda row: (
                -row.offender_score,
                -row.family_count,
                -row.regen.shortest_choke_share_max,
                row.regen.candidate.shortest_path_hops,
                _selection_score(row),
            ),
        )
        for remove in offenders:
            family = remove.primary_family
            for add in alternates_by_family.get(family, []):
                add_pair = _candidate_key(add)
                if add_pair in used_pairs:
                    continue
                if add.regen.candidate.target in used_targets:
                    continue
                if start_counts[add.regen.candidate.start] >= REGEN_MAX_PER_START and add.regen.candidate.start != remove.regen.candidate.start:
                    continue
                if signature_counts[add.regen.signature] >= REGEN_MAX_PER_SIGNATURE and add.regen.signature != remove.regen.signature:
                    continue
                if target_bucket_counts[_target_bucket(add.regen.candidate)] >= TARGET_BUCKET_CAP and _target_bucket(add.regen.candidate) != _target_bucket(remove.regen.candidate):
                    continue
                if not _would_improve(remove=remove, add=add, violations=violations):
                    continue

                rows.remove(remove)
                rows.append(add)
                used_pairs.remove(_candidate_key(remove))
                used_targets.remove(remove.regen.candidate.target)
                start_counts[remove.regen.candidate.start] -= 1
                signature_counts[remove.regen.signature] -= 1
                target_bucket_counts[_target_bucket(remove.regen.candidate)] -= 1

                used_pairs.add(add_pair)
                used_targets.add(add.regen.candidate.target)
                start_counts[add.regen.candidate.start] += 1
                signature_counts[add.regen.signature] += 1
                target_bucket_counts[_target_bucket(add.regen.candidate)] += 1
                replaced = True
                break
            if replaced:
                break
        if not replaced:
            break
    return rows


def _representative_family_sample(rows: list[CompanionV2Candidate], count: int) -> list[CompanionV2Candidate]:
    ordered = sorted(
        rows,
        key=lambda row: (
            -_selection_score(row),
            _stable_rank(0, "repr", row.regen.candidate.start, row.regen.candidate.target),
        ),
    )
    if len(ordered) <= count:
        return ordered
    chosen_indices = sorted({round(index * (len(ordered) - 1) / float(count - 1)) for index in range(count)})
    return [ordered[index] for index in chosen_indices[:count]]


def _write_matchups(path: Path, rows: Iterable[Any]) -> None:
    payload = "\n".join(json.dumps(row.model_dump(mode="json"), ensure_ascii=False) for row in rows)
    path.write_text(payload + ("\n" if payload else ""), "utf-8")


def _write_jsonl(path: Path, rows: Iterable[dict[str, Any]]) -> None:
    payload = "\n".join(json.dumps(row, ensure_ascii=False) for row in rows)
    path.write_text(payload + ("\n" if payload else ""), "utf-8")


def _v2_payload(row: CompanionV2Candidate) -> dict[str, Any]:
    candidate = row.regen.candidate
    return {
        "start": candidate.start,
        "target": candidate.target,
        "source_status": row.regen.source_status,
        "source_slice_id": row.regen.source_slice_id,
        "source_reasons": list(row.regen.source_reasons),
        "shortest_path_hops": candidate.shortest_path_hops,
        "shortest_path": list(candidate.shortest_path),
        "path_bucket": candidate.path_bucket,
        "start_width_bucket": candidate.start_width_bucket,
        "target_in_degree": candidate.target_in_degree,
        "shortest_path_count": candidate.shortest_path_count,
        "family_easy_corridor_path_count": candidate.family_easy_corridor_path_count,
        "witness_low_degree_bridge_count": candidate.witness_low_degree_bridge_count,
        "witness_informative_bridge_count": candidate.witness_informative_bridge_count,
        "target_identity_canonical": row.regen.target_identity_canonical,
        "shortest_choke_share_max": round(row.regen.shortest_choke_share_max, 4),
        "first_strong_choke_depth": row.regen.first_strong_choke_depth,
        "strong_choke_count": row.regen.strong_choke_count,
        "early_offpath_total": row.regen.early_offpath_total,
        "early_dead_end_ratio": round(row.regen.early_dead_end_ratio, 4),
        "early_carrier_ratio": round(row.regen.early_carrier_ratio, 4),
        "early_informative_escape_count": row.regen.early_informative_escape_count,
        "local_information_poverty": row.regen.local_information_poverty,
        "wrong_turn_tax_mean": None if row.regen.wrong_turn_tax_mean is None else round(row.regen.wrong_turn_tax_mean, 4),
        "rejoinable_ratio": None if row.regen.rejoinable_ratio is None else round(row.regen.rejoinable_ratio, 4),
        "unreachable_ratio": None if row.regen.unreachable_ratio is None else round(row.regen.unreachable_ratio, 4),
        "hard_score": round(row.regen.hard_score, 4),
        "family_labels": list(row.regen.family_labels),
        "primary_family": row.primary_family,
        "family_count": row.family_count,
        "offender_score": round(row.offender_score, 4),
        "family_score": round(row.family_score, 4),
        "selection_score": round(_selection_score(row), 4),
        "signature": list(row.regen.signature),
        "manual_review_reasons": list(_v2_manual_review_reasons(row)),
    }


def generate_frontier_companion_regen_v2_fixed_suite(
    *,
    db_path: Path,
    out_dir: Path,
    suite_id: str = FRONTIER_COMPANION_REGEN_V2_SUITE_ID,
    seed: int = 0,
) -> dict[str, list[Any]]:
    if suite_id != FRONTIER_COMPANION_REGEN_V2_SUITE_ID:
        raise ValueError(f"Unsupported regenerated companion v2 suite id: {suite_id!r}")

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
        filtered_records = _load_source_records()
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
            cheap_candidates.append(
                RegenCandidate(
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
            )

        shortlisted = _build_shortlist(cheap_candidates)
        enriched_candidates = _enrich_candidates(db_path=db_path, shortlisted=shortlisted)

        family_pools: dict[str, list[CompanionV2Candidate]] = defaultdict(list)
        for row in enriched_candidates:
            family_pools[row.primary_family].append(row)

        selected: list[CompanionV2Candidate] = []
        used_pairs: set[tuple[str, str]] = set()
        used_targets: set[str] = set()
        start_counts: Counter[str] = Counter()
        signature_counts: Counter[tuple[str, ...]] = Counter()
        target_bucket_counts: Counter[str] = Counter()
        for family in PRIMARY_FAMILY_ORDER:
            _select_family_quota_v2(
                family=family,
                quota=PRIMARY_FAMILY_QUOTAS[family],
                pool=family_pools.get(family, []),
                selected=selected,
                used_pairs=used_pairs,
                used_targets=used_targets,
                start_counts=start_counts,
                signature_counts=signature_counts,
                target_bucket_counts=target_bucket_counts,
            )

        alternates_by_family: dict[str, list[CompanionV2Candidate]] = defaultdict(list)
        selected_pairs = {_candidate_key(row) for row in selected}
        for family in PRIMARY_FAMILY_ORDER:
            alternates = [row for row in family_pools.get(family, []) if _candidate_key(row) not in selected_pairs]
            alternates_by_family[family] = sorted(
                alternates,
                key=lambda row: (
                    -_selection_score(row),
                    -row.family_score,
                    _stable_rank(0, family, row.regen.candidate.start, row.regen.candidate.target),
                ),
            )

        repaired = _repair_selection(
            selected=selected,
            alternates_by_family=alternates_by_family,
            family_counts=Counter(row.primary_family for row in selected),
        )
        repaired = sorted(
            repaired,
            key=lambda row: (
                row.primary_family,
                -_selection_score(row),
                _stable_rank(0, "selected", row.regen.candidate.start, row.regen.candidate.target),
            ),
        )

        final_matchups = [
            _candidate_to_matchup(
                row.regen.candidate,
                suite_id=suite_id,
                slice_id=row.primary_family,
                index=index,
            )
            for index, row in enumerate(repaired, start=1)
        ]

        by_family_selected: dict[str, list[CompanionV2Candidate]] = defaultdict(list)
        for row in repaired:
            by_family_selected[row.primary_family].append(row)
        canary_rows: list[CompanionV2Candidate] = []
        for family in PRIMARY_FAMILY_ORDER:
            canary_rows.extend(_representative_family_sample(by_family_selected[family], CANARY_FAMILY_COUNTS[family]))
        canary_matchups = [
            _candidate_to_matchup(
                row.regen.candidate,
                suite_id=suite_id,
                slice_id=row.primary_family,
                index=index,
            )
            for index, row in enumerate(canary_rows, start=1)
        ]

        out_dir.mkdir(parents=True, exist_ok=True)
        _write_matchups(out_dir / ALL_DATASET_FILENAME, final_matchups)
        _write_matchups(out_dir / "canary.jsonl", canary_matchups)
        _write_jsonl(out_dir / "selection_records.jsonl", (_v2_payload(row) for row in repaired))
        _write_jsonl(out_dir / "enriched_pool.jsonl", (_v2_payload(row) for row in enriched_candidates))

        alternates_payloads = []
        for family in PRIMARY_FAMILY_ORDER:
            alternates_payloads.extend(_v2_payload(row) for row in alternates_by_family[family][:20])
        _write_jsonl(out_dir / "alternates.jsonl", alternates_payloads)

        manual_review_rows = [
            payload
            for payload in (_v2_payload(row) for row in repaired)
            if len(payload["manual_review_reasons"]) >= 2
        ]
        manual_review_rows.sort(
            key=lambda row: (
                -len(row["manual_review_reasons"]),
                -float(row["offender_score"]),
                -float(row["hard_score"]),
                row["start"],
                row["target"],
            )
        )
        _write_jsonl(out_dir / "manual_review_queue.jsonl", manual_review_rows[:V2_MANUAL_REVIEW_LIMIT])

        stats = _structural_stats(repaired)
        report = {
            "source_suite_id": FRONTIER_V1_1_SUITE_ID,
            "source_candidate_pool": str(_source_candidate_pool_path()),
            "source_audit": str(_source_audit_path()),
            "filtered_count": len(filtered_records),
            "pre_dag_count": len(pre_dag_records),
            "cheap_candidate_count": len(cheap_candidates),
            "shortlist_count": len(shortlisted),
            "enriched_candidate_count": len(enriched_candidates),
            "family_pool_counts": {family: len(family_pools.get(family, [])) for family in PRIMARY_FAMILY_ORDER},
            "final_counts": dict(Counter(row.primary_family for row in repaired)),
            "final_path_buckets": dict(Counter(row.regen.candidate.path_bucket for row in repaired)),
            "final_start_width_buckets": dict(Counter(str(row.regen.candidate.start_width_bucket or "") for row in repaired)),
            "final_target_identity_canonical_false": stats["noncanonical_count"],
            "final_low_degree_bridge_one_plus": stats["low_degree_bridge_count"],
            "final_easy_corridor_zero": stats["easy_corridor_zero_count"],
            "mean_hard_score": round(sum(row.regen.hard_score for row in repaired) / float(len(repaired) or 1), 4),
            "mean_offender_score": round(sum(row.offender_score for row in repaired) / float(len(repaired) or 1), 4),
            "mean_choke_share": round(stats["mean_choke_share"], 4),
            "manual_review_count": len(manual_review_rows),
            "family_overlap_mean": round(stats["family_overlap_mean"], 4),
            "family_overlap_max": stats["family_overlap_max"],
            "structural_limits": {
                "short_max": SHORT_PATH_MAX,
                "medium_plus_min": MEDIUM_PLUS_MIN,
                "noncanonical_min": NONCANONICAL_MIN,
                "low_degree_bridge_max": LOW_DEGREE_BRIDGE_MAX,
                "easy_corridor_zero_max": EASY_CORRIDOR_ZERO_MAX,
                "mean_choke_share_max": MEAN_CHOKE_SHARE_MAX,
                "manual_review_max": MANUAL_REVIEW_MAX,
                "family_overlap_max": FAMILY_OVERLAP_MAX,
            },
            "structural_violations": _structural_violations(stats),
        }
        manifest = {
            "suite_id": suite_id,
            "source_suite_id": FRONTIER_V1_1_SUITE_ID,
            "generator_version": FRONTIER_COMPANION_REGEN_V2_GENERATOR_VERSION,
            "selection_mode": "regen_v2_repair_loop",
            "seed": seed,
            "primary_family_quotas": PRIMARY_FAMILY_QUOTAS,
            "canary_family_counts": CANARY_FAMILY_COUNTS,
            "db_path": str(db_path),
            "db_sha256": sha256_file(db_path),
            "selection_artifacts": {
                "canary": "canary.jsonl",
                "selection_records": "selection_records.jsonl",
                "enriched_pool": "enriched_pool.jsonl",
                "alternates": "alternates.jsonl",
                "manual_review_queue": "manual_review_queue.jsonl",
                "structural_report": "structural_report.json",
            },
            "report_summary": report,
        }
        (out_dir / "suite_manifest.json").write_text(json.dumps(manifest, indent=2) + "\n", "utf-8")
        (out_dir / "structural_report.json").write_text(json.dumps(report, indent=2) + "\n", "utf-8")

        slices: dict[str, list[Any]] = defaultdict(list)
        for matchup, row in zip(final_matchups, repaired, strict=False):
            slices[row.primary_family].append(matchup)
        return dict(slices)
    finally:
        graph.close()
        db.close()
