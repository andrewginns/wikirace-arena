from __future__ import annotations

import hashlib
import json
import math
import random
import re
import tempfile
import unicodedata
from collections import Counter, defaultdict
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Callable, Optional

from parallel_eval.benchmark.graph import DegreeStats, SQLiteGraph, bfs_shortest_path_dag, compute_degrees
from parallel_eval.benchmark.schema import MatchupV1
from parallel_eval.benchmark.settings import CLASSIC_LOCAL_V1
from parallel_eval.benchmark.semantics import canonicalize_title
from parallel_eval.benchmark.utils import sha256_file

CLASSIC_SUITE_ID = "classic_local_simplewiki_v1"
FRONTIER_SUITE_ID = "frontier_local_simplewiki_v1"
FRONTIER_V1_1_SUITE_ID = "frontier_local_simplewiki_v1_1"
FRONTIER_V1_2_SUITE_ID = "frontier_local_simplewiki_v1_2"
FRONTIER_STANDARD_SUITE_ID = "frontier_local_simplewiki_standard_v1"
FRONTIER_REGRESSION_SUITE_ID = "frontier_local_simplewiki_regression_v1"
FRONTIER_COMPANION_V0_1_SUITE_ID = "frontier_local_simplewiki_v1_1_companion101_v0_1"
FRONTIER_COMPANION_V0_2_DIAG_SUITE_ID = "frontier_local_simplewiki_v1_1_companion101_v0_2_diag"
FRONTIER_COMPANION_REGEN_V1_SUITE_ID = "frontier_local_simplewiki_v1_1_companion101_v1_0_regen"
FRONTIER_COMPANION_REGEN_V2_SUITE_ID = "frontier_local_simplewiki_v1_1_companion101_v2_0"
DEFAULT_SUITE_ID = FRONTIER_STANDARD_SUITE_ID
GRAPH_NATIVE_GENERATOR_VERSION = "classic_local_simplewiki_v1_gen1"
FRONTIER_GENERATOR_VERSION = "frontier_local_simplewiki_v1_gen1"
FRONTIER_V1_1_GENERATOR_VERSION = "frontier_local_simplewiki_v1_1_gen1"
FRONTIER_STANDARD_GENERATOR_VERSION = "frontier_local_simplewiki_standard_v1_alias1"
FRONTIER_REGRESSION_GENERATOR_VERSION = "frontier_local_simplewiki_regression_v1_alias1"
ALL_DATASET_FILENAME = "all.jsonl"
MATCHUPS_ROOT = Path(__file__).resolve().parents[2] / "benchmarks" / "matchups"
WIDTH_BUCKETS = ("narrow", "normal", "broad")
GRAPH_NATIVE_CORE_CELL_QUOTAS: dict[tuple[str, str], int] = {
    ("short", "narrow"): 25,
    ("short", "normal"): 25,
    ("short", "broad"): 25,
    ("medium", "narrow"): 25,
    ("medium", "normal"): 25,
    ("medium", "broad"): 25,
}
GRAPH_NATIVE_SLICE_COUNTS: dict[str, int] = {
    "core_rank_v1": 150,
    "diag_wide_choice_v1": 10,
    "diag_hub_escape_v1": 10,
    "diag_hub_seek_v1": 10,
    "diag_canonical_target_v1": 10,
    "diag_dead_end_prone_v1": 10,
}
FRONTIER_CORE_CELL_QUOTAS: dict[tuple[str, str], int] = {
    ("short", "narrow"): 10,
    ("short", "normal"): 10,
    ("short", "broad"): 10,
    ("medium", "narrow"): 45,
    ("medium", "normal"): 45,
    ("medium", "broad"): 30,
}
FRONTIER_SLICE_COUNTS: dict[str, int] = {
    "core_rank_v1": 150,
    "diag_dead_end_prone_v1": 20,
    "diag_canonical_target_v1": 10,
    "diag_target_rarity_v1": 10,
    "diag_bridge_pressure_v1": 10,
}
FRONTIER_V1_1_CORE_CELL_QUOTAS: dict[tuple[str, str], int] = {
    ("short", "narrow"): 5,
    ("short", "normal"): 5,
    ("short", "broad"): 5,
    ("medium", "narrow"): 45,
    ("medium", "normal"): 45,
    ("medium", "broad"): 30,
}
FRONTIER_V1_1_SLICE_COUNTS: dict[str, int] = {
    "core_rank_v1": 135,
    "diag_dead_end_prone_v1": 20,
    "diag_canonical_target_v1": 10,
    "diag_target_rarity_v1": 10,
    "diag_bridge_pressure_v1": 25,
}
CORE_START_SCAN_LIMIT_PER_BUCKET = 220
DIAG_START_SCAN_LIMIT = 300
DEAD_END_CANDIDATE_SCAN_LIMIT = 600
SHORTEST_PATH_COUNT_CAP = 128
SHORTEST_PATH_SAMPLE_LIMIT = 8
HOLDOUT_TARGET_COUNT = 50
TRAJECTORY_SPINE_COUNT = 60
WEAK_BRIDGE_PREFIXES = (
    "list of",
    "deaths in ",
    "births in ",
)
WEAK_BRIDGE_TITLES = {
    "life",
    "time",
    "river",
    "year",
    "month",
    "day",
}
WEAK_BRIDGE_MONTHS = (
    "january",
    "february",
    "march",
    "april",
    "may",
    "june",
    "july",
    "august",
    "september",
    "october",
    "november",
    "december",
)
ARTIFACT_BRIDGE_PREFIXES = WEAK_BRIDGE_PREFIXES + (
    "timeline of",
    "history of",
    "outline of",
)
ARTIFACT_BRIDGE_TITLES = WEAK_BRIDGE_TITLES | {
    "century",
    "decade",
    "list",
}
GENERIC_CARRIER_TITLES = {
    "animal",
    "asia",
    "city",
    "continent",
    "country",
    "earth",
    "europe",
    "government",
    "land",
    "north america",
    "south america",
    "state",
    "tree",
    "u.s. state",
    "united states",
    "water",
    "world",
}
_YEAR_RE = re.compile(r"^\d{3,4}$")
PREBUILT_ALIAS_SUITES: dict[str, dict[str, object]] = {
    FRONTIER_STANDARD_SUITE_ID: {
        "source_suite_id": FRONTIER_V1_2_SUITE_ID,
        "jsonl_filenames": (
            ALL_DATASET_FILENAME,
            "hard99.jsonl",
            "companion101.jsonl",
        ),
        "generator_version": FRONTIER_STANDARD_GENERATOR_VERSION,
        "alias_kind": "standard",
        "notes": [
            "Standard SOTA-separating benchmark alias backed by the merged Frontier 200.",
            f"Alias materializes checked-in frozen data from {FRONTIER_V1_2_SUITE_ID}.",
        ],
    },
    FRONTIER_REGRESSION_SUITE_ID: {
        "source_suite_id": FRONTIER_V1_1_SUITE_ID,
        "jsonl_filenames": (
            ALL_DATASET_FILENAME,
            "core_rank_v1.jsonl",
            "diag_bridge_pressure_v1.jsonl",
            "diag_canonical_target_v1.jsonl",
            "diag_dead_end_prone_v1.jsonl",
            "diag_target_rarity_v1.jsonl",
        ),
        "generator_version": FRONTIER_REGRESSION_GENERATOR_VERSION,
        "alias_kind": "regression",
        "notes": [
            "Easier regression-oriented benchmark alias backed by Frontier v1.1.",
            f"Alias materializes checked-in frozen data from {FRONTIER_V1_1_SUITE_ID}.",
        ],
    },
}


def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")


def _stable_rank(seed: int, *parts: str) -> str:
    payload = "|".join([str(seed), *parts]).encode("utf-8")
    return hashlib.sha256(payload).hexdigest()


def _suite_slug(suite_id: str) -> str:
    return suite_id.replace("_", "-")


def _rewrite_suite_identity(value: str, *, source_suite_id: str, target_suite_id: str) -> str:
    source_slug = _suite_slug(source_suite_id)
    target_slug = _suite_slug(target_suite_id)
    if value.startswith(source_slug):
        return target_slug + value[len(source_slug) :]
    return value


def _rewrite_alias_payload(
    payload: dict[str, Any],
    *,
    source_suite_id: str,
    target_suite_id: str,
) -> dict[str, Any]:
    rewritten = dict(payload)
    if rewritten.get("suite_id") == source_suite_id:
        rewritten["suite_id"] = target_suite_id
    if isinstance(rewritten.get("id"), str):
        rewritten["id"] = _rewrite_suite_identity(
            rewritten["id"],
            source_suite_id=source_suite_id,
            target_suite_id=target_suite_id,
        )
    return rewritten


def _materialize_prebuilt_alias_suite(
    *,
    db_path: Path,
    out_dir: Path,
    suite_id: str,
    seed: int,
) -> dict[str, list[MatchupV1]]:
    spec = PREBUILT_ALIAS_SUITES[suite_id]
    source_suite_id = str(spec["source_suite_id"])
    source_dir = MATCHUPS_ROOT / source_suite_id
    if not source_dir.exists():
        raise FileNotFoundError(f"Missing source suite directory for alias {suite_id}: {source_dir}")

    out_dir.mkdir(parents=True, exist_ok=True)
    all_matchups: list[MatchupV1] = []
    for filename in spec["jsonl_filenames"]:
        source_path = source_dir / str(filename)
        payloads = [
            _rewrite_alias_payload(
                json.loads(line),
                source_suite_id=source_suite_id,
                target_suite_id=suite_id,
            )
            for line in source_path.read_text("utf-8").splitlines()
            if line.strip()
        ]
        _write_records_jsonl(out_dir / str(filename), payloads)
        if str(filename) == ALL_DATASET_FILENAME:
            all_matchups = [MatchupV1.model_validate(payload) for payload in payloads]

    source_manifest = json.loads((source_dir / "suite_manifest.json").read_text("utf-8"))
    notes = source_manifest.get("notes")
    if isinstance(notes, list):
        note_list = [str(note) for note in notes]
    elif isinstance(notes, str) and notes:
        note_list = [notes]
    else:
        note_list = []
    note_list.extend(str(note) for note in spec["notes"])

    manifest = dict(source_manifest)
    manifest.update(
        {
            "suite_id": suite_id,
            "generated_at": _now_iso(),
            "db_path": str(db_path),
            "db_sha256": sha256_file(db_path),
            "generator_version": str(spec["generator_version"]),
            "alias_of": source_suite_id,
            "alias_kind": str(spec["alias_kind"]),
            "seed": seed,
            "notes": note_list,
        }
    )
    (out_dir / "suite_manifest.json").write_text(json.dumps(manifest, ensure_ascii=False, indent=2) + "\n", "utf-8")

    slices: dict[str, list[MatchupV1]] = defaultdict(list)
    for matchup in all_matchups:
        slices[matchup.slice_id].append(matchup)
    return dict(slices)


def _weak_bridge_title(title: str) -> bool:
    normalized = title.replace("_", " ").strip().lower()
    if not normalized:
        return False
    if normalized in WEAK_BRIDGE_TITLES:
        return True
    if any(normalized.startswith(prefix) for prefix in WEAK_BRIDGE_PREFIXES):
        return True
    if normalized in WEAK_BRIDGE_MONTHS:
        return True
    if any(normalized.startswith(f"{month} ") for month in WEAK_BRIDGE_MONTHS):
        return True
    return False


def _weak_bridge_count(path: list[str]) -> int:
    return sum(1 for title in path[1:-1] if _weak_bridge_title(title))


def _has_weak_bridge(path: list[str]) -> bool:
    return _weak_bridge_count(path) > 0


def _normalize_ascii_title(title: str) -> str:
    normalized = unicodedata.normalize("NFKD", title.replace("_", " ").strip().lower())
    return "".join(ch for ch in normalized if not unicodedata.combining(ch))


def _artifact_bridge_title(title: str) -> bool:
    normalized = _normalize_ascii_title(title)
    if not normalized:
        return False
    if normalized in ARTIFACT_BRIDGE_TITLES:
        return True
    if any(normalized.startswith(prefix) for prefix in ARTIFACT_BRIDGE_PREFIXES):
        return True
    if normalized in WEAK_BRIDGE_MONTHS:
        return True
    if any(normalized.startswith(f"{month} ") for month in WEAK_BRIDGE_MONTHS):
        return True
    return bool(_YEAR_RE.fullmatch(normalized))


def _carrier_bridge_title(
    title: str,
    *,
    stats: Optional[DegreeStats],
    top_any_10: set[str],
) -> bool:
    normalized = _normalize_ascii_title(title)
    if not normalized:
        return False
    if normalized in GENERIC_CARRIER_TITLES:
        return True
    if stats is None:
        return False
    if title in top_any_10 and stats.out_degree >= 100 and stats.in_degree >= 25 and len(normalized.split()) <= 3:
        return True
    return False


def _informative_bridge_title(
    title: str,
    *,
    stats: Optional[DegreeStats],
    top_any_10: set[str],
) -> bool:
    if stats is None:
        return False
    return (
        not _artifact_bridge_title(title)
        and not _carrier_bridge_title(title, stats=stats, top_any_10=top_any_10)
        and 3 <= stats.out_degree <= 150
        and 2 <= stats.in_degree <= 80
    )


def _sample_shortest_paths(
    *,
    start: str,
    target: str,
    parents: dict[str, list[str]],
    limit: int,
) -> tuple[tuple[str, ...], ...]:
    cache: dict[str, list[tuple[str, ...]]] = {}

    def build(node: str) -> list[tuple[str, ...]]:
        if node == start:
            return [(start,)]
        if node in cache:
            return cache[node]
        paths: list[tuple[str, ...]] = []
        for prev in parents.get(node, []):
            for prefix in build(prev):
                paths.append(prefix + (node,))
                if len(paths) >= limit:
                    cache[node] = paths
                    return paths
        cache[node] = paths
        return paths

    if target == start:
        return ((start,),)
    return tuple(build(target)[:limit])


def _split_counts(total: int, proportions: list[tuple[str, int]], *, target_count: int) -> dict[str, int]:
    if total <= 0 or target_count <= 0:
        return {key: 0 for key, _count in proportions}
    raw = [(key, (count / total) * target_count) for key, count in proportions]
    base = {key: int(math.floor(value)) for key, value in raw}
    remaining = target_count - sum(base.values())
    order = sorted(
        raw,
        key=lambda item: (-(item[1] - math.floor(item[1])), _stable_rank(target_count, item[0])),
    )
    for key, _value in order[:remaining]:
        base[key] += 1
    return base


@dataclass(frozen=True)
class CandidateDecision:
    accepted: bool
    reasons: tuple[str, ...] = ()


def _decision(result: bool | CandidateDecision) -> CandidateDecision:
    if isinstance(result, CandidateDecision):
        return result
    return CandidateDecision(accepted=bool(result), reasons=())


def path_bucket_for_hops(hops: int) -> str:
    if 3 <= hops <= 4:
        return "short"
    if 5 <= hops <= 6:
        return "medium"
    if 7 <= hops <= 8:
        return "long"
    if 9 <= hops <= 10:
        return "stretch"
    if 11 <= hops <= 13:
        return "near_limit"
    return f"hops_{hops}"


def width_bucket_for_out_degree(out_degree: int) -> Optional[str]:
    if 5 <= out_degree <= 24:
        return "narrow"
    if 25 <= out_degree <= 99:
        return "normal"
    if 100 <= out_degree <= 249:
        return "broad"
    if out_degree >= 250:
        return "wide"
    return None


def _top_fraction_titles(
    degrees: dict[str, DegreeStats],
    *,
    fraction: float,
    value_fn: Callable[[DegreeStats], int],
) -> set[str]:
    if not degrees:
        return set()
    count = max(1, int(math.ceil(len(degrees) * fraction)))
    ordered = sorted(degrees.items(), key=lambda item: (-value_fn(item[1]), item[0]))
    return {title for title, _stats in ordered[:count]}


def _identity_canonical_title(
    db: SQLiteGraph,
    title: str,
    *,
    degrees: Optional[dict[str, DegreeStats]] = None,
) -> bool:
    if degrees is not None:
        stats = degrees.get(title)
        if stats is not None and stats.out_degree != 1:
            return True
    return canonicalize_title(db, title) == title


def _core_eligible_title(
    db: SQLiteGraph,
    title: str,
    excluded_hubs: set[str],
    *,
    degrees: dict[str, DegreeStats],
) -> bool:
    return title not in excluded_hubs and _identity_canonical_title(db, title, degrees=degrees)


def _dead_end_prone_ratio(graph: SQLiteGraph, degrees: dict[str, DegreeStats], start: str) -> float:
    links = graph.links(start)
    if not links:
        return 0.0
    low_out_degree = 0
    for link in links:
        stats = degrees.get(link)
        out_degree = stats.out_degree if stats else 0
        if out_degree <= 2:
            low_out_degree += 1
    return float(low_out_degree) / float(len(links))


def _collect_dead_end_prone_starts(
    *,
    graph: SQLiteGraph,
    db: SQLiteGraph,
    degrees: dict[str, DegreeStats],
    seed: int,
) -> list[str]:
    starts: list[str] = []
    candidate_titles = [
        title
        for title, stats in degrees.items()
        if stats.out_degree >= 15
    ]
    candidate_titles.sort(key=lambda title: _stable_rank(seed, "diag_dead_end_prone_v1", title))

    for title in candidate_titles[:DEAD_END_CANDIDATE_SCAN_LIMIT]:
        if not _identity_canonical_title(db, title, degrees=degrees):
            continue
        links = graph.links(title)
        if not isinstance(links, list):
            if _dead_end_prone_ratio(graph, degrees, title) >= 0.30:
                starts.append(title)
            continue
        if not links:
            continue

        low_out_degree = 0
        for link in links:
            link_stats = degrees.get(link)
            out_degree = link_stats.out_degree if link_stats else 0
            if out_degree <= 2:
                low_out_degree += 1

        if float(low_out_degree) / float(len(links)) >= 0.30:
            starts.append(title)

    starts.sort(key=lambda title: _stable_rank(seed, "diag_dead_end_prone_v1", title))
    return starts


@dataclass(frozen=True)
class CandidateMatchup:
    start: str
    target: str
    shortest_path_hops: int
    shortest_path: list[str]
    path_bucket: str
    start_out_degree: int
    target_in_degree: int
    start_width_bucket: Optional[str]
    feature_tags: tuple[str, ...]
    tier: str
    stable_rank: str
    shortest_path_count: int = 1
    sampled_shortest_path_count: int = 1
    sampled_shortest_paths: tuple[tuple[str, ...], ...] = ()
    witness_artifact_bridge_count: int = 0
    witness_carrier_bridge_count: int = 0
    witness_informative_bridge_count: int = 0
    witness_low_degree_bridge_count: int = 0
    witness_hub_bridge_count: int = 0
    family_artifact_path_count: int = 0
    family_easy_corridor_path_count: int = 0
    family_carrier_bridge_count_min: int = 0
    family_carrier_bridge_count_max: int = 0
    family_informative_bridge_count_min: int = 0
    family_informative_bridge_count_max: int = 0


def _count_low_degree_bridges(path: list[str], *, degrees: dict[str, DegreeStats]) -> int:
    pressure = 0
    for title in path[1:-1]:
        stats = degrees.get(title)
        if stats is not None and (stats.out_degree <= 5 or stats.in_degree <= 10):
            pressure += 1
    return pressure


def _count_hub_bridges(path: list[str], *, top_any_10: set[str]) -> int:
    return sum(1 for title in path[1:-1] if title in top_any_10)


def _count_artifact_bridges(path: list[str]) -> int:
    return sum(1 for title in path[1:-1] if _artifact_bridge_title(title))


def _count_carrier_bridges(
    path: list[str],
    *,
    degrees: dict[str, DegreeStats],
    top_any_10: set[str],
) -> int:
    count = 0
    for title in path[1:-1]:
        stats = degrees.get(title)
        if _carrier_bridge_title(title, stats=stats, top_any_10=top_any_10):
            count += 1
    return count


def _count_informative_bridges(
    path: list[str],
    *,
    degrees: dict[str, DegreeStats],
    top_any_10: set[str],
) -> int:
    count = 0
    for title in path[1:-1]:
        stats = degrees.get(title)
        if _informative_bridge_title(title, stats=stats, top_any_10=top_any_10):
            count += 1
    return count


def _is_easy_corridor_path(
    path: list[str],
    *,
    degrees: dict[str, DegreeStats],
    top_any_10: set[str],
) -> bool:
    carrier_count = _count_carrier_bridges(path, degrees=degrees, top_any_10=top_any_10)
    informative_count = _count_informative_bridges(path, degrees=degrees, top_any_10=top_any_10)
    return carrier_count >= 2 and informative_count <= 1


def _candidate_with_family_metrics(
    *,
    start: str,
    target: str,
    shortest_path_hops: int,
    shortest_path: list[str],
    start_out_degree: int,
    target_in_degree: int,
    start_width_bucket: Optional[str],
    feature_tags: tuple[str, ...],
    tier: str,
    stable_rank: str,
    shortest_path_count: int,
    sampled_shortest_paths: tuple[tuple[str, ...], ...],
    degrees: dict[str, DegreeStats],
    top_any_10: set[str],
) -> CandidateMatchup:
    sampled_paths = [list(path) for path in sampled_shortest_paths] if sampled_shortest_paths else [shortest_path]
    family_artifact_path_count = sum(1 for path in sampled_paths if _count_artifact_bridges(path) > 0)
    family_easy_corridor_path_count = sum(
        1 for path in sampled_paths if _is_easy_corridor_path(path, degrees=degrees, top_any_10=top_any_10)
    )
    carrier_counts = [
        _count_carrier_bridges(path, degrees=degrees, top_any_10=top_any_10)
        for path in sampled_paths
    ]
    informative_counts = [
        _count_informative_bridges(path, degrees=degrees, top_any_10=top_any_10)
        for path in sampled_paths
    ]
    return CandidateMatchup(
        start=start,
        target=target,
        shortest_path_hops=shortest_path_hops,
        shortest_path=shortest_path,
        path_bucket=path_bucket_for_hops(shortest_path_hops),
        start_out_degree=start_out_degree,
        target_in_degree=target_in_degree,
        start_width_bucket=start_width_bucket,
        feature_tags=feature_tags,
        tier=tier,
        stable_rank=stable_rank,
        shortest_path_count=shortest_path_count,
        sampled_shortest_path_count=len(sampled_shortest_paths) if sampled_shortest_paths else 1,
        sampled_shortest_paths=sampled_shortest_paths,
        witness_artifact_bridge_count=_count_artifact_bridges(shortest_path),
        witness_carrier_bridge_count=_count_carrier_bridges(shortest_path, degrees=degrees, top_any_10=top_any_10),
        witness_informative_bridge_count=_count_informative_bridges(shortest_path, degrees=degrees, top_any_10=top_any_10),
        witness_low_degree_bridge_count=_count_low_degree_bridges(shortest_path, degrees=degrees),
        witness_hub_bridge_count=_count_hub_bridges(shortest_path, top_any_10=top_any_10),
        family_artifact_path_count=family_artifact_path_count,
        family_easy_corridor_path_count=family_easy_corridor_path_count,
        family_carrier_bridge_count_min=min(carrier_counts, default=0),
        family_carrier_bridge_count_max=max(carrier_counts, default=0),
        family_informative_bridge_count_min=min(informative_counts, default=0),
        family_informative_bridge_count_max=max(informative_counts, default=0),
    )


def _candidate_payload(candidate: CandidateMatchup, *, suite_id: str, slice_id: str, status: str, reasons: tuple[str, ...]) -> dict[str, Any]:
    return {
        "suite_id": suite_id,
        "slice_id": slice_id,
        "tier": candidate.tier,
        "status": status,
        "reasons": list(reasons),
        "start": candidate.start,
        "target": candidate.target,
        "shortest_path_hops": candidate.shortest_path_hops,
        "shortest_path": candidate.shortest_path,
        "path_bucket": candidate.path_bucket,
        "start_out_degree": candidate.start_out_degree,
        "target_in_degree": candidate.target_in_degree,
        "start_width_bucket": candidate.start_width_bucket,
        "feature_tags": list(candidate.feature_tags),
        "shortest_path_count": candidate.shortest_path_count,
        "sampled_shortest_path_count": candidate.sampled_shortest_path_count,
        "sampled_shortest_paths": [list(path) for path in candidate.sampled_shortest_paths],
        "witness_artifact_bridge_count": candidate.witness_artifact_bridge_count,
        "witness_carrier_bridge_count": candidate.witness_carrier_bridge_count,
        "witness_informative_bridge_count": candidate.witness_informative_bridge_count,
        "witness_low_degree_bridge_count": candidate.witness_low_degree_bridge_count,
        "witness_hub_bridge_count": candidate.witness_hub_bridge_count,
        "family_artifact_path_count": candidate.family_artifact_path_count,
        "family_easy_corridor_path_count": candidate.family_easy_corridor_path_count,
        "family_carrier_bridge_count_min": candidate.family_carrier_bridge_count_min,
        "family_carrier_bridge_count_max": candidate.family_carrier_bridge_count_max,
        "family_informative_bridge_count_min": candidate.family_informative_bridge_count_min,
        "family_informative_bridge_count_max": candidate.family_informative_bridge_count_max,
    }


def _candidate_to_matchup(
    candidate: CandidateMatchup,
    *,
    suite_id: str,
    slice_id: str,
    index: int,
) -> MatchupV1:
    return MatchupV1(
        id=f"{suite_id.replace('_', '-')}-{slice_id.replace('_', '-')}-{index:04d}",
        tier=candidate.tier,
        start=candidate.start,
        target=candidate.target,
        tags=list(candidate.feature_tags),
        shortest_path_hops=candidate.shortest_path_hops,
        suite_id=suite_id,
        slice_id=slice_id,
        setup_id=CLASSIC_LOCAL_V1.id,
        prompt_version=CLASSIC_LOCAL_V1.prompt_version,
        semantics_version=CLASSIC_LOCAL_V1.semantics_version,
        shortest_path=candidate.shortest_path,
        path_bucket=candidate.path_bucket,
        start_out_degree=candidate.start_out_degree,
        target_in_degree=candidate.target_in_degree,
        start_width_bucket=candidate.start_width_bucket,
        feature_tags=list(candidate.feature_tags),
    )


def _collect_start_candidates(
    *,
    graph: SQLiteGraph,
    db: SQLiteGraph,
    degrees: dict[str, DegreeStats],
    start: str,
    max_depth: int,
    per_start_limit: int,
    seed: int,
    candidate_filter: Callable[[str, str, int], bool],
    final_target_filter: Optional[Callable[[str], bool]],
    candidate_post_filter: Optional[Callable[[CandidateMatchup], bool | CandidateDecision]],
    feature_tags: tuple[str, ...],
    tier: str,
    top_any_10: Optional[set[str]] = None,
    suite_id: Optional[str] = None,
    slice_id: Optional[str] = None,
    decision_log: Optional[list[dict[str, Any]]] = None,
) -> list[CandidateMatchup]:
    start_stats = degrees.get(start)
    if start_stats is None:
        return []

    dist_map, parents, path_counts = bfs_shortest_path_dag(
        graph,
        start=start,
        max_depth=max_depth,
        path_count_cap=SHORTEST_PATH_COUNT_CAP,
    )
    filtered_targets: list[tuple[int, str]] = []
    for target, hops in dist_map.items():
        if target == start:
            continue
        if not candidate_filter(start, target, hops):
            continue
        filtered_targets.append((hops, target))

    if not filtered_targets:
        return []

    filtered_targets.sort(key=lambda item: (_stable_rank(seed, start, item[1]), item[1]))
    selected_targets: list[tuple[int, str]] = []
    for hops, target in filtered_targets:
        if final_target_filter is not None and not final_target_filter(target):
            continue
        selected_targets.append((hops, target))
        if len(selected_targets) >= per_start_limit:
            break
    filtered_targets = selected_targets
    if not filtered_targets:
        return []

    def reconstruct_path(target: str) -> Optional[list[str]]:
        sampled_paths = _sample_shortest_paths(start=start, target=target, parents=parents, limit=1)
        if not sampled_paths:
            return None
        return list(sampled_paths[0])

    candidates: list[CandidateMatchup] = []
    effective_top_any_10 = top_any_10 or set()
    for hops, target in filtered_targets:
        path = reconstruct_path(target)
        if not path:
            continue
        if len(path) - 1 != hops:
            continue
        target_stats = degrees.get(target)
        sampled_paths = _sample_shortest_paths(
            start=start,
            target=target,
            parents=parents,
            limit=SHORTEST_PATH_SAMPLE_LIMIT,
        )
        candidate = _candidate_with_family_metrics(
            start=start,
            target=target,
            shortest_path_hops=hops,
            shortest_path=path,
            start_out_degree=start_stats.out_degree,
            target_in_degree=target_stats.in_degree if target_stats else 0,
            start_width_bucket=width_bucket_for_out_degree(start_stats.out_degree),
            feature_tags=feature_tags,
            tier=tier,
            stable_rank=_stable_rank(seed, start, target),
            shortest_path_count=min(SHORTEST_PATH_COUNT_CAP, path_counts.get(target, 1)),
            sampled_shortest_paths=sampled_paths,
            degrees=degrees,
            top_any_10=effective_top_any_10,
        )
        decision = CandidateDecision(accepted=True)
        if candidate_post_filter is not None:
            decision = _decision(candidate_post_filter(candidate))
        if decision_log is not None and suite_id and slice_id:
            decision_log.append(
                _candidate_payload(
                    candidate,
                    suite_id=suite_id,
                    slice_id=slice_id,
                    status="accepted" if decision.accepted else "rejected",
                    reasons=decision.reasons,
                )
            )
        if decision.accepted:
            candidates.append(candidate)
    return candidates


def _select_core_candidates(
    *,
    pools: dict[tuple[str, str], list[CandidateMatchup]],
    seed: int,
    core_cell_quotas: dict[tuple[str, str], int],
    preference_key: Optional[Callable[[CandidateMatchup, int], tuple[object, ...]]] = None,
) -> list[CandidateMatchup]:
    for candidates in pools.values():
        candidates.sort(key=lambda candidate: candidate.stable_rank)

    cells = list(core_cell_quotas.keys())
    required_total = sum(core_cell_quotas.values())
    for attempt in range(64):
        used_pairs: set[tuple[str, str]] = set()
        used_targets: set[str] = set()
        start_counts: Counter[str] = Counter()
        picked: list[CandidateMatchup] = []
        cell_counts: Counter[tuple[str, str]] = Counter()
        ordered_cells = sorted(
            cells,
            key=lambda cell: (
                len(pools.get(cell, [])) / max(1, core_cell_quotas[cell]),
                _stable_rank(seed + attempt, cell[0], cell[1]),
            ),
        )

        success = True
        for cell in ordered_cells:
            quota = core_cell_quotas[cell]
            while cell_counts[cell] < quota:
                eligible = [
                    candidate
                    for candidate in pools.get(cell, [])
                    if (candidate.start, candidate.target) not in used_pairs
                    and candidate.target not in used_targets
                    and start_counts[candidate.start] < 3
                ]
                if not eligible:
                    success = False
                    break
                eligible.sort(
                    key=lambda candidate: (
                        start_counts[candidate.start],
                        *(preference_key(candidate, attempt) if preference_key is not None else (_stable_rank(seed + attempt, candidate.start, candidate.target),)),
                    )
                )
                chosen = eligible[0]
                picked.append(chosen)
                used_pairs.add((chosen.start, chosen.target))
                used_targets.add(chosen.target)
                start_counts[chosen.start] += 1
                cell_counts[cell] += 1
            if not success:
                break

        if success and len(picked) == required_total:
            return sorted(picked, key=lambda candidate: candidate.stable_rank)

    raise RuntimeError("Unable to satisfy core suite quotas with the collected candidate pool.")


def _select_unique_candidates(
    *,
    candidates: list[CandidateMatchup],
    count: int,
    used_pairs: set[tuple[str, str]],
    seed: int,
    max_per_start: int = 2,
    preference_key: Optional[Callable[[CandidateMatchup, int], tuple[object, ...]]] = None,
) -> list[CandidateMatchup]:
    candidates = sorted(candidates, key=lambda candidate: candidate.stable_rank)
    start_counts: Counter[str] = Counter()
    chosen: list[CandidateMatchup] = []
    for attempt in range(32):
        start_counts.clear()
        chosen.clear()
        local_used_pairs = set(used_pairs)
        ordered = sorted(
            candidates,
            key=lambda candidate: (
                *(preference_key(candidate, attempt) if preference_key is not None else (_stable_rank(seed + attempt, candidate.start, candidate.target),)),
            ),
        )
        for candidate in ordered:
            if (candidate.start, candidate.target) in local_used_pairs:
                continue
            if start_counts[candidate.start] >= max_per_start:
                continue
            chosen.append(candidate)
            local_used_pairs.add((candidate.start, candidate.target))
            start_counts[candidate.start] += 1
            if len(chosen) >= count:
                return list(chosen)
    raise RuntimeError(f"Unable to select {count} unique diagnostic candidates.")


def _write_jsonl(path: Path, matchups: list[MatchupV1]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with open(path, "w", encoding="utf-8") as handle:
        for matchup in matchups:
            handle.write(json.dumps(matchup.model_dump(mode="json"), ensure_ascii=False) + "\n")


def _write_records_jsonl(path: Path, payloads: list[dict[str, Any]]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with open(path, "w", encoding="utf-8") as handle:
        for payload in payloads:
            handle.write(json.dumps(payload, ensure_ascii=False) + "\n")


def _core_start_lists(
    *,
    degrees: dict[str, DegreeStats],
    db: SQLiteGraph,
    excluded_hubs: set[str],
    seed: int,
    start_scan_limit_per_bucket: int = CORE_START_SCAN_LIMIT_PER_BUCKET,
) -> dict[str, list[str]]:
    starts_by_bucket: dict[str, list[str]] = {bucket: [] for bucket in WIDTH_BUCKETS}
    for title, stats in degrees.items():
        width_bucket = width_bucket_for_out_degree(stats.out_degree)
        if width_bucket not in starts_by_bucket:
            continue
        if not _core_eligible_title(db, title, excluded_hubs, degrees=degrees):
            continue
        starts_by_bucket[width_bucket].append(title)
    for bucket, starts in starts_by_bucket.items():
        starts.sort(key=lambda title: _stable_rank(seed, bucket, title))
        starts_by_bucket[bucket] = starts[:start_scan_limit_per_bucket]
    return starts_by_bucket


def _build_core_slice(
    *,
    graph: SQLiteGraph,
    db: SQLiteGraph,
    degrees: dict[str, DegreeStats],
    excluded_hubs: set[str],
    seed: int,
    core_cell_quotas: dict[tuple[str, str], int],
    core_candidate_filter: Callable[[str, str, int], bool],
    candidate_post_filter: Optional[Callable[[CandidateMatchup], bool | CandidateDecision]],
    per_start_limit: int,
    max_depth: int,
    preference_key: Optional[Callable[[CandidateMatchup, int], tuple[object, ...]]] = None,
    top_any_10: Optional[set[str]] = None,
    suite_id: Optional[str] = None,
    slice_id: str = "core_rank_v1",
    decision_log: Optional[list[dict[str, Any]]] = None,
    start_scan_limit_per_bucket: int = CORE_START_SCAN_LIMIT_PER_BUCKET,
) -> list[CandidateMatchup]:
    starts_by_bucket = _core_start_lists(
        degrees=degrees,
        db=db,
        excluded_hubs=excluded_hubs,
        seed=seed,
        start_scan_limit_per_bucket=start_scan_limit_per_bucket,
    )
    cell_pools: dict[tuple[str, str], list[CandidateMatchup]] = defaultdict(list)
    indexes = {bucket: 0 for bucket in WIDTH_BUCKETS}

    while True:
        added = 0
        for bucket in WIDTH_BUCKETS:
            starts = starts_by_bucket[bucket]
            for _ in range(4):
                if indexes[bucket] >= len(starts):
                    break
                start = starts[indexes[bucket]]
                indexes[bucket] += 1
                candidates = _collect_start_candidates(
                    graph=graph,
                    db=db,
                    degrees=degrees,
                    start=start,
                    max_depth=max_depth,
                    per_start_limit=per_start_limit,
                    seed=seed,
                    candidate_filter=core_candidate_filter,
                    final_target_filter=lambda title: _identity_canonical_title(db, title, degrees=degrees),
                    candidate_post_filter=candidate_post_filter,
                    feature_tags=("core", "nonhub", bucket),
                    tier="core_rank_v1",
                    top_any_10=top_any_10,
                    suite_id=suite_id,
                    slice_id=slice_id,
                    decision_log=decision_log,
                )
                for candidate in candidates:
                    cell = (candidate.path_bucket, bucket)
                    if cell in core_cell_quotas:
                        cell_pools[cell].append(candidate)
                added += 1

        if not added:
            break

        try:
            return _select_core_candidates(
                pools=cell_pools,
                seed=seed,
                core_cell_quotas=core_cell_quotas,
                preference_key=preference_key,
            )
        except RuntimeError:
            continue

    raise RuntimeError("Unable to build the core slice from the available candidates.")


def _core_pool_report(
    *,
    graph: SQLiteGraph,
    db: SQLiteGraph,
    degrees: dict[str, DegreeStats],
    excluded_hubs: set[str],
    seed: int,
    core_cell_quotas: dict[tuple[str, str], int],
    core_candidate_filter: Callable[[str, str, int], bool],
    candidate_post_filter: Optional[Callable[[CandidateMatchup], bool]],
    per_start_limit: int,
    max_depth: int,
    start_scan_limit_per_bucket: int = CORE_START_SCAN_LIMIT_PER_BUCKET,
) -> dict[str, object]:
    starts_by_bucket = _core_start_lists(
        degrees=degrees,
        db=db,
        excluded_hubs=excluded_hubs,
        seed=seed,
        start_scan_limit_per_bucket=start_scan_limit_per_bucket,
    )
    cell_pools: dict[tuple[str, str], list[CandidateMatchup]] = defaultdict(list)

    for bucket in WIDTH_BUCKETS:
        for start in starts_by_bucket[bucket]:
            candidates = _collect_start_candidates(
                graph=graph,
                db=db,
                degrees=degrees,
                start=start,
                max_depth=max_depth,
                per_start_limit=per_start_limit,
                seed=seed,
                candidate_filter=core_candidate_filter,
                final_target_filter=lambda title: _identity_canonical_title(db, title, degrees=degrees),
                candidate_post_filter=candidate_post_filter,
                feature_tags=("core", "nonhub", bucket),
                tier="core_rank_v1",
            )
            for candidate in candidates:
                cell = (candidate.path_bucket, bucket)
                if cell in core_cell_quotas:
                    cell_pools[cell].append(candidate)

    per_cell: dict[str, object] = {}
    for cell, quota in core_cell_quotas.items():
        candidates = cell_pools.get(cell, [])
        per_cell[f"{cell[0]}:{cell[1]}"] = {
            "quota": quota,
            "pool_size": len(candidates),
            "unique_starts": len({candidate.start for candidate in candidates}),
            "unique_targets": len({candidate.target for candidate in candidates}),
        }

    return {
        "path_buckets": sorted({cell[0] for cell in core_cell_quotas}),
        "width_buckets": list(WIDTH_BUCKETS),
        "start_scan_limit_per_bucket": start_scan_limit_per_bucket,
        "per_start_limit": per_start_limit,
        "max_depth": max_depth,
        "per_cell": per_cell,
    }


def _collect_diag_candidates(
    *,
    graph: SQLiteGraph,
    db: SQLiteGraph,
    degrees: dict[str, DegreeStats],
    starts: list[str],
    max_depth: int,
    per_start_limit: int,
    seed: int,
    candidate_filter: Callable[[str, str, int], bool],
    final_target_filter: Optional[Callable[[str], bool]],
    candidate_post_filter: Optional[Callable[[CandidateMatchup], bool | CandidateDecision]],
    feature_tags: tuple[str, ...],
    tier: str,
    limit: int,
    min_unique_starts: int = 0,
    top_any_10: Optional[set[str]] = None,
    suite_id: Optional[str] = None,
    slice_id: Optional[str] = None,
    decision_log: Optional[list[dict[str, Any]]] = None,
) -> list[CandidateMatchup]:
    candidates: list[CandidateMatchup] = []
    seen_starts: set[str] = set()
    for start in starts:
        start_candidates = _collect_start_candidates(
            graph=graph,
            db=db,
            degrees=degrees,
            start=start,
            max_depth=max_depth,
            per_start_limit=per_start_limit,
            seed=seed,
            candidate_filter=candidate_filter,
            final_target_filter=final_target_filter,
            candidate_post_filter=candidate_post_filter,
            feature_tags=feature_tags,
            tier=tier,
            top_any_10=top_any_10,
            suite_id=suite_id,
            slice_id=slice_id,
            decision_log=decision_log,
        )
        if start_candidates:
            seen_starts.add(start)
            candidates.extend(start_candidates)
        if len(candidates) >= limit and len(seen_starts) >= min_unique_starts:
            break
    return candidates


def _slice_manifest_data(
    *,
    suite_id: str,
    db_path: Path,
    generator_version: str,
    slice_counts: dict[str, int],
    core_cell_quotas: dict[tuple[str, str], int],
    selection_filters: dict[str, list[str]],
    notes: list[str],
) -> dict[str, object]:
    path_bucket_counts: Counter[str] = Counter()
    width_bucket_counts: Counter[str] = Counter()
    for (path_bucket, width_bucket), count in core_cell_quotas.items():
        path_bucket_counts[path_bucket] += count
        width_bucket_counts[width_bucket] += count
    return {
        "suite_id": suite_id,
        "setup_id": CLASSIC_LOCAL_V1.id,
        "generated_at": _now_iso(),
        "db_path": str(db_path),
        "db_sha256": sha256_file(db_path),
        "generator_version": generator_version,
        "prompt_version": CLASSIC_LOCAL_V1.prompt_version,
        "semantics_version": CLASSIC_LOCAL_V1.semantics_version,
        "slice_counts": dict(slice_counts),
        "selection_quotas": {
            "core_rank_v1": {
                "path_buckets": dict(path_bucket_counts),
                "start_width_buckets": dict(width_bucket_counts),
                "cell_quotas": {f"{path}:{width}": count for (path, width), count in core_cell_quotas.items()},
            },
        },
        "selection_filters": selection_filters,
        "notes": notes,
    }


def probe_fixed_suite(
    *,
    db_path: Path,
    suite_id: str,
    seed: int = 0,
) -> dict[str, object]:
    if suite_id not in {
        CLASSIC_SUITE_ID,
        FRONTIER_SUITE_ID,
        FRONTIER_V1_1_SUITE_ID,
        FRONTIER_STANDARD_SUITE_ID,
        FRONTIER_REGRESSION_SUITE_ID,
        FRONTIER_COMPANION_V0_1_SUITE_ID,
        FRONTIER_COMPANION_V0_2_DIAG_SUITE_ID,
        FRONTIER_COMPANION_REGEN_V1_SUITE_ID,
        FRONTIER_COMPANION_REGEN_V2_SUITE_ID,
    }:
        raise ValueError(
            "Unsupported suite_id="
            f"{suite_id!r}; supported suite ids are {CLASSIC_SUITE_ID!r}, {FRONTIER_SUITE_ID!r}, "
            f"{FRONTIER_V1_1_SUITE_ID!r}, {FRONTIER_STANDARD_SUITE_ID!r}, {FRONTIER_REGRESSION_SUITE_ID!r}, "
            f"{FRONTIER_COMPANION_V0_1_SUITE_ID!r}, "
            f"{FRONTIER_COMPANION_V0_2_DIAG_SUITE_ID!r}, {FRONTIER_COMPANION_REGEN_V1_SUITE_ID!r}, "
            f"and {FRONTIER_COMPANION_REGEN_V2_SUITE_ID!r}."
        )
    try:
        with tempfile.TemporaryDirectory() as td:
            temp_out_dir = Path(td) / suite_id
            slices = generate_fixed_suite(
                db_path=db_path,
                out_dir=temp_out_dir,
                suite_id=suite_id,
                seed=seed,
            )
    except Exception as exc:
        return {
            "suite_id": suite_id,
            "status": "unsupported",
            "db_path": str(db_path),
            "error": str(exc),
            "notes": [
                "Full suite build failed against the requested DB.",
            ],
        }

    core_matchups = list(slices.get("core_rank_v1", []))
    path_bucket_counts = Counter(
        matchup.path_bucket
        for matchup in core_matchups
        if isinstance(matchup.path_bucket, str) and matchup.path_bucket
    )
    width_bucket_counts = Counter(
        matchup.start_width_bucket
        for matchup in core_matchups
        if isinstance(matchup.start_width_bucket, str) and matchup.start_width_bucket
    )
    start_counts = Counter(matchup.start for matchup in core_matchups if isinstance(matchup.start, str) and matchup.start)
    duplicate_targets = len(core_matchups) - len(
        {
            matchup.target
            for matchup in core_matchups
            if isinstance(matchup.target, str) and matchup.target
        }
    )

    return {
        "suite_id": suite_id,
        "status": "supported",
        "db_path": str(db_path),
        "db_sha256": sha256_file(db_path),
        "slice_counts": {slice_id: len(matchups) for slice_id, matchups in slices.items()},
        "core_path_bucket_counts": dict(sorted(path_bucket_counts.items())),
        "core_start_width_bucket_counts": dict(sorted(width_bucket_counts.items())),
        "core_unique_starts": len(start_counts),
        "core_max_matchups_per_start": max(start_counts.values(), default=0),
        "core_duplicate_target_count": duplicate_targets,
        "notes": [
            "Probe validates the full graph-native suite by executing the same selection path as generate-fixed-suite in a temporary directory.",
            (
                "Graph-native suite is tuned to the shallow distance profile of the current simplewiki benchmark DB."
                if suite_id == CLASSIC_SUITE_ID
                else (
                    "Frontier suite is tuned toward fair-hard 4-6 hop tasks on the current simplewiki benchmark DB."
                    if suite_id == FRONTIER_SUITE_ID
                    else (
                        "Frontier v1.1 suite is tuned using shortest-path-family filters and deterministic calibration splits."
                        if suite_id == FRONTIER_V1_1_SUITE_ID
                        else (
                            "Frontier standard alias materializes the merged Frontier 200 used as the default SOTA-separating benchmark."
                            if suite_id == FRONTIER_STANDARD_SUITE_ID
                            else (
                                "Frontier regression alias materializes the easier Frontier v1.1 benchmark used for regression catching."
                                if suite_id == FRONTIER_REGRESSION_SUITE_ID
                                else "Frontier companion v0.1 is reserve-only, quota-constrained, and designed to complement the current hard99 without merging into it."
                            )
                        )
                    )
                )
            ),
        ],
    }


def _write_suite_outputs(
    *,
    out_dir: Path,
    slices: dict[str, list[MatchupV1]],
    manifest: dict[str, object],
) -> None:
    out_dir.mkdir(parents=True, exist_ok=True)
    all_matchups: list[MatchupV1] = []
    for slice_id, matchups in slices.items():
        _write_jsonl(out_dir / f"{slice_id}.jsonl", matchups)
        all_matchups.extend(matchups)
    _write_jsonl(out_dir / ALL_DATASET_FILENAME, all_matchups)
    (out_dir / "suite_manifest.json").write_text(json.dumps(manifest, indent=2), "utf-8")


def _matchup_lookup(matchup_slices: dict[str, list[MatchupV1]]) -> dict[tuple[str, str], MatchupV1]:
    lookup: dict[tuple[str, str], MatchupV1] = {}
    for matchups in matchup_slices.values():
        for matchup in matchups:
            lookup[(matchup.start, matchup.target)] = matchup
    return lookup


def _split_selected_candidates(
    *,
    selected_slices: dict[str, list[CandidateMatchup]],
    seed: int,
    holdout_target_count: int = HOLDOUT_TARGET_COUNT,
    trajectory_spine_count: int = TRAJECTORY_SPINE_COUNT,
) -> dict[str, list[CandidateMatchup]]:
    slice_counts = [(slice_id, len(candidates)) for slice_id, candidates in selected_slices.items()]
    total = sum(count for _, count in slice_counts)
    holdout_counts = _split_counts(total, slice_counts, target_count=holdout_target_count)

    blind_holdout: list[CandidateMatchup] = []
    seen_calibration: list[CandidateMatchup] = []
    seen_by_slice: dict[str, list[CandidateMatchup]] = {}

    for slice_id, candidates in selected_slices.items():
        ordered = sorted(
            candidates,
            key=lambda candidate: _stable_rank(seed, "blind_holdout", slice_id, candidate.start, candidate.target),
        )
        holdout_size = holdout_counts.get(slice_id, 0)
        blind_holdout.extend(ordered[:holdout_size])
        seen = ordered[holdout_size:]
        seen_calibration.extend(seen)
        seen_by_slice[slice_id] = seen

    seen_slice_counts = [(slice_id, len(candidates)) for slice_id, candidates in seen_by_slice.items()]
    spine_counts = _split_counts(sum(count for _, count in seen_slice_counts), seen_slice_counts, target_count=trajectory_spine_count)
    trajectory_spine: list[CandidateMatchup] = []
    for slice_id, candidates in seen_by_slice.items():
        ordered = sorted(
            candidates,
            key=lambda candidate: _stable_rank(seed, "trajectory_spine", slice_id, candidate.start, candidate.target),
        )
        trajectory_spine.extend(ordered[:spine_counts.get(slice_id, 0)])

    return {
        "seen_calibration": sorted(seen_calibration, key=lambda candidate: candidate.stable_rank),
        "blind_holdout": sorted(blind_holdout, key=lambda candidate: candidate.stable_rank),
        "trajectory_spine": sorted(trajectory_spine, key=lambda candidate: candidate.stable_rank),
    }


def _write_split_outputs(
    *,
    out_dir: Path,
    splits: dict[str, list[CandidateMatchup]],
    matchup_slices: dict[str, list[MatchupV1]],
) -> dict[str, dict[str, object]]:
    lookup = _matchup_lookup(matchup_slices)
    split_manifest: dict[str, dict[str, object]] = {}
    for split_name, candidates in splits.items():
        matchups = [lookup[(candidate.start, candidate.target)] for candidate in candidates]
        _write_jsonl(out_dir / f"{split_name}.jsonl", matchups)
        split_manifest[split_name] = {
            "count": len(matchups),
            "path": f"{split_name}.jsonl",
            "slice_counts": dict(Counter(matchup.slice_id for matchup in matchups if matchup.slice_id)),
        }
    return split_manifest


def _write_audit_sample(
    *,
    out_dir: Path,
    candidate_records: list[dict[str, Any]],
) -> None:
    selected = [
        record
        for record in candidate_records
        if record.get("status") in {"selected", "accepted"}
    ]
    rejected = [record for record in candidate_records if record.get("status") == "rejected"]

    predicted_easy = sorted(
        rejected,
        key=lambda record: (
            -int(record.get("family_easy_corridor_path_count") or 0),
            -int(record.get("family_carrier_bridge_count_max") or 0),
            -int(record.get("shortest_path_count") or 0),
            str(record.get("start") or ""),
            str(record.get("target") or ""),
        ),
    )[:15]
    predicted_unfair_hard = sorted(
        rejected,
        key=lambda record: (
            "artifact_bridge_in_shortest_family" not in set(record.get("reasons") or []),
            "brittle_single_route" not in set(record.get("reasons") or []),
            -(int(record.get("witness_low_degree_bridge_count") or 0)),
            int(record.get("family_informative_bridge_count_max") or 0),
            str(record.get("start") or ""),
            str(record.get("target") or ""),
        ),
    )[:15]
    selected_fair_hard = sorted(
        selected,
        key=lambda record: (
            -(int(record.get("witness_informative_bridge_count") or 0)),
            int(record.get("family_carrier_bridge_count_max") or 0),
            int(record.get("shortest_path_count") or 0),
            str(record.get("start") or ""),
            str(record.get("target") or ""),
        ),
    )[:15]

    lines = [
        "# Audit Sample",
        "",
        "This file captures deterministic manual-audit samples for the current frontier recut.",
        "",
        "## Rejected: Predicted Easy Corridor",
        "",
    ]
    for record in predicted_easy:
        lines.append(
            f"- `{record['start']} -> {record['target']}` | reasons={record.get('reasons')} | path={record.get('shortest_path')}"
        )
    lines.extend(["", "## Rejected: Predicted Unfair Hard", ""])
    for record in predicted_unfair_hard:
        lines.append(
            f"- `{record['start']} -> {record['target']}` | reasons={record.get('reasons')} | path={record.get('shortest_path')}"
        )
    lines.extend(["", "## Selected: Fair-Hard Sample", ""])
    for record in selected_fair_hard:
        lines.append(
            f"- `{record['start']} -> {record['target']}` | shortest_path_count={record.get('shortest_path_count')} | path={record.get('shortest_path')}"
        )
    (out_dir / "audit_sample.md").write_text("\n".join(lines) + "\n", "utf-8")


def _frontier_v1_1_decision(
    candidate: CandidateMatchup,
    *,
    min_target_in_degree: int,
    max_target_in_degree: int,
    min_informative_bridges: int,
    require_low_degree_bridge: bool,
    max_shortest_path_count: int = 24,
) -> CandidateDecision:
    reasons: list[str] = []
    if candidate.family_artifact_path_count > 0:
        reasons.append("artifact_bridge_in_shortest_family")
    if candidate.sampled_shortest_path_count > 0 and candidate.family_easy_corridor_path_count >= candidate.sampled_shortest_path_count:
        reasons.append("all_sampled_shortest_paths_are_easy_carrier_corridors")
    if not (min_target_in_degree <= candidate.target_in_degree <= max_target_in_degree):
        reasons.append("target_in_degree_out_of_range")
    if candidate.shortest_path_count > max_shortest_path_count:
        reasons.append("too_many_shortest_paths")
    if candidate.shortest_path_count == 1 and candidate.family_informative_bridge_count_max < min_informative_bridges:
        reasons.append("brittle_single_route")
    if candidate.family_informative_bridge_count_max < min_informative_bridges:
        reasons.append("not_enough_informative_bridges")
    if require_low_degree_bridge and candidate.witness_low_degree_bridge_count < 1:
        reasons.append("missing_low_degree_bridge")
    return CandidateDecision(accepted=not reasons, reasons=tuple(reasons))


def _generate_classic_fixed_suite(
    *,
    db_path: Path,
    out_dir: Path,
    suite_id: str = CLASSIC_SUITE_ID,
    seed: int = 0,
) -> dict[str, list[MatchupV1]]:
    rng = random.Random(seed)
    degrees = compute_degrees(db_path)
    graph = SQLiteGraph(db_path)
    db = SQLiteGraph(db_path)
    try:
        top_out_1 = _top_fraction_titles(degrees, fraction=0.01, value_fn=lambda stats: stats.out_degree)
        top_in_1 = _top_fraction_titles(degrees, fraction=0.01, value_fn=lambda stats: stats.in_degree)
        top_any_1 = top_out_1 | top_in_1
        top_out_001 = _top_fraction_titles(degrees, fraction=0.001, value_fn=lambda stats: stats.out_degree)
        top_in_001 = _top_fraction_titles(degrees, fraction=0.001, value_fn=lambda stats: stats.in_degree)
        top_any_001 = top_out_001 | top_in_001
        top_out_10 = _top_fraction_titles(degrees, fraction=0.10, value_fn=lambda stats: stats.out_degree)
        top_in_10 = _top_fraction_titles(degrees, fraction=0.10, value_fn=lambda stats: stats.in_degree)
        top_any_10 = top_out_10 | top_in_10

        def core_filter(_start: str, target: str, hops: int) -> bool:
            return 3 <= hops <= 6 and target not in top_any_1

        core_candidates = _build_core_slice(
            graph=graph,
            db=db,
            degrees=degrees,
            excluded_hubs=top_any_1,
            seed=seed,
            core_cell_quotas=GRAPH_NATIVE_CORE_CELL_QUOTAS,
            core_candidate_filter=core_filter,
            candidate_post_filter=None,
            per_start_limit=120,
            max_depth=6,
        )
        used_pairs = {(candidate.start, candidate.target) for candidate in core_candidates}

        degree_items = list(degrees.items())

        wide_starts = [
            title
            for title, stats in degree_items
            if stats.out_degree >= 250
            and title not in top_any_001
            and _identity_canonical_title(db, title, degrees=degrees)
        ]
        wide_starts.sort(key=lambda title: _stable_rank(seed, "diag_wide_choice_v1", title))
        wide_starts = wide_starts[:DIAG_START_SCAN_LIMIT]

        def wide_filter(_start: str, target: str, hops: int) -> bool:
            return 3 <= hops <= 6

        diag_wide_candidates = _collect_diag_candidates(
            graph=graph,
            db=db,
            degrees=degrees,
            starts=wide_starts,
            max_depth=6,
            per_start_limit=40,
            seed=seed,
            candidate_filter=wide_filter,
            final_target_filter=lambda title: _identity_canonical_title(db, title),
            candidate_post_filter=None,
            feature_tags=("diagnostic", "wide_choice"),
            tier="diag_wide_choice_v1",
            limit=240,
            min_unique_starts=6,
        )
        diag_wide = _select_unique_candidates(
            candidates=diag_wide_candidates,
            count=GRAPH_NATIVE_SLICE_COUNTS["diag_wide_choice_v1"],
            used_pairs=used_pairs,
            seed=seed,
            max_per_start=2,
        )
        used_pairs.update((candidate.start, candidate.target) for candidate in diag_wide)

        hub_escape_starts = [
            title for title in top_any_1 if _identity_canonical_title(db, title, degrees=degrees)
        ]
        hub_escape_starts.sort(key=lambda title: _stable_rank(seed, "diag_hub_escape_v1", title))
        hub_escape_starts = hub_escape_starts[:DIAG_START_SCAN_LIMIT]

        def hub_escape_filter(_start: str, target: str, hops: int) -> bool:
            return 3 <= hops <= 6 and target not in top_any_10

        diag_hub_escape_candidates = _collect_diag_candidates(
            graph=graph,
            db=db,
            degrees=degrees,
            starts=hub_escape_starts,
            max_depth=6,
            per_start_limit=40,
            seed=seed + 1,
            candidate_filter=hub_escape_filter,
            final_target_filter=lambda title: _identity_canonical_title(db, title, degrees=degrees),
            candidate_post_filter=None,
            feature_tags=("diagnostic", "hub_escape"),
            tier="diag_hub_escape_v1",
            limit=240,
            min_unique_starts=6,
        )
        diag_hub_escape = _select_unique_candidates(
            candidates=diag_hub_escape_candidates,
            count=GRAPH_NATIVE_SLICE_COUNTS["diag_hub_escape_v1"],
            used_pairs=used_pairs,
            seed=seed + 1,
            max_per_start=2,
        )
        used_pairs.update((candidate.start, candidate.target) for candidate in diag_hub_escape)

        hub_seek_starts = [
            title
            for title, _stats in degree_items
            if title not in top_any_10 and _identity_canonical_title(db, title, degrees=degrees)
        ]
        rng.shuffle(hub_seek_starts)
        hub_seek_starts.sort(key=lambda title: _stable_rank(seed, "diag_hub_seek_v1", title))
        hub_seek_starts = hub_seek_starts[:DIAG_START_SCAN_LIMIT]

        def hub_seek_filter(_start: str, target: str, hops: int) -> bool:
            return 3 <= hops <= 6 and target in top_in_1

        diag_hub_seek_candidates = _collect_diag_candidates(
            graph=graph,
            db=db,
            degrees=degrees,
            starts=hub_seek_starts,
            max_depth=6,
            per_start_limit=40,
            seed=seed + 2,
            candidate_filter=hub_seek_filter,
            final_target_filter=lambda title: _identity_canonical_title(db, title, degrees=degrees),
            candidate_post_filter=None,
            feature_tags=("diagnostic", "hub_seek"),
            tier="diag_hub_seek_v1",
            limit=240,
            min_unique_starts=6,
        )
        diag_hub_seek = _select_unique_candidates(
            candidates=diag_hub_seek_candidates,
            count=GRAPH_NATIVE_SLICE_COUNTS["diag_hub_seek_v1"],
            used_pairs=used_pairs,
            seed=seed + 2,
            max_per_start=2,
        )
        used_pairs.update((candidate.start, candidate.target) for candidate in diag_hub_seek)

        canonical_target_starts = [
            title
            for title, stats in degree_items
            if 25 <= stats.out_degree <= 249
            and title not in top_any_1
            and _identity_canonical_title(db, title, degrees=degrees)
        ]
        canonical_target_starts.sort(key=lambda title: _stable_rank(seed, "diag_canonical_target_v1", title))
        canonical_target_starts = canonical_target_starts[:DIAG_START_SCAN_LIMIT]

        def canonical_target_filter(_start: str, target: str, hops: int) -> bool:
            return 3 <= hops <= 6 and target not in top_any_1 and not _identity_canonical_title(db, target, degrees=degrees)

        diag_canonical_target_candidates = _collect_diag_candidates(
            graph=graph,
            db=db,
            degrees=degrees,
            starts=canonical_target_starts,
            max_depth=6,
            per_start_limit=30,
            seed=seed + 3,
            candidate_filter=canonical_target_filter,
            final_target_filter=None,
            candidate_post_filter=None,
            feature_tags=("diagnostic", "canonical_target"),
            tier="diag_canonical_target_v1",
            limit=240,
            min_unique_starts=6,
        )
        diag_canonical_target = _select_unique_candidates(
            candidates=diag_canonical_target_candidates,
            count=GRAPH_NATIVE_SLICE_COUNTS["diag_canonical_target_v1"],
            used_pairs=used_pairs,
            seed=seed + 3,
            max_per_start=2,
        )
        used_pairs.update((candidate.start, candidate.target) for candidate in diag_canonical_target)

        dead_end_starts = _collect_dead_end_prone_starts(graph=graph, db=db, degrees=degrees, seed=seed)

        def dead_end_filter(_start: str, target: str, hops: int) -> bool:
            return 3 <= hops <= 6

        diag_dead_end_candidates = _collect_diag_candidates(
            graph=graph,
            db=db,
            degrees=degrees,
            starts=dead_end_starts,
            max_depth=6,
            per_start_limit=40,
            seed=seed + 4,
            candidate_filter=dead_end_filter,
            final_target_filter=lambda title: _identity_canonical_title(db, title, degrees=degrees),
            candidate_post_filter=None,
            feature_tags=("diagnostic", "dead_end_prone"),
            tier="diag_dead_end_prone_v1",
            limit=240,
            min_unique_starts=6,
        )
        diag_dead_end = _select_unique_candidates(
            candidates=diag_dead_end_candidates,
            count=GRAPH_NATIVE_SLICE_COUNTS["diag_dead_end_prone_v1"],
            used_pairs=used_pairs,
            seed=seed + 4,
            max_per_start=2,
        )

        slices: dict[str, list[CandidateMatchup]] = {
            "core_rank_v1": core_candidates,
            "diag_wide_choice_v1": diag_wide,
            "diag_hub_escape_v1": diag_hub_escape,
            "diag_hub_seek_v1": diag_hub_seek,
            "diag_canonical_target_v1": diag_canonical_target,
            "diag_dead_end_prone_v1": diag_dead_end,
        }

        matchup_slices: dict[str, list[MatchupV1]] = {}
        for slice_id, candidates in slices.items():
            matchup_slices[slice_id] = [
                _candidate_to_matchup(candidate, suite_id=suite_id, slice_id=slice_id, index=index)
                for index, candidate in enumerate(candidates, start=1)
            ]

        manifest = _slice_manifest_data(
            suite_id=suite_id,
            db_path=db_path,
            generator_version=GRAPH_NATIVE_GENERATOR_VERSION,
            slice_counts=GRAPH_NATIVE_SLICE_COUNTS,
            core_cell_quotas=GRAPH_NATIVE_CORE_CELL_QUOTAS,
            selection_filters={
                "core_rank_v1": [
                    "exclude top 1 percent out-degree or in-degree pages",
                    "exclude canonical-title redirects from the core slice",
                    "require start out-degree between 5 and 249",
                    "require exact shortest path between 3 and 6 hops",
                    "balance short and medium cells across narrow/normal/broad widths",
                    "max 3 matchups per start and unique targets",
                ],
                "diag_wide_choice_v1": ["start out-degree at least 250", "exclude top 0.1 percent pathological hubs"],
                "diag_hub_escape_v1": ["start in top 1 percent degree", "target outside top 10 percent degree"],
                "diag_hub_seek_v1": ["target in top 1 percent in-degree", "start outside top 10 percent degree"],
                "diag_canonical_target_v1": ["target resolves to a different canonical title", "exact shortest path between 3 and 6 hops"],
                "diag_dead_end_prone_v1": ["start out-degree at least 15", "at least 30 percent low-out-degree outgoing links"],
            },
            notes=[
                "Graph-native fixed suite intended to mirror the app's Local / Classic setup on the current simplewiki benchmark graph.",
                "This suite is intentionally shallow because the underlying simplewiki graph does not provide stable non-hub 7-10 hop coverage.",
                "Shortest paths are computed via forward BFS over directed outgoing links.",
            ],
        )
        _write_suite_outputs(out_dir=out_dir, slices=matchup_slices, manifest=manifest)
        return matchup_slices
    finally:
        graph.close()
        db.close()


def _generate_frontier_fixed_suite(
    *,
    db_path: Path,
    out_dir: Path,
    suite_id: str = FRONTIER_SUITE_ID,
    seed: int = 0,
) -> dict[str, list[MatchupV1]]:
    degrees = compute_degrees(db_path)
    graph = SQLiteGraph(db_path)
    db = SQLiteGraph(db_path)
    try:
        top_out_1 = _top_fraction_titles(degrees, fraction=0.01, value_fn=lambda stats: stats.out_degree)
        top_in_1 = _top_fraction_titles(degrees, fraction=0.01, value_fn=lambda stats: stats.in_degree)
        top_any_1 = top_out_1 | top_in_1
        top_out_10 = _top_fraction_titles(degrees, fraction=0.10, value_fn=lambda stats: stats.out_degree)
        top_in_10 = _top_fraction_titles(degrees, fraction=0.10, value_fn=lambda stats: stats.in_degree)
        top_any_10 = top_out_10 | top_in_10

        def bridge_pressure(candidate: CandidateMatchup) -> int:
            pressure = 0
            for title in candidate.shortest_path[1:-1]:
                stats = degrees.get(title)
                if stats is not None and (stats.out_degree <= 5 or stats.in_degree <= 10):
                    pressure += 1
            return pressure

        def hub_count(candidate: CandidateMatchup) -> int:
            return sum(1 for title in candidate.shortest_path[1:-1] if title in top_any_10)

        def core_post_filter(candidate: CandidateMatchup) -> bool:
            return (
                candidate.shortest_path_hops >= 4
                and not _has_weak_bridge(candidate.shortest_path)
                and 3 <= candidate.target_in_degree <= 10
                and (candidate.path_bucket != "medium" or bridge_pressure(candidate) >= 1)
            )

        def core_preference(candidate: CandidateMatchup, attempt: int) -> tuple[object, ...]:
            target_rank = 0 if candidate.target_in_degree <= 6 else 1
            hop_rank = 0 if candidate.shortest_path_hops >= 5 else 1
            bridge_rank = 0 if bridge_pressure(candidate) >= 1 else 1
            width_rank = {"narrow": 0, "normal": 1, "broad": 2}.get(candidate.start_width_bucket or "", 3)
            breadth_rank = 0 if candidate.start_out_degree <= 99 else 1
            return (
                bridge_rank,
                hop_rank,
                target_rank,
                hub_count(candidate),
                width_rank,
                breadth_rank,
                _stable_rank(seed + attempt, candidate.start, candidate.target),
            )

        def core_filter(_start: str, target: str, hops: int) -> bool:
            return 4 <= hops <= 6 and target not in top_any_1

        core_candidates = _build_core_slice(
            graph=graph,
            db=db,
            degrees=degrees,
            excluded_hubs=top_any_1,
            seed=seed,
            core_cell_quotas=FRONTIER_CORE_CELL_QUOTAS,
            core_candidate_filter=core_filter,
            candidate_post_filter=core_post_filter,
            per_start_limit=220,
            max_depth=6,
            preference_key=core_preference,
        )
        used_pairs = {(candidate.start, candidate.target) for candidate in core_candidates}
        degree_items = list(degrees.items())

        canonical_target_starts = [
            title
            for title, stats in degree_items
            if 5 <= stats.out_degree <= 149
            and title not in top_any_10
            and _identity_canonical_title(db, title, degrees=degrees)
        ]
        canonical_target_starts.sort(key=lambda title: _stable_rank(seed, "diag_canonical_target_v1", title))
        canonical_target_starts = canonical_target_starts[:DIAG_START_SCAN_LIMIT]

        def canonical_target_filter(_start: str, target: str, hops: int) -> bool:
            return 4 <= hops <= 6 and target not in top_any_1 and not _identity_canonical_title(db, target, degrees=degrees)

        def canonical_target_post(candidate: CandidateMatchup) -> bool:
            return not _has_weak_bridge(candidate.shortest_path) and 3 <= candidate.target_in_degree <= 25

        diag_canonical_target_candidates = _collect_diag_candidates(
            graph=graph,
            db=db,
            degrees=degrees,
            starts=canonical_target_starts,
            max_depth=6,
            per_start_limit=60,
            seed=seed + 1,
            candidate_filter=canonical_target_filter,
            final_target_filter=None,
            candidate_post_filter=canonical_target_post,
            feature_tags=("diagnostic", "canonical_target", "frontier"),
            tier="diag_canonical_target_v1",
            limit=480,
            min_unique_starts=8,
        )
        diag_canonical_target = _select_unique_candidates(
            candidates=diag_canonical_target_candidates,
            count=FRONTIER_SLICE_COUNTS["diag_canonical_target_v1"],
            used_pairs=used_pairs,
            seed=seed + 1,
            max_per_start=2,
            preference_key=core_preference,
        )
        used_pairs.update((candidate.start, candidate.target) for candidate in diag_canonical_target)

        rarity_starts = [
            title
            for title, stats in degree_items
            if 5 <= stats.out_degree <= 99
            and title not in top_any_10
            and _identity_canonical_title(db, title, degrees=degrees)
        ]
        rarity_starts.sort(key=lambda title: _stable_rank(seed, "diag_target_rarity_v1", title))
        rarity_starts = rarity_starts[:DIAG_START_SCAN_LIMIT]

        def rarity_filter(_start: str, target: str, hops: int) -> bool:
            return 4 <= hops <= 6 and target not in top_any_1

        def rarity_post(candidate: CandidateMatchup) -> bool:
            return (
                candidate.start_width_bucket in {"narrow", "normal"}
                and not _has_weak_bridge(candidate.shortest_path)
                and 3 <= candidate.target_in_degree <= 10
            )

        def rarity_preference(candidate: CandidateMatchup, attempt: int) -> tuple[object, ...]:
            return (
                0 if candidate.shortest_path_hops >= 5 else 1,
                candidate.target_in_degree,
                {"narrow": 0, "normal": 1}.get(candidate.start_width_bucket or "", 2),
                _stable_rank(seed + attempt, candidate.start, candidate.target),
            )

        diag_target_rarity_candidates = _collect_diag_candidates(
            graph=graph,
            db=db,
            degrees=degrees,
            starts=rarity_starts,
            max_depth=6,
            per_start_limit=80,
            seed=seed + 2,
            candidate_filter=rarity_filter,
            final_target_filter=lambda title: _identity_canonical_title(db, title, degrees=degrees),
            candidate_post_filter=rarity_post,
            feature_tags=("diagnostic", "target_rarity", "frontier"),
            tier="diag_target_rarity_v1",
            limit=640,
            min_unique_starts=10,
        )
        diag_target_rarity = _select_unique_candidates(
            candidates=diag_target_rarity_candidates,
            count=FRONTIER_SLICE_COUNTS["diag_target_rarity_v1"],
            used_pairs=used_pairs,
            seed=seed + 2,
            max_per_start=2,
            preference_key=rarity_preference,
        )
        used_pairs.update((candidate.start, candidate.target) for candidate in diag_target_rarity)

        bridge_starts = [
            title
            for title, stats in degree_items
            if 5 <= stats.out_degree <= 149
            and title not in top_any_10
            and _identity_canonical_title(db, title, degrees=degrees)
        ]
        bridge_starts.sort(key=lambda title: _stable_rank(seed, "diag_bridge_pressure_v1", title))
        bridge_starts = bridge_starts[:DIAG_START_SCAN_LIMIT]

        def bridge_filter(_start: str, target: str, hops: int) -> bool:
            return 5 <= hops <= 6 and target not in top_any_1

        def bridge_post(candidate: CandidateMatchup) -> bool:
            return (
                not _has_weak_bridge(candidate.shortest_path)
                and 3 <= candidate.target_in_degree <= 25
                and bridge_pressure(candidate) >= 1
            )

        def bridge_preference(candidate: CandidateMatchup, attempt: int) -> tuple[object, ...]:
            return (
                -bridge_pressure(candidate),
                candidate.target_in_degree if candidate.target_in_degree >= 3 else 999,
                {"narrow": 0, "normal": 1, "broad": 2}.get(candidate.start_width_bucket or "", 3),
                _stable_rank(seed + attempt, candidate.start, candidate.target),
            )

        diag_bridge_pressure_candidates = _collect_diag_candidates(
            graph=graph,
            db=db,
            degrees=degrees,
            starts=bridge_starts,
            max_depth=6,
            per_start_limit=80,
            seed=seed + 3,
            candidate_filter=bridge_filter,
            final_target_filter=lambda title: _identity_canonical_title(db, title, degrees=degrees),
            candidate_post_filter=bridge_post,
            feature_tags=("diagnostic", "bridge_pressure", "frontier"),
            tier="diag_bridge_pressure_v1",
            limit=640,
            min_unique_starts=10,
        )
        diag_bridge_pressure = _select_unique_candidates(
            candidates=diag_bridge_pressure_candidates,
            count=FRONTIER_SLICE_COUNTS["diag_bridge_pressure_v1"],
            used_pairs=used_pairs,
            seed=seed + 3,
            max_per_start=2,
            preference_key=bridge_preference,
        )
        used_pairs.update((candidate.start, candidate.target) for candidate in diag_bridge_pressure)

        dead_end_starts = _collect_dead_end_prone_starts(graph=graph, db=db, degrees=degrees, seed=seed)

        def dead_end_filter(_start: str, target: str, hops: int) -> bool:
            return 4 <= hops <= 6

        def dead_end_post(candidate: CandidateMatchup) -> bool:
            return not _has_weak_bridge(candidate.shortest_path) and 3 <= candidate.target_in_degree <= 25

        diag_dead_end_candidates = _collect_diag_candidates(
            graph=graph,
            db=db,
            degrees=degrees,
            starts=dead_end_starts,
            max_depth=6,
            per_start_limit=80,
            seed=seed + 4,
            candidate_filter=dead_end_filter,
            final_target_filter=lambda title: _identity_canonical_title(db, title, degrees=degrees),
            candidate_post_filter=dead_end_post,
            feature_tags=("diagnostic", "dead_end_prone", "frontier"),
            tier="diag_dead_end_prone_v1",
            limit=800,
            min_unique_starts=12,
        )
        diag_dead_end = _select_unique_candidates(
            candidates=diag_dead_end_candidates,
            count=FRONTIER_SLICE_COUNTS["diag_dead_end_prone_v1"],
            used_pairs=used_pairs,
            seed=seed + 4,
            max_per_start=2,
            preference_key=core_preference,
        )

        slices: dict[str, list[CandidateMatchup]] = {
            "core_rank_v1": core_candidates,
            "diag_dead_end_prone_v1": diag_dead_end,
            "diag_canonical_target_v1": diag_canonical_target,
            "diag_target_rarity_v1": diag_target_rarity,
            "diag_bridge_pressure_v1": diag_bridge_pressure,
        }

        matchup_slices: dict[str, list[MatchupV1]] = {}
        for slice_id, candidates in slices.items():
            matchup_slices[slice_id] = [
                _candidate_to_matchup(candidate, suite_id=suite_id, slice_id=slice_id, index=index)
                for index, candidate in enumerate(candidates, start=1)
            ]

        manifest = _slice_manifest_data(
            suite_id=suite_id,
            db_path=db_path,
            generator_version=FRONTIER_GENERATOR_VERSION,
            slice_counts=FRONTIER_SLICE_COUNTS,
            core_cell_quotas=FRONTIER_CORE_CELL_QUOTAS,
            selection_filters={
                "core_rank_v1": [
                    "exclude top 1 percent out-degree or in-degree pages",
                    "exclude canonical-title redirects from the core slice",
                    "require exact shortest path between 4 and 6 hops",
                    "prefer medium-hops and narrow/normal starts",
                    "require fair paths without weak bridge titles",
                    "require targets with in-degree between 3 and 10",
                    "require at least one low-degree bridge node on medium-hop paths",
                    "prefer paths with lower hub saturation among intermediate nodes",
                    "max 3 matchups per start and unique targets",
                ],
                "diag_dead_end_prone_v1": [
                    "start out-degree at least 15",
                    "at least 30 percent low-out-degree outgoing links",
                    "require fair paths and moderate target discoverability",
                ],
                "diag_canonical_target_v1": [
                    "target resolves to a different canonical title",
                    "require exact shortest path between 4 and 6 hops",
                    "exclude weak bridge titles on the shortest path",
                ],
                "diag_target_rarity_v1": [
                    "start outside top 10 percent degree",
                    "target in-degree between 3 and 10",
                    "exclude weak bridge titles on the shortest path",
                ],
                "diag_bridge_pressure_v1": [
                    "require at least one low-degree bridge node on the shortest path",
                    "require exact shortest path between 5 and 6 hops",
                    "exclude weak bridge titles on the shortest path",
                ],
            },
            notes=[
                "Frontier-oriented fixed suite designed to land closer to a 50 percent success regime for GPT-5.x and Gemini 3.1 Pro class models on the current simplewiki graph.",
                "The suite stays within the existing directed-link simplewiki benchmark DB and reuses classic-local semantics.",
                "Selection is feature-driven and reproducible: it prefers 5-hop fair-hard paths, avoids weak bridge titles, and limits pathological low-discoverability targets.",
                "Shortest paths are computed via forward BFS over directed outgoing links.",
            ],
        )
        _write_suite_outputs(out_dir=out_dir, slices=matchup_slices, manifest=manifest)
        return matchup_slices
    finally:
        graph.close()
        db.close()


def _generate_frontier_v1_1_fixed_suite(
    *,
    db_path: Path,
    out_dir: Path,
    suite_id: str = FRONTIER_V1_1_SUITE_ID,
    seed: int = 0,
) -> dict[str, list[MatchupV1]]:
    degrees = compute_degrees(db_path)
    graph = SQLiteGraph(db_path)
    db = SQLiteGraph(db_path)
    try:
        top_out_1 = _top_fraction_titles(degrees, fraction=0.01, value_fn=lambda stats: stats.out_degree)
        top_in_1 = _top_fraction_titles(degrees, fraction=0.01, value_fn=lambda stats: stats.in_degree)
        top_any_1 = top_out_1 | top_in_1
        top_out_10 = _top_fraction_titles(degrees, fraction=0.10, value_fn=lambda stats: stats.out_degree)
        top_in_10 = _top_fraction_titles(degrees, fraction=0.10, value_fn=lambda stats: stats.in_degree)
        top_any_10 = top_out_10 | top_in_10
        degree_items = list(degrees.items())
        decision_log: list[dict[str, Any]] = []

        def core_filter(_start: str, target: str, hops: int) -> bool:
            return 4 <= hops <= 6 and target not in top_any_1

        def core_decision(candidate: CandidateMatchup) -> CandidateDecision:
            return _frontier_v1_1_decision(
                candidate,
                min_target_in_degree=3,
                max_target_in_degree=10,
                min_informative_bridges=1,
                require_low_degree_bridge=candidate.path_bucket == "medium",
            )

        def route_band_rank(candidate: CandidateMatchup) -> int:
            if 2 <= candidate.shortest_path_count <= 8:
                return 0
            if candidate.shortest_path_count == 1:
                return 1
            return 2

        def core_preference(candidate: CandidateMatchup, attempt: int) -> tuple[object, ...]:
            return (
                0 if candidate.shortest_path_hops >= 5 else 1,
                0 if candidate.family_informative_bridge_count_max >= 2 else 1,
                route_band_rank(candidate),
                candidate.family_easy_corridor_path_count,
                candidate.family_carrier_bridge_count_max,
                candidate.witness_hub_bridge_count,
                0 if candidate.target_in_degree <= 6 else 1,
                {"narrow": 0, "normal": 1, "broad": 2}.get(candidate.start_width_bucket or "", 3),
                _stable_rank(seed + attempt, candidate.start, candidate.target),
            )

        core_candidates = _build_core_slice(
            graph=graph,
            db=db,
            degrees=degrees,
            excluded_hubs=top_any_1,
            seed=seed,
            core_cell_quotas=FRONTIER_V1_1_CORE_CELL_QUOTAS,
            core_candidate_filter=core_filter,
            candidate_post_filter=core_decision,
            per_start_limit=160,
            max_depth=6,
            preference_key=core_preference,
            top_any_10=top_any_10,
            suite_id=suite_id,
            slice_id="core_rank_v1",
            decision_log=decision_log,
            start_scan_limit_per_bucket=140,
        )
        used_pairs = {(candidate.start, candidate.target) for candidate in core_candidates}

        canonical_target_starts = [
            title
            for title, stats in degree_items
            if 5 <= stats.out_degree <= 149
            and title not in top_any_10
            and _identity_canonical_title(db, title, degrees=degrees)
        ]
        canonical_target_starts.sort(key=lambda title: _stable_rank(seed, "diag_canonical_target_v1", title))
        canonical_target_starts = canonical_target_starts[:180]

        def canonical_target_filter(_start: str, target: str, hops: int) -> bool:
            return 4 <= hops <= 6 and target not in top_any_1 and not _identity_canonical_title(db, target, degrees=degrees)

        def canonical_target_decision(candidate: CandidateMatchup) -> CandidateDecision:
            return _frontier_v1_1_decision(
                candidate,
                min_target_in_degree=3,
                max_target_in_degree=20,
                min_informative_bridges=1,
                require_low_degree_bridge=False,
            )

        canonical_candidates = _collect_diag_candidates(
            graph=graph,
            db=db,
            degrees=degrees,
            starts=canonical_target_starts,
            max_depth=6,
            per_start_limit=50,
            seed=seed + 1,
            candidate_filter=canonical_target_filter,
            final_target_filter=None,
            candidate_post_filter=canonical_target_decision,
            feature_tags=("diagnostic", "canonical_target", "frontier", "v1_1"),
            tier="diag_canonical_target_v1",
            limit=640,
            min_unique_starts=8,
            top_any_10=top_any_10,
            suite_id=suite_id,
            slice_id="diag_canonical_target_v1",
            decision_log=decision_log,
        )
        diag_canonical_target = _select_unique_candidates(
            candidates=canonical_candidates,
            count=FRONTIER_V1_1_SLICE_COUNTS["diag_canonical_target_v1"],
            used_pairs=used_pairs,
            seed=seed + 1,
            max_per_start=2,
            preference_key=core_preference,
        )
        used_pairs.update((candidate.start, candidate.target) for candidate in diag_canonical_target)

        rarity_starts = [
            title
            for title, stats in degree_items
            if 5 <= stats.out_degree <= 99
            and title not in top_any_10
            and _identity_canonical_title(db, title, degrees=degrees)
        ]
        rarity_starts.sort(key=lambda title: _stable_rank(seed, "diag_target_rarity_v1", title))
        rarity_starts = rarity_starts[:180]

        def rarity_filter(_start: str, target: str, hops: int) -> bool:
            return 4 <= hops <= 6 and target not in top_any_1

        def rarity_decision(candidate: CandidateMatchup) -> CandidateDecision:
            decision = _frontier_v1_1_decision(
                candidate,
                min_target_in_degree=3,
                max_target_in_degree=10,
                min_informative_bridges=1,
                require_low_degree_bridge=False,
            )
            if candidate.start_width_bucket not in {"narrow", "normal"}:
                return CandidateDecision(accepted=False, reasons=decision.reasons + ("start_width_not_rare_enough",))
            return decision

        rarity_candidates = _collect_diag_candidates(
            graph=graph,
            db=db,
            degrees=degrees,
            starts=rarity_starts,
            max_depth=6,
            per_start_limit=60,
            seed=seed + 2,
            candidate_filter=rarity_filter,
            final_target_filter=lambda title: _identity_canonical_title(db, title, degrees=degrees),
            candidate_post_filter=rarity_decision,
            feature_tags=("diagnostic", "target_rarity", "frontier", "v1_1"),
            tier="diag_target_rarity_v1",
            limit=720,
            min_unique_starts=10,
            top_any_10=top_any_10,
            suite_id=suite_id,
            slice_id="diag_target_rarity_v1",
            decision_log=decision_log,
        )
        diag_target_rarity = _select_unique_candidates(
            candidates=rarity_candidates,
            count=FRONTIER_V1_1_SLICE_COUNTS["diag_target_rarity_v1"],
            used_pairs=used_pairs,
            seed=seed + 2,
            max_per_start=2,
            preference_key=core_preference,
        )
        used_pairs.update((candidate.start, candidate.target) for candidate in diag_target_rarity)

        bridge_starts = [
            title
            for title, stats in degree_items
            if 5 <= stats.out_degree <= 149
            and title not in top_any_10
            and _identity_canonical_title(db, title, degrees=degrees)
        ]
        bridge_starts.sort(key=lambda title: _stable_rank(seed, "diag_bridge_pressure_v1", title))
        bridge_starts = bridge_starts[:200]

        def bridge_filter(_start: str, target: str, hops: int) -> bool:
            return 5 <= hops <= 6 and target not in top_any_1

        def bridge_decision(candidate: CandidateMatchup) -> CandidateDecision:
            return _frontier_v1_1_decision(
                candidate,
                min_target_in_degree=3,
                max_target_in_degree=20,
                min_informative_bridges=1,
                require_low_degree_bridge=True,
            )

        def bridge_preference(candidate: CandidateMatchup, attempt: int) -> tuple[object, ...]:
            return (
                -candidate.witness_low_degree_bridge_count,
                0 if candidate.family_informative_bridge_count_max >= 2 else 1,
                route_band_rank(candidate),
                candidate.family_easy_corridor_path_count,
                candidate.family_carrier_bridge_count_max,
                candidate.target_in_degree,
                _stable_rank(seed + attempt, candidate.start, candidate.target),
            )

        bridge_candidates = _collect_diag_candidates(
            graph=graph,
            db=db,
            degrees=degrees,
            starts=bridge_starts,
            max_depth=6,
            per_start_limit=60,
            seed=seed + 3,
            candidate_filter=bridge_filter,
            final_target_filter=lambda title: _identity_canonical_title(db, title, degrees=degrees),
            candidate_post_filter=bridge_decision,
            feature_tags=("diagnostic", "bridge_pressure", "frontier", "v1_1"),
            tier="diag_bridge_pressure_v1",
            limit=900,
            min_unique_starts=12,
            top_any_10=top_any_10,
            suite_id=suite_id,
            slice_id="diag_bridge_pressure_v1",
            decision_log=decision_log,
        )
        diag_bridge_pressure = _select_unique_candidates(
            candidates=bridge_candidates,
            count=FRONTIER_V1_1_SLICE_COUNTS["diag_bridge_pressure_v1"],
            used_pairs=used_pairs,
            seed=seed + 3,
            max_per_start=2,
            preference_key=bridge_preference,
        )
        used_pairs.update((candidate.start, candidate.target) for candidate in diag_bridge_pressure)

        dead_end_starts = _collect_dead_end_prone_starts(graph=graph, db=db, degrees=degrees, seed=seed)

        def dead_end_filter(_start: str, target: str, hops: int) -> bool:
            return 4 <= hops <= 6 and target not in top_any_1

        def dead_end_decision(candidate: CandidateMatchup) -> CandidateDecision:
            return _frontier_v1_1_decision(
                candidate,
                min_target_in_degree=3,
                max_target_in_degree=20,
                min_informative_bridges=1,
                require_low_degree_bridge=False,
            )

        dead_end_candidates = _collect_diag_candidates(
            graph=graph,
            db=db,
            degrees=degrees,
            starts=dead_end_starts,
            max_depth=6,
            per_start_limit=60,
            seed=seed + 4,
            candidate_filter=dead_end_filter,
            final_target_filter=lambda title: _identity_canonical_title(db, title, degrees=degrees),
            candidate_post_filter=dead_end_decision,
            feature_tags=("diagnostic", "dead_end_prone", "frontier", "v1_1"),
            tier="diag_dead_end_prone_v1",
            limit=900,
            min_unique_starts=14,
            top_any_10=top_any_10,
            suite_id=suite_id,
            slice_id="diag_dead_end_prone_v1",
            decision_log=decision_log,
        )
        diag_dead_end = _select_unique_candidates(
            candidates=dead_end_candidates,
            count=FRONTIER_V1_1_SLICE_COUNTS["diag_dead_end_prone_v1"],
            used_pairs=used_pairs,
            seed=seed + 4,
            max_per_start=2,
            preference_key=core_preference,
        )

        selected_candidate_slices: dict[str, list[CandidateMatchup]] = {
            "core_rank_v1": core_candidates,
            "diag_dead_end_prone_v1": diag_dead_end,
            "diag_canonical_target_v1": diag_canonical_target,
            "diag_target_rarity_v1": diag_target_rarity,
            "diag_bridge_pressure_v1": diag_bridge_pressure,
        }
        selected_pairs = {
            (candidate.start, candidate.target)
            for candidates in selected_candidate_slices.values()
            for candidate in candidates
        }

        candidate_records: list[dict[str, Any]] = []
        for record in decision_log:
            if record["status"] == "accepted":
                record = dict(record)
                record["status"] = "selected" if (record["start"], record["target"]) in selected_pairs else "reserve"
            candidate_records.append(record)

        matchup_slices: dict[str, list[MatchupV1]] = {}
        for slice_id, candidates in selected_candidate_slices.items():
            matchup_slices[slice_id] = [
                _candidate_to_matchup(candidate, suite_id=suite_id, slice_id=slice_id, index=index)
                for index, candidate in enumerate(candidates, start=1)
            ]

        manifest = _slice_manifest_data(
            suite_id=suite_id,
            db_path=db_path,
            generator_version=FRONTIER_V1_1_GENERATOR_VERSION,
            slice_counts=FRONTIER_V1_1_SLICE_COUNTS,
            core_cell_quotas=FRONTIER_V1_1_CORE_CELL_QUOTAS,
            selection_filters={
                "core_rank_v1": [
                    "exclude top 1 percent out-degree or in-degree pages",
                    "exclude canonical-title redirects from the core slice",
                    "require exact shortest path between 4 and 6 hops",
                    "reject shortest-path families with artifact bridges",
                    "reject shortest-path families with easy carrier corridors",
                    "require informative bridges and banded shortest-path counts",
                    "prefer 5-hop fair-hard paths with lower carrier saturation",
                    "max 3 matchups per start and unique targets",
                ],
                "diag_dead_end_prone_v1": [
                    "start out-degree at least 15",
                    "at least 30 percent low-out-degree outgoing links",
                    "reject artifact bridges and easy carrier corridors",
                ],
                "diag_canonical_target_v1": [
                    "target resolves to a different canonical title",
                    "require exact shortest path between 4 and 6 hops",
                    "reject artifact bridges and easy carrier corridors",
                ],
                "diag_target_rarity_v1": [
                    "start outside top 10 percent degree",
                    "target in-degree between 3 and 10",
                    "prefer narrow/normal starts with informative bridges",
                ],
                "diag_bridge_pressure_v1": [
                    "require at least one low-degree bridge node on the witness shortest path",
                    "require exact shortest path between 5 and 6 hops",
                    "reject artifact bridges and easy carrier corridors",
                ],
            },
            notes=[
                "Versioned frontier recut that hardens pair selection using shortest-path-family features instead of a single witness path.",
                "The suite stays on the current directed-link simplewiki benchmark DB and preserves classic-local semantics.",
                "Calibration hygiene is built in via deterministic seen_calibration, blind_holdout, and trajectory_spine splits.",
                "Shortest paths are computed via forward BFS over directed outgoing links.",
            ],
        )

        splits = _split_selected_candidates(selected_slices=selected_candidate_slices, seed=seed)
        split_manifest = _write_split_outputs(out_dir=out_dir, splits=splits, matchup_slices=matchup_slices)
        manifest["calibration_splits"] = split_manifest
        manifest["path_family_settings"] = {
            "shortest_path_count_cap": SHORTEST_PATH_COUNT_CAP,
            "sampled_shortest_path_limit": SHORTEST_PATH_SAMPLE_LIMIT,
            "holdout_target_count": HOLDOUT_TARGET_COUNT,
            "trajectory_spine_count": TRAJECTORY_SPINE_COUNT,
        }
        manifest["selection_artifacts"] = {
            "candidate_pool": "candidate_pool.jsonl",
            "exclusion_report": "exclusion_report.jsonl",
            "audit_sample": "audit_sample.md",
        }
        manifest["candidate_status_counts"] = dict(Counter(record["status"] for record in candidate_records))
        manifest["reserve_counts_by_slice"] = dict(
            Counter(record["slice_id"] for record in candidate_records if record.get("status") == "reserve")
        )

        _write_suite_outputs(out_dir=out_dir, slices=matchup_slices, manifest=manifest)
        _write_records_jsonl(out_dir / "candidate_pool.jsonl", candidate_records)
        _write_records_jsonl(
            out_dir / "exclusion_report.jsonl",
            [record for record in candidate_records if record.get("status") == "rejected"],
        )
        (out_dir / "slice_summary.json").write_text(
            json.dumps(
                {
                    "selected_counts": {slice_id: len(candidates) for slice_id, candidates in selected_candidate_slices.items()},
                    "reserve_counts": dict(Counter(record["slice_id"] for record in candidate_records if record.get("status") == "reserve")),
                    "rejected_counts": dict(Counter(record["slice_id"] for record in candidate_records if record.get("status") == "rejected")),
                    "split_counts": {name: split_manifest[name]["count"] for name in split_manifest},
                },
                indent=2,
            ),
            "utf-8",
        )
        _write_audit_sample(out_dir=out_dir, candidate_records=candidate_records)
        return matchup_slices
    finally:
        graph.close()
        db.close()


def generate_fixed_suite(
    *,
    db_path: Path,
    out_dir: Path,
    suite_id: str = DEFAULT_SUITE_ID,
    seed: int = 0,
) -> dict[str, list[MatchupV1]]:
    if suite_id == CLASSIC_SUITE_ID:
        return _generate_classic_fixed_suite(db_path=db_path, out_dir=out_dir, suite_id=suite_id, seed=seed)
    if suite_id == FRONTIER_SUITE_ID:
        return _generate_frontier_fixed_suite(db_path=db_path, out_dir=out_dir, suite_id=suite_id, seed=seed)
    if suite_id == FRONTIER_V1_1_SUITE_ID:
        return _generate_frontier_v1_1_fixed_suite(db_path=db_path, out_dir=out_dir, suite_id=suite_id, seed=seed)
    if suite_id in PREBUILT_ALIAS_SUITES:
        return _materialize_prebuilt_alias_suite(db_path=db_path, out_dir=out_dir, suite_id=suite_id, seed=seed)
    if suite_id in {FRONTIER_COMPANION_V0_1_SUITE_ID, FRONTIER_COMPANION_V0_2_DIAG_SUITE_ID}:
        from parallel_eval.benchmark.frontier_companion import generate_frontier_companion_fixed_suite

        return generate_frontier_companion_fixed_suite(db_path=db_path, out_dir=out_dir, suite_id=suite_id, seed=seed)
    if suite_id == FRONTIER_COMPANION_REGEN_V1_SUITE_ID:
        from parallel_eval.benchmark.frontier_companion_regen import generate_frontier_companion_regen_fixed_suite

        return generate_frontier_companion_regen_fixed_suite(
            db_path=db_path,
            out_dir=out_dir,
            suite_id=suite_id,
            seed=seed,
        )
    if suite_id == FRONTIER_COMPANION_REGEN_V2_SUITE_ID:
        from parallel_eval.benchmark.frontier_companion_regen_v2 import generate_frontier_companion_regen_v2_fixed_suite

        return generate_frontier_companion_regen_v2_fixed_suite(
            db_path=db_path,
            out_dir=out_dir,
            suite_id=suite_id,
            seed=seed,
        )
    raise ValueError(
        "Unsupported suite_id="
        f"{suite_id!r}; supported suite ids are {CLASSIC_SUITE_ID!r}, {FRONTIER_SUITE_ID!r}, "
        f"{FRONTIER_V1_1_SUITE_ID!r}, {FRONTIER_STANDARD_SUITE_ID!r}, {FRONTIER_REGRESSION_SUITE_ID!r}, "
        f"{FRONTIER_COMPANION_V0_1_SUITE_ID!r}, "
        f"{FRONTIER_COMPANION_V0_2_DIAG_SUITE_ID!r}, {FRONTIER_COMPANION_REGEN_V1_SUITE_ID!r}, "
        f"and {FRONTIER_COMPANION_REGEN_V2_SUITE_ID!r}."
    )
