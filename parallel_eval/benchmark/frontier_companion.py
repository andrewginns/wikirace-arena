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
    _stable_rank,
)
from parallel_eval.benchmark.schema import MatchupV1, read_jsonl
from parallel_eval.benchmark.utils import sha256_file

REPO_ROOT = Path(__file__).resolve().parents[2]
FRONTIER_COMPANION_V0_1_SUITE_ID = "frontier_local_simplewiki_v1_1_companion101_v0_1"
FRONTIER_COMPANION_V0_1_GENERATOR_VERSION = "frontier_local_simplewiki_v1_1_companion101_v0_1_gen1"
FRONTIER_COMPANION_V0_2_DIAG_SUITE_ID = "frontier_local_simplewiki_v1_1_companion101_v0_2_diag"
FRONTIER_COMPANION_V0_2_DIAG_GENERATOR_VERSION = "frontier_local_simplewiki_v1_1_companion101_v0_2_diag_gen1"
FRONTIER_COMPANION_V0_1_SLICE_COUNTS: dict[str, int] = {
    "core_rank_v1": 21,
    "diag_canonical_target_v1": 22,
    "diag_target_rarity_v1": 24,
    "diag_bridge_pressure_v1": 22,
    "diag_dead_end_prone_v1": 12,
}
FRONTIER_COMPANION_V0_2_DIAG_SLICE_COUNTS: dict[str, int] = {
    "diag_bridge_pressure_v1": 34,
    "diag_dead_end_prone_v1": 26,
    "core_rank_v1": 23,
    "diag_target_rarity_v1": 14,
    "diag_canonical_target_v1": 4,
}
FRONTIER_COMPANION_V0_1_ALTERNATE_COUNT = 19
FRONTIER_COMPANION_V0_1_CANARY_COUNT = 36
FRONTIER_COMPANION_V0_1_MAX_PER_START = 2
FRONTIER_COMPANION_V0_2_DIAG_ALTERNATE_COUNT = 24
FRONTIER_COMPANION_V0_2_DIAG_CANARY_COUNT = 40
FRONTIER_COMPANION_V0_2_DIAG_MAX_PER_START = 2

COMPANION_SOFT_BANDS: dict[str, dict[str, tuple[int, int]]] = {
    "path_bucket": {
        "short": (52, 62),
        "medium": (39, 49),
    },
    "start_width_bucket": {
        "narrow": (30, 38),
        "normal": (28, 36),
        "broad": (25, 33),
    },
    "informative_bucket": {
        "0": (8, 14),
        "1": (45, 60),
        "2+": (25, 35),
    },
    "easy_corridor_bucket": {
        "0": (30, 45),
        "1-2": (35, 50),
        "3-4": (8, 15),
        "5+": (0, 5),
    },
    "target_in_degree_bucket": {
        "<=4": (20, 30),
        "5-6": (18, 28),
        "7-10": (28, 38),
        "11+": (12, 20),
    },
    "shortest_path_count_bucket": {
        "1": (0, 8),
        "2-3": (20, 35),
        "4-8": (28, 40),
        "9+": (18, 28),
    },
    "low_degree_bridge_bucket": {
        "0": (25, 35),
        "1+": (66, 76),
    },
}
COMPANION_V0_2_DIAG_SOFT_BANDS: dict[str, dict[str, tuple[int, int]]] = {
    "path_bucket": {
        "short": (42, 58),
        "medium": (43, 59),
    },
    "start_width_bucket": {
        "narrow": (28, 42),
        "normal": (25, 38),
        "broad": (15, 25),
    },
    "informative_bucket": {
        "0": (15, 25),
        "1": (55, 70),
        "2+": (0, 10),
    },
    "easy_corridor_bucket": {
        "0": (70, 85),
        "1-2": (15, 30),
        "3-4": (0, 0),
        "5+": (0, 0),
    },
    "target_in_degree_bucket": {
        "<=4": (20, 32),
        "5-6": (20, 32),
        "7-10": (22, 36),
        "11+": (6, 16),
    },
    "shortest_path_count_bucket": {
        "1": (4, 8),
        "2-3": (30, 45),
        "4-8": (30, 50),
        "9+": (0, 12),
    },
    "low_degree_bridge_bucket": {
        "0": (0, 26),
        "1+": (75, 101),
    },
}

COMPANION_DOMINANT_HARD99_MOTIF_LIMIT = 15
COMPANION_CONTROLLER_TRAP_LIMIT = 10
COMPANION_EASY_CORRIDOR_5P_LIMIT = 5
COMPANION_UNIQUE_ROUTE_LIMIT = 8
COMPANION_DEAD_END_UNIQUE_ROUTE_LIMIT = 2
COMPANION_CORE_BROAD_LIMIT = 12
COMPANION_V0_2_DIAG_DOMINANT_HARD99_MOTIF_LIMIT = 0
COMPANION_V0_2_DIAG_CONTROLLER_TRAP_LIMIT = 10
COMPANION_V0_2_DIAG_EASY_CORRIDOR_5P_LIMIT = 0
COMPANION_V0_2_DIAG_UNIQUE_ROUTE_LIMIT = 8
COMPANION_V0_2_DIAG_DEAD_END_UNIQUE_ROUTE_LIMIT = 2
COMPANION_V0_2_DIAG_CORE_BROAD_LIMIT = 12
COMPANION_TRANCHE_BANDS: dict[str, tuple[int, int]] = {
    "orthogonal_backbone": (45, 60),
    "medium_anchor": (20, 30),
    "flex_fill": (18, 35),
}
COMPANION_V0_2_DIAG_TRANCHE_BANDS: dict[str, tuple[int, int]] = {
    "orthogonal_backbone": (55, 75),
    "medium_anchor": (12, 24),
    "flex_fill": (10, 25),
}


@dataclass(frozen=True)
class CompanionConfig:
    suite_id: str
    generator_version: str
    selection_mode: str
    slice_counts: dict[str, int]
    alternate_count: int
    canary_count: int
    canary_slice_counts: dict[str, int]
    max_per_start: int
    soft_bands: dict[str, dict[str, tuple[int, int]]]
    dominant_hard99_motif_limit: int
    controller_trap_limit: int
    easy_corridor_5p_limit: int
    unique_route_limit: int
    dead_end_unique_route_limit: int
    core_broad_limit: int
    tranche_bands: dict[str, tuple[int, int]]
    selection_notes: tuple[str, ...]
    slice_bonus: dict[str, float]
    aggressive: bool = False
    max_easy_corridor_34: Optional[int] = None
    max_informative_two_plus: Optional[int] = None
    min_low_degree_bridge_one_plus: Optional[int] = None


def _companion_config(suite_id: str) -> CompanionConfig:
    if suite_id == FRONTIER_COMPANION_V0_1_SUITE_ID:
        return CompanionConfig(
            suite_id=FRONTIER_COMPANION_V0_1_SUITE_ID,
            generator_version=FRONTIER_COMPANION_V0_1_GENERATOR_VERSION,
            selection_mode="reserve_only_quota_constrained_v0_1",
            slice_counts=dict(FRONTIER_COMPANION_V0_1_SLICE_COUNTS),
            alternate_count=FRONTIER_COMPANION_V0_1_ALTERNATE_COUNT,
            canary_count=FRONTIER_COMPANION_V0_1_CANARY_COUNT,
            canary_slice_counts={
                "core_rank_v1": 7,
                "diag_canonical_target_v1": 7,
                "diag_target_rarity_v1": 8,
                "diag_bridge_pressure_v1": 8,
                "diag_dead_end_prone_v1": 6,
            },
            max_per_start=FRONTIER_COMPANION_V0_1_MAX_PER_START,
            soft_bands=COMPANION_SOFT_BANDS,
            dominant_hard99_motif_limit=COMPANION_DOMINANT_HARD99_MOTIF_LIMIT,
            controller_trap_limit=COMPANION_CONTROLLER_TRAP_LIMIT,
            easy_corridor_5p_limit=COMPANION_EASY_CORRIDOR_5P_LIMIT,
            unique_route_limit=COMPANION_UNIQUE_ROUTE_LIMIT,
            dead_end_unique_route_limit=COMPANION_DEAD_END_UNIQUE_ROUTE_LIMIT,
            core_broad_limit=COMPANION_CORE_BROAD_LIMIT,
            tranche_bands=COMPANION_TRANCHE_BANDS,
            selection_notes=(
                "Separate companion set selected from the frontier v1.1 reserve pool.",
                "Designed to complement the current hard99 without merging into it.",
                "Uses exact slice quotas, overlap bans, anti-motif caps, and soft-band repair over reserve candidates only.",
            ),
            slice_bonus={
                "diag_target_rarity_v1": 3.1,
                "diag_bridge_pressure_v1": 3.0,
                "diag_canonical_target_v1": 2.7,
                "diag_dead_end_prone_v1": 2.6,
                "core_rank_v1": 1.9,
            },
        )
    if suite_id == FRONTIER_COMPANION_V0_2_DIAG_SUITE_ID:
        return CompanionConfig(
            suite_id=FRONTIER_COMPANION_V0_2_DIAG_SUITE_ID,
            generator_version=FRONTIER_COMPANION_V0_2_DIAG_GENERATOR_VERSION,
            selection_mode="reserve_only_aggressive_diag_v0_2",
            slice_counts=dict(FRONTIER_COMPANION_V0_2_DIAG_SLICE_COUNTS),
            alternate_count=FRONTIER_COMPANION_V0_2_DIAG_ALTERNATE_COUNT,
            canary_count=FRONTIER_COMPANION_V0_2_DIAG_CANARY_COUNT,
            canary_slice_counts={
                "diag_bridge_pressure_v1": 13,
                "diag_dead_end_prone_v1": 10,
                "core_rank_v1": 9,
                "diag_target_rarity_v1": 6,
                "diag_canonical_target_v1": 2,
            },
            max_per_start=FRONTIER_COMPANION_V0_2_DIAG_MAX_PER_START,
            soft_bands=COMPANION_V0_2_DIAG_SOFT_BANDS,
            dominant_hard99_motif_limit=COMPANION_V0_2_DIAG_DOMINANT_HARD99_MOTIF_LIMIT,
            controller_trap_limit=COMPANION_V0_2_DIAG_CONTROLLER_TRAP_LIMIT,
            easy_corridor_5p_limit=COMPANION_V0_2_DIAG_EASY_CORRIDOR_5P_LIMIT,
            unique_route_limit=COMPANION_V0_2_DIAG_UNIQUE_ROUTE_LIMIT,
            dead_end_unique_route_limit=COMPANION_V0_2_DIAG_DEAD_END_UNIQUE_ROUTE_LIMIT,
            core_broad_limit=COMPANION_V0_2_DIAG_CORE_BROAD_LIMIT,
            tranche_bands=COMPANION_V0_2_DIAG_TRANCHE_BANDS,
            selection_notes=(
                "Aggressive reserve-only diagnostic recut over the frontier v1.1 reserve pool.",
                "Designed as a falsification probe before DB-level pool regeneration.",
                "Standalone canonical-target softness is removed except for tightly coupled structural exceptions.",
            ),
            slice_bonus={
                "diag_bridge_pressure_v1": 4.4,
                "diag_dead_end_prone_v1": 4.0,
                "core_rank_v1": 3.1,
                "diag_target_rarity_v1": 2.2,
                "diag_canonical_target_v1": -1.5,
            },
            aggressive=True,
            max_easy_corridor_34=0,
            max_informative_two_plus=10,
            min_low_degree_bridge_one_plus=75,
        )
    raise ValueError(f"Unsupported companion suite id: {suite_id!r}")


@dataclass(frozen=True)
class CompanionSelectionRecord:
    candidate: CandidateMatchup
    slice_id: str
    record: dict[str, Any]
    base_score: float
    tranche: str
    manual_review: bool
    gating_flags: tuple[str, ...]
    novelty_signature: tuple[str, ...]


@dataclass
class CompanionSelectionResult:
    selected: list[CompanionSelectionRecord]
    alternates: list[CompanionSelectionRecord]
    manifest: dict[str, Any]
    report: dict[str, Any]


def _jsonl_payload(path: Path, rows: Iterable[dict[str, Any]]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    payload = "\n".join(json.dumps(row, ensure_ascii=False) for row in rows)
    path.write_text(payload + ("\n" if payload else ""), "utf-8")


def _write_matchups_jsonl(path: Path, rows: Iterable[MatchupV1]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    payload = "\n".join(json.dumps(row.model_dump(mode="json"), ensure_ascii=False) for row in rows)
    path.write_text(payload + ("\n" if payload else ""), "utf-8")


def _source_suite_dir() -> Path:
    return REPO_ROOT / "benchmarks" / "matchups" / FRONTIER_V1_1_SUITE_ID


def _source_candidate_pool_path() -> Path:
    return _source_suite_dir() / "candidate_pool.jsonl"


def _source_audit_path() -> Path:
    return _source_suite_dir() / "audit" / "frontier200_item_audit.v0_1.jsonl"


def _bucket_informative(value: Optional[int]) -> str:
    if value is None or value <= 0:
        return "0"
    if value == 1:
        return "1"
    return "2+"


def _bucket_easy_corridor(value: Optional[int]) -> str:
    if value is None or value <= 0:
        return "0"
    if value <= 2:
        return "1-2"
    if value <= 4:
        return "3-4"
    return "5+"


def _bucket_target_in_degree(value: Optional[int]) -> str:
    if value is None or value <= 4:
        return "<=4"
    if value <= 6:
        return "5-6"
    if value <= 10:
        return "7-10"
    return "11+"


def _bucket_shortest_path_count(value: Optional[int]) -> str:
    if value is None or value <= 1:
        return "1"
    if value <= 3:
        return "2-3"
    if value <= 8:
        return "4-8"
    return "9+"


def _bucket_low_degree_bridge(value: Optional[int]) -> str:
    return "0" if (value or 0) <= 0 else "1+"


def _dominant_hard99_motif(candidate: CandidateMatchup) -> bool:
    return (
        candidate.tier == "core_rank_v1"
        and candidate.path_bucket == "medium"
        and candidate.witness_informative_bridge_count >= 2
        and candidate.witness_low_degree_bridge_count >= 1
        and candidate.start_width_bucket in {"narrow", "normal"}
    )


def _controller_trap(candidate: CandidateMatchup) -> bool:
    return candidate.family_easy_corridor_path_count >= 3 and candidate.shortest_path_count >= 9


def _core_rank_is_non_vanilla(candidate: CandidateMatchup) -> bool:
    return (
        candidate.path_bucket == "short"
        or candidate.start_width_bucket == "broad"
        or candidate.witness_low_degree_bridge_count <= 0
        or candidate.target_in_degree >= 7
        or candidate.witness_informative_bridge_count <= 1
    )


def _canonical_surfacey(candidate: CandidateMatchup) -> bool:
    return (
        candidate.tier == "diag_canonical_target_v1"
        and candidate.start_width_bucket == "broad"
        and candidate.target_in_degree >= 11
        and candidate.witness_informative_bridge_count <= 0
        and candidate.family_easy_corridor_path_count >= 1
    )


def _load_hard99_audit(audit_path: Path) -> list[dict[str, Any]]:
    rows: list[dict[str, Any]] = []
    for line in read_jsonl(audit_path):
        row = line.data
        if row.get("primary_slice") == "controller_hard":
            rows.append(row)
    return rows


def _load_candidate_pool(path: Path) -> list[dict[str, Any]]:
    return [line.data for line in read_jsonl(path)]


def _record_to_candidate(record: dict[str, Any]) -> CandidateMatchup:
    return CandidateMatchup(
        start=str(record["start"]),
        target=str(record["target"]),
        shortest_path_hops=int(record["shortest_path_hops"]),
        shortest_path=[str(part) for part in record.get("shortest_path") or []],
        path_bucket=str(record.get("path_bucket") or ""),
        start_out_degree=int(record.get("start_out_degree") or 0),
        target_in_degree=int(record.get("target_in_degree") or 0),
        start_width_bucket=record.get("start_width_bucket"),
        feature_tags=tuple(str(tag) for tag in record.get("feature_tags") or []),
        tier=str(record.get("slice_id") or record.get("tier") or ""),
        stable_rank=_stable_rank(
            0,
            str(record.get("suite_id") or FRONTIER_V1_1_SUITE_ID),
            str(record["start"]),
            str(record["target"]),
        ),
        shortest_path_count=int(record.get("shortest_path_count") or 1),
        sampled_shortest_path_count=int(record.get("sampled_shortest_path_count") or 1),
        sampled_shortest_paths=tuple(tuple(str(part) for part in path) for path in record.get("sampled_shortest_paths") or ()),
        witness_artifact_bridge_count=int(record.get("witness_artifact_bridge_count") or 0),
        witness_carrier_bridge_count=int(record.get("witness_carrier_bridge_count") or 0),
        witness_informative_bridge_count=int(record.get("witness_informative_bridge_count") or 0),
        witness_low_degree_bridge_count=int(record.get("witness_low_degree_bridge_count") or 0),
        witness_hub_bridge_count=int(record.get("witness_hub_bridge_count") or 0),
        family_artifact_path_count=int(record.get("family_artifact_path_count") or 0),
        family_easy_corridor_path_count=int(record.get("family_easy_corridor_path_count") or 0),
        family_carrier_bridge_count_min=int(record.get("family_carrier_bridge_count_min") or 0),
        family_carrier_bridge_count_max=int(record.get("family_carrier_bridge_count_max") or 0),
        family_informative_bridge_count_min=int(record.get("family_informative_bridge_count_min") or 0),
        family_informative_bridge_count_max=int(record.get("family_informative_bridge_count_max") or 0),
    )


def _candidate_signature(candidate: CandidateMatchup) -> tuple[str, ...]:
    return (
        candidate.tier,
        candidate.path_bucket,
        str(candidate.start_width_bucket or ""),
        _bucket_informative(candidate.witness_informative_bridge_count),
        _bucket_low_degree_bridge(candidate.witness_low_degree_bridge_count),
        _bucket_target_in_degree(candidate.target_in_degree),
    )


def _tranche(candidate: CandidateMatchup) -> str:
    if (
        candidate.path_bucket == "medium"
        and candidate.start_width_bucket in {"narrow", "normal"}
        and candidate.witness_informative_bridge_count >= 2
        and candidate.family_easy_corridor_path_count <= 1
    ):
        return "medium_anchor"
    if candidate.tier in {"diag_canonical_target_v1", "diag_target_rarity_v1", "diag_bridge_pressure_v1", "diag_dead_end_prone_v1"}:
        return "orthogonal_backbone"
    return "flex_fill"


def _hard_signal_count(candidate: CandidateMatchup) -> int:
    signals = 0
    if candidate.witness_low_degree_bridge_count > 0:
        signals += 1
    if candidate.shortest_path_count <= 3:
        signals += 1
    if candidate.witness_informative_bridge_count <= 1:
        signals += 1
    if candidate.family_easy_corridor_path_count <= 0:
        signals += 1
    if _controller_trap(candidate):
        signals += 1
    if candidate.tier in {"diag_bridge_pressure_v1", "diag_dead_end_prone_v1"}:
        signals += 1
    return signals


def _canonical_exception_candidate(candidate: CandidateMatchup) -> bool:
    return (
        candidate.witness_low_degree_bridge_count > 0
        and candidate.family_easy_corridor_path_count == 0
        and candidate.witness_informative_bridge_count <= 1
        and (candidate.shortest_path_count <= 3 or _controller_trap(candidate))
    )


def _rarity_coupled_candidate(candidate: CandidateMatchup) -> bool:
    return (
        candidate.family_easy_corridor_path_count <= 1
        and candidate.witness_informative_bridge_count <= 1
        and (
            candidate.witness_low_degree_bridge_count > 0
            or candidate.shortest_path_count <= 3
            or _controller_trap(candidate)
        )
    )


def _base_score(
    candidate: CandidateMatchup,
    hard99_signature_counts: Counter[tuple[str, ...]],
    *,
    config: CompanionConfig,
) -> float:
    score = 0.0
    score += config.slice_bonus.get(candidate.tier, 0.0)

    info_bucket = _bucket_informative(candidate.witness_informative_bridge_count)
    corridor_bucket = _bucket_easy_corridor(candidate.family_easy_corridor_path_count)
    target_bucket = _bucket_target_in_degree(candidate.target_in_degree)
    spc_bucket = _bucket_shortest_path_count(candidate.shortest_path_count)

    if config.aggressive:
        score += 1.3 if candidate.path_bucket == "medium" else 0.7
        width_bonus = {"broad": 0.25, "normal": 0.35, "narrow": 0.45}
        score += width_bonus.get(str(candidate.start_width_bucket or ""), 0.0)
        score += {"0": 1.4, "1": 1.0, "2+": -1.25}[info_bucket]
        score += {"0": 1.8, "1-2": 0.4, "3-4": -2.5, "5+": -6.0}[corridor_bucket]
        score += {"<=4": 0.35, "5-6": 0.8, "7-10": 0.95, "11+": -0.1}[target_bucket]
        score += {"1": 1.3, "2-3": 1.0, "4-8": 0.5, "9+": -0.25}[spc_bucket]
        score += 1.8 if candidate.witness_low_degree_bridge_count > 0 else -1.2
        score += 0.7 if candidate.family_artifact_path_count <= 0 else -2.0
        score += 0.45 * float(_hard_signal_count(candidate))
        if _controller_trap(candidate):
            score += 0.9
        if candidate.shortest_path_count == 1:
            score += 0.65
        if candidate.tier == "diag_canonical_target_v1":
            score -= 1.5
            if _canonical_exception_candidate(candidate):
                score += 1.0
    else:
        if candidate.path_bucket == "short":
            score += 1.5
        elif candidate.path_bucket == "medium":
            score += 1.0

        width_bonus = {
            "broad": 1.0,
            "normal": 0.6,
            "narrow": 0.3,
        }
        score += width_bonus.get(str(candidate.start_width_bucket or ""), 0.0)
        score += {"0": 0.25, "1": 0.75, "2+": 0.35}[info_bucket]
        score += {"0": 0.25, "1-2": 1.1, "3-4": 0.55, "5+": -1.0}[corridor_bucket]
        score += {"<=4": 0.35, "5-6": 0.75, "7-10": 1.1, "11+": 0.65}[target_bucket]
        score += {"1": -0.8, "2-3": 0.55, "4-8": 0.85, "9+": 0.25}[spc_bucket]
        if candidate.witness_low_degree_bridge_count <= 0:
            score += 0.85
        if candidate.family_artifact_path_count <= 0:
            score += 0.25

    hard99_count = hard99_signature_counts.get(_candidate_signature(candidate), 0)
    score += 1.4 if hard99_count == 0 else max(-1.0, 0.6 - 0.35 * hard99_count)

    if _dominant_hard99_motif(candidate):
        score -= 1.0
    if not config.aggressive:
        if _controller_trap(candidate):
            score -= 1.25
        if candidate.family_easy_corridor_path_count >= 5:
            score -= 1.5
        if candidate.shortest_path_count == 1:
            score -= 0.6
        if candidate.tier == "diag_canonical_target_v1" and candidate.family_easy_corridor_path_count <= 2:
            score += 0.35
        if candidate.tier == "core_rank_v1" and _core_rank_is_non_vanilla(candidate):
            score += 0.55
    return score


def _gating_flags(candidate: CandidateMatchup) -> tuple[str, ...]:
    flags: list[str] = []
    if candidate.witness_informative_bridge_count <= 0:
        flags.append("informative_zero")
    if candidate.shortest_path_count == 1:
        flags.append("single_route")
    if candidate.family_easy_corridor_path_count >= 3:
        flags.append("easy_corridor_ge3")
    if candidate.family_easy_corridor_path_count >= 5:
        flags.append("easy_corridor_ge5")
    if candidate.tier == "diag_dead_end_prone_v1" and candidate.shortest_path_count == 1:
        flags.append("dead_end_unique_route")
    if _dominant_hard99_motif(candidate):
        flags.append("hard99_dominant_motif")
    if _controller_trap(candidate):
        flags.append("controller_trap")
    return tuple(flags)


def _manual_review(candidate: CandidateMatchup, *, config: CompanionConfig) -> bool:
    if config.aggressive:
        return any(
            (
                candidate.witness_informative_bridge_count <= 1,
                candidate.witness_low_degree_bridge_count > 0,
                candidate.shortest_path_count <= 3,
                candidate.family_easy_corridor_path_count <= 1,
                candidate.tier in {"diag_target_rarity_v1", "diag_canonical_target_v1"},
                _controller_trap(candidate),
            )
        )
    return any(
        (
            candidate.witness_informative_bridge_count <= 0,
            candidate.shortest_path_count == 1,
            candidate.family_easy_corridor_path_count >= 3,
            candidate.tier == "diag_dead_end_prone_v1" and candidate.shortest_path_count == 1,
        )
    )


def _passes_hard_gate(candidate: CandidateMatchup, *, config: CompanionConfig) -> bool:
    if candidate.family_artifact_path_count > 0:
        return False
    if candidate.tier == "core_rank_v1" and not _core_rank_is_non_vanilla(candidate):
        return False
    if candidate.tier == "core_rank_v1" and candidate.family_easy_corridor_path_count >= 3:
        return False
    if candidate.witness_informative_bridge_count <= 0:
        if candidate.tier not in {"diag_canonical_target_v1", "diag_target_rarity_v1", "diag_dead_end_prone_v1"}:
            return False
        if candidate.family_easy_corridor_path_count > 1:
            return False
        if candidate.shortest_path_count > 8:
            return False
        if candidate.target_in_degree > 10:
            return False
    if config.aggressive and candidate.path_bucket == "short" and _hard_signal_count(candidate) < 2:
        return False
    if config.aggressive and candidate.family_easy_corridor_path_count >= 3:
        return False
    if candidate.tier == "diag_canonical_target_v1":
        if config.aggressive and not _canonical_exception_candidate(candidate):
            return False
        if candidate.family_easy_corridor_path_count > 2:
            return False
        if not config.aggressive and _canonical_surfacey(candidate):
            return False
    if config.aggressive and candidate.tier == "diag_target_rarity_v1" and not _rarity_coupled_candidate(candidate):
        return False
    if candidate.tier == "diag_dead_end_prone_v1" and candidate.shortest_path_count == 1:
        return False
    if candidate.family_easy_corridor_path_count >= 5 and candidate.shortest_path_count >= 9:
        return False
    return True


def _band_value(axis: str, candidate: CandidateMatchup) -> str:
    if axis == "path_bucket":
        return candidate.path_bucket
    if axis == "start_width_bucket":
        return str(candidate.start_width_bucket or "")
    if axis == "informative_bucket":
        return _bucket_informative(candidate.witness_informative_bridge_count)
    if axis == "easy_corridor_bucket":
        return _bucket_easy_corridor(candidate.family_easy_corridor_path_count)
    if axis == "target_in_degree_bucket":
        return _bucket_target_in_degree(candidate.target_in_degree)
    if axis == "shortest_path_count_bucket":
        return _bucket_shortest_path_count(candidate.shortest_path_count)
    if axis == "low_degree_bridge_bucket":
        return _bucket_low_degree_bridge(candidate.witness_low_degree_bridge_count)
    raise KeyError(axis)


def _selection_counts(selected: Iterable[CompanionSelectionRecord], *, config: CompanionConfig) -> dict[str, Counter[str]]:
    rows = list(selected)
    counts: dict[str, Counter[str]] = {}
    for axis in config.soft_bands:
        counts[axis] = Counter(_band_value(axis, row.candidate) for row in rows)
    counts["slice_id"] = Counter(row.slice_id for row in rows)
    counts["tranche"] = Counter(row.tranche for row in rows)
    return counts


def _objective(selected: list[CompanionSelectionRecord], *, config: CompanionConfig) -> float:
    penalty = 0.0
    counts = _selection_counts(selected, config=config)
    for axis, bands in config.soft_bands.items():
        axis_counts = counts.get(axis, Counter())
        for bucket, (low, high) in bands.items():
            current = axis_counts.get(bucket, 0)
            if current < low:
                penalty += float(low - current) * 5.0
            elif current > high:
                penalty += float(current - high) * 5.0
    dominant = sum(1 for row in selected if _dominant_hard99_motif(row.candidate))
    if dominant > config.dominant_hard99_motif_limit:
        penalty += float(dominant - config.dominant_hard99_motif_limit) * 20.0
    controller_traps = sum(1 for row in selected if _controller_trap(row.candidate))
    if controller_traps > config.controller_trap_limit:
        penalty += float(controller_traps - config.controller_trap_limit) * 20.0
    very_easy = sum(1 for row in selected if row.candidate.family_easy_corridor_path_count >= 5)
    if very_easy > config.easy_corridor_5p_limit:
        penalty += float(very_easy - config.easy_corridor_5p_limit) * 25.0
    single_route = sum(1 for row in selected if row.candidate.shortest_path_count == 1)
    if single_route > config.unique_route_limit:
        penalty += float(single_route - config.unique_route_limit) * 20.0
    dead_end_single_route = sum(
        1 for row in selected if row.slice_id == "diag_dead_end_prone_v1" and row.candidate.shortest_path_count == 1
    )
    if dead_end_single_route > config.dead_end_unique_route_limit:
        penalty += float(dead_end_single_route - config.dead_end_unique_route_limit) * 30.0
    tranche_counts = counts.get("tranche", Counter())
    for tranche, (low, high) in config.tranche_bands.items():
        current = tranche_counts.get(tranche, 0)
        if current < low:
            penalty += float(low - current) * 5.0
        elif current > high:
            penalty += float(current - high) * 5.0
    core_broad = sum(
        1 for row in selected if row.slice_id == "core_rank_v1" and row.candidate.start_width_bucket == "broad"
    )
    if core_broad > config.core_broad_limit:
        penalty += float(core_broad - config.core_broad_limit) * 20.0
    if config.max_easy_corridor_34 is not None:
        easy_34 = counts.get("easy_corridor_bucket", Counter()).get("3-4", 0)
        if easy_34 > config.max_easy_corridor_34:
            penalty += float(easy_34 - config.max_easy_corridor_34) * 40.0
    if config.max_informative_two_plus is not None:
        info_2p = counts.get("informative_bucket", Counter()).get("2+", 0)
        if info_2p > config.max_informative_two_plus:
            penalty += float(info_2p - config.max_informative_two_plus) * 20.0
    if config.min_low_degree_bridge_one_plus is not None:
        low_degree_one_plus = counts.get("low_degree_bridge_bucket", Counter()).get("1+", 0)
        if low_degree_one_plus < config.min_low_degree_bridge_one_plus:
            penalty += float(config.min_low_degree_bridge_one_plus - low_degree_one_plus) * 15.0
    return penalty


def _can_add(
    candidate_record: CompanionSelectionRecord,
    selected: list[CompanionSelectionRecord],
    selected_starts: Counter[str],
    selected_targets: set[str],
    *,
    config: CompanionConfig,
) -> bool:
    candidate = candidate_record.candidate
    if candidate.target in selected_targets:
        return False
    if selected_starts.get(candidate.start, 0) >= config.max_per_start:
        return False
    if sum(1 for row in selected if _dominant_hard99_motif(row.candidate)) >= config.dominant_hard99_motif_limit and _dominant_hard99_motif(candidate):
        return False
    if sum(1 for row in selected if _controller_trap(row.candidate)) >= config.controller_trap_limit and _controller_trap(candidate):
        return False
    if sum(1 for row in selected if row.candidate.family_easy_corridor_path_count >= 5) >= config.easy_corridor_5p_limit and candidate.family_easy_corridor_path_count >= 5:
        return False
    if sum(1 for row in selected if row.candidate.shortest_path_count == 1) >= config.unique_route_limit and candidate.shortest_path_count == 1:
        return False
    if (
        sum(1 for row in selected if row.slice_id == "diag_dead_end_prone_v1" and row.candidate.shortest_path_count == 1)
        >= config.dead_end_unique_route_limit
        and candidate.tier == "diag_dead_end_prone_v1"
        and candidate.shortest_path_count == 1
    ):
        return False
    if (
        candidate.tier == "core_rank_v1"
        and candidate.start_width_bucket == "broad"
        and sum(1 for row in selected if row.slice_id == "core_rank_v1" and row.candidate.start_width_bucket == "broad")
        >= config.core_broad_limit
    ):
        return False
    if config.max_easy_corridor_34 is not None and _bucket_easy_corridor(candidate.family_easy_corridor_path_count) == "3-4":
        existing_easy_34 = sum(
            1 for row in selected if _bucket_easy_corridor(row.candidate.family_easy_corridor_path_count) == "3-4"
        )
        if existing_easy_34 >= config.max_easy_corridor_34:
            return False
    if config.max_informative_two_plus is not None and _bucket_informative(candidate.witness_informative_bridge_count) == "2+":
        existing_info_2p = sum(
            1 for row in selected if _bucket_informative(row.candidate.witness_informative_bridge_count) == "2+"
        )
        if existing_info_2p >= config.max_informative_two_plus:
            return False
    if config.min_low_degree_bridge_one_plus is not None and candidate.witness_low_degree_bridge_count <= 0:
        max_zero = sum(config.slice_counts.values()) - config.min_low_degree_bridge_one_plus
        existing_zero = sum(1 for row in selected if row.candidate.witness_low_degree_bridge_count <= 0)
        if existing_zero >= max_zero:
            return False
    return True


def _dynamic_score(
    candidate_record: CompanionSelectionRecord,
    selected: list[CompanionSelectionRecord],
    *,
    config: CompanionConfig,
) -> float:
    score = candidate_record.base_score
    counts = _selection_counts(selected, config=config)
    for axis, bands in config.soft_bands.items():
        value = _band_value(axis, candidate_record.candidate)
        low, high = bands[value]
        current = counts.get(axis, Counter()).get(value, 0)
        if current < low:
            score += 2.25 + 0.15 * float(low - current)
        elif current >= high:
            score -= 2.5 + 0.10 * float(current - high)
    tranche_current = counts.get("tranche", Counter()).get(candidate_record.tranche, 0)
    tranche_low, tranche_high = config.tranche_bands[candidate_record.tranche]
    if tranche_current < tranche_low:
        score += 2.5 + 0.20 * float(tranche_low - tranche_current)
    elif tranche_current >= tranche_high:
        score -= 2.75 + 0.20 * float(tranche_current - tranche_high)
    internal_nodes = candidate_record.candidate.shortest_path[1:-1]
    selected_internal_counts = Counter(
        node
        for row in selected
        for node in row.candidate.shortest_path[1:-1]
    )
    overlap_penalty = sum(selected_internal_counts.get(node, 0) for node in internal_nodes)
    score -= float(overlap_penalty) * 0.20
    return score


def _repair_selection(
    selected: list[CompanionSelectionRecord],
    alternates_by_slice: dict[str, list[CompanionSelectionRecord]],
    *,
    config: CompanionConfig,
) -> list[CompanionSelectionRecord]:
    current = list(selected)
    improved = True
    while improved:
        improved = False
        best_penalty = _objective(current, config=config)
        for idx, row in enumerate(list(current)):
            pool = alternates_by_slice.get(row.slice_id) or []
            selected_starts = Counter(item.candidate.start for item in current if item is not row)
            selected_targets = {item.candidate.target for item in current if item is not row}
            for replacement in pool:
                if replacement in current:
                    continue
                if replacement.candidate.target in selected_targets:
                    continue
                if selected_starts.get(replacement.candidate.start, 0) >= config.max_per_start:
                    continue
                trial = current[:idx] + [replacement] + current[idx + 1 :]
                penalty = _objective(trial, config=config)
                if penalty + 1e-9 < best_penalty:
                    current = trial
                    best_penalty = penalty
                    improved = True
                    break
            if improved:
                break
    return current


def build_frontier_companion_selection(
    *,
    candidate_pool_path: Path,
    hard99_audit_path: Path,
    suite_id: str = FRONTIER_COMPANION_V0_1_SUITE_ID,
    seed: int = 0,
) -> CompanionSelectionResult:
    config = _companion_config(suite_id)
    hard99_audit = _load_hard99_audit(hard99_audit_path)
    hard99_starts = {str(row["start"]) for row in hard99_audit}
    hard99_targets = {str(row["target"]) for row in hard99_audit}
    hard99_pairs = {(str(row["start"]), str(row["target"])) for row in hard99_audit}

    raw_candidate_pool = _load_candidate_pool(candidate_pool_path)
    hard99_signature_counts: Counter[tuple[str, ...]] = Counter()
    reserve_candidates: list[CompanionSelectionRecord] = []
    for row in raw_candidate_pool:
        pair = (str(row.get("start") or ""), str(row.get("target") or ""))
        candidate = _record_to_candidate(row)
        if pair in hard99_pairs:
            hard99_signature_counts[_candidate_signature(candidate)] += 1
            continue
        if row.get("status") != "reserve":
            continue
        if candidate.start in hard99_starts or candidate.target in hard99_targets:
            continue
        if not _passes_hard_gate(candidate, config=config):
            continue
        record = dict(row)
        base_score = _base_score(candidate, hard99_signature_counts, config=config)
        reserve_candidates.append(
            CompanionSelectionRecord(
                candidate=candidate,
                slice_id=candidate.tier,
                record=record,
                base_score=base_score,
                tranche=_tranche(candidate),
                manual_review=_manual_review(candidate, config=config),
                gating_flags=_gating_flags(candidate),
                novelty_signature=_candidate_signature(candidate),
            )
        )

    by_slice: dict[str, list[CompanionSelectionRecord]] = defaultdict(list)
    for row in reserve_candidates:
        by_slice[row.slice_id].append(row)
    for slice_rows in by_slice.values():
        slice_rows.sort(
            key=lambda row: (
                -row.base_score,
                _stable_rank(seed, row.candidate.start, row.candidate.target),
            )
        )

    selected: list[CompanionSelectionRecord] = []
    selected_starts: Counter[str] = Counter()
    selected_targets: set[str] = set()
    slice_order = sorted(
        config.slice_counts,
        key=lambda slice_id: (len(by_slice.get(slice_id, ())), config.slice_counts[slice_id]),
    )
    per_slice_selected: dict[str, list[CompanionSelectionRecord]] = defaultdict(list)

    for slice_id in slice_order:
        needed = config.slice_counts[slice_id]
        pool = list(by_slice.get(slice_id) or [])
        while len(per_slice_selected[slice_id]) < needed:
            feasible = [
                row
                for row in pool
                if row not in selected and _can_add(row, selected, selected_starts, selected_targets, config=config)
            ]
            if not feasible:
                raise RuntimeError(f"Unable to satisfy slice quota for {slice_id}: selected={len(per_slice_selected[slice_id])}, needed={needed}")
            best = max(
                feasible,
                key=lambda row: (
                    _dynamic_score(row, selected, config=config),
                    row.base_score,
                    _stable_rank(seed, row.candidate.start, row.candidate.target),
                ),
            )
            selected.append(best)
            per_slice_selected[slice_id].append(best)
            selected_starts[best.candidate.start] += 1
            selected_targets.add(best.candidate.target)

    alternates_by_slice: dict[str, list[CompanionSelectionRecord]] = defaultdict(list)
    for slice_id, pool in by_slice.items():
        for row in pool:
            if row in selected:
                continue
            alternates_by_slice[slice_id].append(row)
        alternates_by_slice[slice_id].sort(
            key=lambda row: (
                -row.base_score,
                _stable_rank(seed + 17, row.candidate.start, row.candidate.target),
            )
        )

    repaired = _repair_selection(selected, alternates_by_slice, config=config)
    repaired_keys = {(row.candidate.start, row.candidate.target) for row in repaired}
    alternates: list[CompanionSelectionRecord] = []
    slice_order_for_alternates = sorted(
        config.slice_counts,
        key=lambda slice_id: config.slice_counts[slice_id],
        reverse=True,
    )
    while len(alternates) < config.alternate_count:
        added = False
        for slice_id in slice_order_for_alternates:
            for row in alternates_by_slice.get(slice_id, []):
                key = (row.candidate.start, row.candidate.target)
                if key in repaired_keys or any(
                    existing.candidate.start == row.candidate.start and existing.candidate.target == row.candidate.target
                    for existing in alternates
                ):
                    continue
                alternates.append(row)
                added = True
                break
            if len(alternates) >= config.alternate_count:
                break
        if not added:
            break

    report = {
        "source_suite_id": FRONTIER_V1_1_SUITE_ID,
        "source_candidate_pool": str(candidate_pool_path),
        "source_audit": str(hard99_audit_path),
        "hard99_count": len(hard99_audit),
        "filtered_reserve_count": len(reserve_candidates),
        "available_counts_by_slice": dict(Counter(row.slice_id for row in reserve_candidates)),
        "selected_counts_by_slice": dict(Counter(row.slice_id for row in repaired)),
        "selected_counts": _selection_counts(repaired, config=config),
        "alternate_counts_by_slice": dict(Counter(row.slice_id for row in alternates)),
        "objective_penalty": _objective(repaired, config=config),
        "manual_review_count": sum(1 for row in repaired if row.manual_review),
        "dominant_hard99_motif_count": sum(1 for row in repaired if _dominant_hard99_motif(row.candidate)),
        "controller_trap_count": sum(1 for row in repaired if _controller_trap(row.candidate)),
        "easy_corridor_ge5_count": sum(1 for row in repaired if row.candidate.family_easy_corridor_path_count >= 5),
        "single_route_count": sum(1 for row in repaired if row.candidate.shortest_path_count == 1),
    }
    report["soft_band_deltas"] = {
        axis: {
            bucket: {
                "selected": report["selected_counts"].get(axis, {}).get(bucket, 0),
                "low": low,
                "high": high,
            }
            for bucket, (low, high) in bands.items()
        }
        for axis, bands in config.soft_bands.items()
    }

    manifest = {
        "suite_id": config.suite_id,
        "source_suite_id": FRONTIER_V1_1_SUITE_ID,
        "generator_version": config.generator_version,
        "selection_mode": config.selection_mode,
        "seed": seed,
        "slice_counts": config.slice_counts,
        "soft_bands": config.soft_bands,
        "hard_caps": {
            "dominant_hard99_motif_limit": config.dominant_hard99_motif_limit,
            "controller_trap_limit": config.controller_trap_limit,
            "easy_corridor_5p_limit": config.easy_corridor_5p_limit,
            "unique_route_limit": config.unique_route_limit,
            "dead_end_unique_route_limit": config.dead_end_unique_route_limit,
            "max_per_start": config.max_per_start,
            "exact_target_reuse_with_hard99": 0,
            "exact_start_reuse_with_hard99": 0,
        },
        "selection_notes": list(config.selection_notes),
    }
    if config.max_easy_corridor_34 is not None:
        manifest["hard_caps"]["easy_corridor_3_4_limit"] = config.max_easy_corridor_34
    if config.max_informative_two_plus is not None:
        manifest["hard_caps"]["informative_2plus_limit"] = config.max_informative_two_plus
    if config.min_low_degree_bridge_one_plus is not None:
        manifest["hard_caps"]["low_degree_bridge_one_plus_floor"] = config.min_low_degree_bridge_one_plus

    return CompanionSelectionResult(selected=repaired, alternates=alternates, manifest=manifest, report=report)


def _record_payload(row: CompanionSelectionRecord) -> dict[str, Any]:
    payload = dict(row.record)
    payload.update(
        {
            "companion_base_score": round(row.base_score, 4),
            "companion_tranche": row.tranche,
            "companion_manual_review": row.manual_review,
            "companion_gating_flags": list(row.gating_flags),
            "companion_novelty_signature": list(row.novelty_signature),
            "companion_hard_signal_count": _hard_signal_count(row.candidate),
        }
    )
    return payload


def _stratified_canary(
    selected: list[CompanionSelectionRecord],
    *,
    seed: int,
    config: CompanionConfig,
) -> list[CompanionSelectionRecord]:
    per_slice_targets = config.canary_slice_counts
    by_slice: dict[str, list[CompanionSelectionRecord]] = defaultdict(list)
    for row in selected:
        by_slice[row.slice_id].append(row)
    canary: list[CompanionSelectionRecord] = []
    for slice_id, count in per_slice_targets.items():
        pool = sorted(
            by_slice.get(slice_id, []),
            key=lambda row: (
                row.manual_review,
                -row.base_score,
                _stable_rank(seed + 101, row.candidate.start, row.candidate.target),
            ),
        )
        canary.extend(pool[:count])
    return canary[:config.canary_count]


def generate_frontier_companion_fixed_suite(
    *,
    db_path: Path,
    out_dir: Path,
    suite_id: str = FRONTIER_COMPANION_V0_1_SUITE_ID,
    seed: int = 0,
) -> dict[str, list[MatchupV1]]:
    config = _companion_config(suite_id)
    candidate_pool_path = _source_candidate_pool_path()
    audit_path = _source_audit_path()
    result = build_frontier_companion_selection(
        candidate_pool_path=candidate_pool_path,
        hard99_audit_path=audit_path,
        suite_id=suite_id,
        seed=seed,
    )

    out_dir.mkdir(parents=True, exist_ok=True)
    selected_matchups: list[MatchupV1] = []
    matchup_slices: dict[str, list[MatchupV1]] = defaultdict(list)
    for index, row in enumerate(result.selected, start=1):
        matchup = _candidate_to_matchup(row.candidate, suite_id=suite_id, slice_id=row.slice_id, index=index)
        selected_matchups.append(matchup)
        matchup_slices[row.slice_id].append(matchup)

    canary_rows = _stratified_canary(result.selected, seed=seed, config=config)
    canary_matchups = [
        _candidate_to_matchup(row.candidate, suite_id=suite_id, slice_id=row.slice_id, index=index)
        for index, row in enumerate(canary_rows, start=1)
    ]
    alternate_matchups = [
        _candidate_to_matchup(row.candidate, suite_id=suite_id, slice_id=row.slice_id, index=index)
        for index, row in enumerate(result.alternates, start=1)
    ]

    _write_matchups_jsonl(out_dir / ALL_DATASET_FILENAME, selected_matchups)
    for slice_id, rows in matchup_slices.items():
        _write_matchups_jsonl(out_dir / f"{slice_id}.jsonl", rows)
    _write_matchups_jsonl(out_dir / "canary.jsonl", canary_matchups)
    _write_matchups_jsonl(out_dir / "alternates.jsonl", alternate_matchups)

    _jsonl_payload(out_dir / "selection_records.jsonl", (_record_payload(row) for row in result.selected))
    _jsonl_payload(out_dir / "alternate_records.jsonl", (_record_payload(row) for row in result.alternates))

    review_rows = []
    for index, row in enumerate(result.selected, start=1):
        if not row.manual_review:
            continue
        review_rows.append(
            {
                "matchup_id": f"{suite_id}-{row.slice_id}-{index:04d}",
                "source_title": row.candidate.start,
                "target_title": row.candidate.target,
                "slice_id": row.slice_id,
                "tranche": row.tranche,
                "path_bucket": row.candidate.path_bucket,
                "start_width_bucket": row.candidate.start_width_bucket,
                "target_in_degree": row.candidate.target_in_degree,
                "witness_informative_bridge_count": row.candidate.witness_informative_bridge_count,
                "witness_low_degree_bridge_count": row.candidate.witness_low_degree_bridge_count,
                "family_easy_corridor_path_count": row.candidate.family_easy_corridor_path_count,
                "shortest_path_count": row.candidate.shortest_path_count,
                "companion_base_score": round(row.base_score, 4),
                "companion_hard_signal_count": _hard_signal_count(row.candidate),
                "gating_flags": list(row.gating_flags),
                "novelty_signature": list(row.novelty_signature),
                "manual_review": row.manual_review,
                "shortest_path": list(row.candidate.shortest_path),
            }
        )
    _jsonl_payload(out_dir / "manual_review_queue.jsonl", review_rows)

    manifest = dict(result.manifest)
    manifest.update(
        {
            "suite_id": suite_id,
            "db_path": str(db_path),
            "db_sha256": sha256_file(db_path),
            "source_suite_dir": str(_source_suite_dir()),
            "selection_artifacts": {
                "selection_records": "selection_records.jsonl",
                "alternate_records": "alternate_records.jsonl",
                "manual_review_queue": "manual_review_queue.jsonl",
                "canary": "canary.jsonl",
                "alternates": "alternates.jsonl",
                "structural_report": "structural_report.json",
            },
            "report_summary": result.report,
        }
    )
    (out_dir / "suite_manifest.json").write_text(json.dumps(manifest, indent=2) + "\n", "utf-8")
    (out_dir / "structural_report.json").write_text(json.dumps(result.report, indent=2) + "\n", "utf-8")

    return dict(matchup_slices)
