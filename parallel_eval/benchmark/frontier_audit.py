from __future__ import annotations

import csv
import json
import math
import re
import statistics
from collections import defaultdict, deque
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Iterable, Literal, Optional

from pydantic import BaseModel, Field

from parallel_eval.benchmark.fixed_suite import (
    GENERIC_CARRIER_TITLES,
    _carrier_bridge_title,
    _top_fraction_titles,
)
from parallel_eval.benchmark.graph import SQLiteGraph, compute_degrees
from parallel_eval.benchmark.schema import MatchupV1, read_jsonl
from parallel_eval.benchmark.utils import sha256_file

PRIMARY_SLICE_VALUES = ("controller_hard", "graph_surface_fragile", "canonical_easy", "mixed_unclear")
SURFACE_TAG_VALUES = ("alias_rebrand_title_variant", "ontology_boundary", "sparse_local_closure")
RECOMMENDED_ACTION_VALUES = ("keep", "demote", "replace")
REVIEW_STATUS_VALUES = ("reviewed", "needs_review")

FrontierPrimarySlice = Literal["controller_hard", "graph_surface_fragile", "canonical_easy", "mixed_unclear"]
FrontierSurfaceTag = Literal["alias_rebrand_title_variant", "ontology_boundary", "sparse_local_closure"]
FrontierRecommendedAction = Literal["keep", "demote", "replace"]
FrontierReviewStatus = Literal["reviewed", "needs_review"]
ConfidenceLevel = Literal["high", "medium", "low"]

_PARENS_RE = re.compile(r"\s*\([^)]*\)")
_NON_ALNUM_RE = re.compile(r"[^a-z0-9]+")


class FrontierItemEvidenceV1(BaseModel):
    version: Literal["frontier_item_evidence_v0_1"] = "frontier_item_evidence_v0_1"
    benchmark_name: str
    benchmark_sha256: str
    item_key: str
    line_idx: int
    matchup_id: str
    start: str
    target: str
    suite_id: Optional[str] = None
    slice_id: Optional[str] = None
    path_bucket: Optional[str] = None
    start_width_bucket: Optional[str] = None
    shortest_path_hops: Optional[int] = None
    shortest_path: list[str] = Field(default_factory=list)
    start_out_degree: Optional[int] = None
    target_in_degree: Optional[int] = None
    shortest_path_count: Optional[int] = None
    sampled_shortest_path_count: Optional[int] = None
    witness_artifact_bridge_count: int = 0
    witness_carrier_bridge_count: int = 0
    witness_informative_bridge_count: int = 0
    witness_low_degree_bridge_count: int = 0
    witness_hub_bridge_count: int = 0
    family_artifact_path_count: int = 0
    family_easy_corridor_path_count: int = 0
    family_carrier_bridge_count_min: Optional[int] = None
    family_carrier_bridge_count_max: Optional[int] = None
    family_informative_bridge_count_min: Optional[int] = None
    family_informative_bridge_count_max: Optional[int] = None
    bundles_total: int = 0
    wins_total: int = 0
    losses_total: int = 0
    losses_with_revisit: int = 0
    losses_with_carrier_drift: int = 0
    losses_with_direct_target_miss: int = 0
    losses_with_near_target_progress_miss: int = 0
    losses_with_wrong_basin_step: int = 0
    losses_with_variant_confusion: int = 0
    losses_reaching_distance_1: int = 0
    losses_reaching_distance_2: int = 0
    losses_reaching_distance_3: int = 0
    mean_min_distance_on_loss: Optional[float] = None
    min_model_win_rate: Optional[float] = None
    max_model_win_rate: Optional[float] = None
    example_bundle_labels: list[str] = Field(default_factory=list)


class FrontierAuditItemV1(BaseModel):
    version: Literal["frontier_item_audit_v0_1"] = "frontier_item_audit_v0_1"
    benchmark_name: str
    benchmark_sha256: str
    item_key: str
    line_idx: int
    matchup_id: str
    start: str
    target: str
    suite_id: Optional[str] = None
    slice_id: Optional[str] = None
    path_bucket: Optional[str] = None
    start_width_bucket: Optional[str] = None
    review_status: FrontierReviewStatus
    confidence: ConfidenceLevel
    primary_slice: FrontierPrimarySlice
    surface_tags: list[FrontierSurfaceTag] = Field(default_factory=list)
    canonical: Optional[bool] = None
    carrier_pressure: Optional[bool] = None
    loop_prone: Optional[bool] = None
    wrong_basin_present: Optional[bool] = None
    near_target_sibling_present: Optional[bool] = None
    wrong_child_present: Optional[bool] = None
    recommended_action: FrontierRecommendedAction
    notes: str = ""
    decision_rationale: str = ""


@dataclass(frozen=True)
class RunTrajectorySignals:
    revisit_steps: int
    revisit_flag: bool
    carrier_drift_steps: int
    carrier_drift_flag: bool
    direct_target_miss_steps: int
    direct_target_miss_flag: bool
    near_target_progress_miss_steps: int
    near_target_progress_miss_flag: bool
    wrong_basin_steps: int
    wrong_basin_flag: bool
    variant_confusion_steps: int
    variant_confusion_flag: bool
    min_distance_to_target: Optional[int]
    reached_distance_1: bool
    reached_distance_2: bool
    reached_distance_3: bool


def _normalize_surface_root(title: str) -> str:
    value = _PARENS_RE.sub("", title.replace("_", " ").strip().lower())
    value = _NON_ALNUM_RE.sub(" ", value)
    return " ".join(part for part in value.split() if part)


def _rate_true_count(true_count: int, total_count: int) -> Optional[bool]:
    if total_count <= 0:
        return False
    ratio = float(true_count) / float(total_count)
    if ratio >= 0.5 and true_count >= 3:
        return True
    if ratio <= 0.15:
        return False
    return None


def _rate_present_count(true_count: int, total_count: int) -> Optional[bool]:
    if total_count <= 0:
        return False
    if true_count >= max(2, math.ceil(total_count * 0.33)):
        return True
    if true_count == 0:
        return False
    return None


def _dataset_rows(dataset_path: Path) -> list[MatchupV1]:
    return [MatchupV1.model_validate(line.data) for line in read_jsonl(dataset_path)]


def write_models_jsonl(path: Path, rows: Iterable[BaseModel]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    payloads = [json.dumps(row.model_dump(mode="json"), ensure_ascii=False) for row in rows]
    path.write_text("\n".join(payloads) + ("\n" if payloads else ""), "utf-8")


def load_frontier_audit_items(path: Path) -> dict[str, FrontierAuditItemV1]:
    rows: dict[str, FrontierAuditItemV1] = {}
    for line in read_jsonl(path):
        row = FrontierAuditItemV1.model_validate(line.data)
        if row.item_key in rows:
            raise ValueError(f"duplicate frontier audit item_key: {row.item_key}")
        rows[row.item_key] = row
    return rows


def load_frontier_item_evidence(path: Path) -> dict[str, FrontierItemEvidenceV1]:
    rows: dict[str, FrontierItemEvidenceV1] = {}
    for line in read_jsonl(path):
        row = FrontierItemEvidenceV1.model_validate(line.data)
        if row.item_key in rows:
            raise ValueError(f"duplicate frontier evidence item_key: {row.item_key}")
        rows[row.item_key] = row
    return rows


def write_review_csv(path: Path, rows: Iterable[dict[str, Any]]) -> None:
    row_list = list(rows)
    path.parent.mkdir(parents=True, exist_ok=True)
    if not row_list:
        path.write_text("", "utf-8")
        return
    fieldnames = list(row_list[0].keys())
    with open(path, "w", encoding="utf-8", newline="") as handle:
        writer = csv.DictWriter(handle, fieldnames=fieldnames)
        writer.writeheader()
        writer.writerows(row_list)


def discover_completed_frontier_records(
    *,
    results_root: Path,
    suite_token: str,
    expected_total_runs: int = 200,
) -> list[Path]:
    record_paths: list[Path] = []
    for summary_path in sorted(results_root.rglob("summary.json")):
        if suite_token not in str(summary_path):
            continue
        if any(token in str(summary_path) for token in ("blind_holdout", "trajectory")):
            continue
        records_path = summary_path.with_name("records.jsonl")
        if not records_path.exists():
            continue
        try:
            summary = json.loads(summary_path.read_text("utf-8"))
        except Exception:
            continue
        overall = summary.get("overall")
        if not isinstance(overall, dict) or int(overall.get("total_runs") or 0) != expected_total_runs:
            continue
        record_paths.append(records_path)
    return record_paths


class FrontierDistanceOracle:
    def __init__(self, db_path: Path, *, reverse_depth: int = 4):
        self.db_path = Path(db_path)
        self.graph = SQLiteGraph(self.db_path)
        self.reverse_depth = reverse_depth
        self.reverse_links = self._build_reverse_links()
        self.degrees = compute_degrees(self.db_path)
        self.top_any_10 = _top_fraction_titles(self.degrees, fraction=0.10, value_fn=lambda stats: stats.out_degree) | _top_fraction_titles(
            self.degrees,
            fraction=0.10,
            value_fn=lambda stats: stats.in_degree,
        )
        self._distance_cache: dict[str, dict[str, int]] = {}

    def __enter__(self) -> FrontierDistanceOracle:
        return self

    def __exit__(self, exc_type, exc, tb) -> None:
        self.close()

    def close(self) -> None:
        self.graph.close()

    def _build_reverse_links(self) -> dict[str, list[str]]:
        reverse_links: dict[str, list[str]] = defaultdict(list)
        for source, links in self.graph.iter_articles():
            for title in links:
                reverse_links[title].append(source)
        return dict(reverse_links)

    def distances_to_target(self, target: str) -> dict[str, int]:
        cached = self._distance_cache.get(target)
        if cached is not None:
            return cached
        distances: dict[str, int] = {target: 0}
        queue: deque[str] = deque([target])
        while queue:
            node = queue.popleft()
            depth = distances.get(node, 0)
            if depth >= self.reverse_depth:
                continue
            for prev in self.reverse_links.get(node, []):
                if prev in distances:
                    continue
                distances[prev] = depth + 1
                queue.append(prev)
        self._distance_cache[target] = distances
        return distances

    def is_carrier_title(self, title: Optional[str]) -> bool:
        if not isinstance(title, str) or not title:
            return False
        stats = self.degrees.get(title)
        if title in GENERIC_CARRIER_TITLES:
            return True
        return _carrier_bridge_title(title, stats=stats, top_any_10=self.top_any_10)

    def analyze_run(self, *, run: dict[str, Any], steps: list[dict[str, Any]]) -> RunTrajectorySignals:
        target = str(run.get("target") or "")
        distance_map = self.distances_to_target(target)
        seen_titles = {_normalize_surface_root(str(run.get("start") or ""))}
        revisit_steps = 0
        carrier_drift_steps = 0
        direct_target_miss_steps = 0
        near_target_progress_miss_steps = 0
        wrong_basin_steps = 0
        variant_confusion_steps = 0
        min_distance: Optional[int] = None
        target_surface_root = _normalize_surface_root(target)

        for step in steps:
            current_article = step.get("current_article")
            selected_title = step.get("selected_title")
            article = step.get("article")

            current_distance = distance_map.get(current_article) if isinstance(current_article, str) else None
            selected_distance = distance_map.get(selected_title) if isinstance(selected_title, str) else None
            article_distance = distance_map.get(article) if isinstance(article, str) else None

            for distance in (current_distance, selected_distance, article_distance):
                if distance is None:
                    continue
                if min_distance is None or distance < min_distance:
                    min_distance = distance

            normalized_selected = _normalize_surface_root(selected_title) if isinstance(selected_title, str) else ""
            if normalized_selected and normalized_selected in seen_titles:
                revisit_steps += 1
            if normalized_selected:
                seen_titles.add(normalized_selected)
            if isinstance(article, str):
                normalized_article = _normalize_surface_root(article)
                if normalized_article:
                    seen_titles.add(normalized_article)

            if (
                target_surface_root
                and normalized_selected
                and normalized_selected == target_surface_root
                and isinstance(selected_title, str)
                and selected_title != target
            ):
                variant_confusion_steps += 1

            if not isinstance(current_article, str) or not isinstance(selected_title, str):
                continue

            outgoing_links = self.graph.links(current_article)
            neighbor_distances = [distance_map.get(link) for link in outgoing_links if distance_map.get(link) is not None]
            best_neighbor_distance = min(neighbor_distances) if neighbor_distances else None
            has_progress_option = (
                current_distance is not None
                and best_neighbor_distance is not None
                and best_neighbor_distance < current_distance
            )

            if target in outgoing_links and selected_title != target:
                direct_target_miss_steps += 1

            if current_distance == 2 and best_neighbor_distance == 1 and selected_distance != 1:
                near_target_progress_miss_steps += 1

            if (
                current_distance in (3, 4)
                and has_progress_option
                and selected_distance is not None
                and selected_distance >= current_distance
                and not self.is_carrier_title(selected_title)
            ):
                wrong_basin_steps += 1

            if has_progress_option and self.is_carrier_title(selected_title) and (selected_distance is None or selected_distance >= current_distance):
                carrier_drift_steps += 1

        return RunTrajectorySignals(
            revisit_steps=revisit_steps,
            revisit_flag=revisit_steps > 0,
            carrier_drift_steps=carrier_drift_steps,
            carrier_drift_flag=carrier_drift_steps > 0,
            direct_target_miss_steps=direct_target_miss_steps,
            direct_target_miss_flag=direct_target_miss_steps > 0,
            near_target_progress_miss_steps=near_target_progress_miss_steps,
            near_target_progress_miss_flag=near_target_progress_miss_steps > 0,
            wrong_basin_steps=wrong_basin_steps,
            wrong_basin_flag=wrong_basin_steps > 0,
            variant_confusion_steps=variant_confusion_steps,
            variant_confusion_flag=variant_confusion_steps > 0,
            min_distance_to_target=min_distance,
            reached_distance_1=min_distance is not None and min_distance <= 1,
            reached_distance_2=min_distance is not None and min_distance <= 2,
            reached_distance_3=min_distance is not None and min_distance <= 3,
        )


def _bundle_label_from_run(records_path: Path, run: dict[str, Any]) -> str:
    model_settings = run.get("model_settings") if isinstance(run.get("model_settings"), dict) else {}
    model = str(model_settings.get("model") or records_path.parent.name)
    reasoning_effort = model_settings.get("openai_reasoning_effort")
    if isinstance(reasoning_effort, str) and reasoning_effort:
        return f"{model}::{reasoning_effort}"
    return model


def build_frontier_item_evidence(
    *,
    dataset_path: Path,
    candidate_pool_path: Path,
    records_paths: list[Path],
    db_path: Path,
    reverse_depth: int = 4,
) -> list[FrontierItemEvidenceV1]:
    dataset_rows = _dataset_rows(dataset_path)
    benchmark_sha256 = sha256_file(dataset_path)
    candidate_pool_by_pair: dict[tuple[str, str], dict[str, Any]] = {}
    for line in read_jsonl(candidate_pool_path):
        row = line.data
        start = row.get("start")
        target = row.get("target")
        if isinstance(start, str) and isinstance(target, str):
            candidate_pool_by_pair[(start, target)] = row

    evidence_state: dict[str, dict[str, Any]] = {}
    for index, matchup in enumerate(dataset_rows):
        candidate = candidate_pool_by_pair.get((matchup.start, matchup.target), {})
        evidence_state[matchup.id] = {
            "benchmark_name": dataset_path.parent.name,
            "benchmark_sha256": benchmark_sha256,
            "item_key": matchup.id,
            "line_idx": index,
            "matchup_id": matchup.id,
            "start": matchup.start,
            "target": matchup.target,
            "suite_id": matchup.suite_id,
            "slice_id": matchup.slice_id,
            "path_bucket": matchup.path_bucket,
            "start_width_bucket": matchup.start_width_bucket,
            "shortest_path_hops": matchup.shortest_path_hops,
            "shortest_path": list(matchup.shortest_path or []),
            "start_out_degree": matchup.start_out_degree,
            "target_in_degree": matchup.target_in_degree,
            "shortest_path_count": candidate.get("shortest_path_count"),
            "sampled_shortest_path_count": candidate.get("sampled_shortest_path_count"),
            "witness_artifact_bridge_count": int(candidate.get("witness_artifact_bridge_count") or 0),
            "witness_carrier_bridge_count": int(candidate.get("witness_carrier_bridge_count") or 0),
            "witness_informative_bridge_count": int(candidate.get("witness_informative_bridge_count") or 0),
            "witness_low_degree_bridge_count": int(candidate.get("witness_low_degree_bridge_count") or 0),
            "witness_hub_bridge_count": int(candidate.get("witness_hub_bridge_count") or 0),
            "family_artifact_path_count": int(candidate.get("family_artifact_path_count") or 0),
            "family_easy_corridor_path_count": int(candidate.get("family_easy_corridor_path_count") or 0),
            "family_carrier_bridge_count_min": candidate.get("family_carrier_bridge_count_min"),
            "family_carrier_bridge_count_max": candidate.get("family_carrier_bridge_count_max"),
            "family_informative_bridge_count_min": candidate.get("family_informative_bridge_count_min"),
            "family_informative_bridge_count_max": candidate.get("family_informative_bridge_count_max"),
            "bundles_total": 0,
            "wins_total": 0,
            "losses_total": 0,
            "losses_with_revisit": 0,
            "losses_with_carrier_drift": 0,
            "losses_with_direct_target_miss": 0,
            "losses_with_near_target_progress_miss": 0,
            "losses_with_wrong_basin_step": 0,
            "losses_with_variant_confusion": 0,
            "losses_reaching_distance_1": 0,
            "losses_reaching_distance_2": 0,
            "losses_reaching_distance_3": 0,
            "_loss_min_distances": [],
            "_bundle_results": {},
            "_bundle_labels": set(),
        }

    with FrontierDistanceOracle(db_path, reverse_depth=reverse_depth) as oracle:
        for records_path in records_paths:
            runs: dict[str, dict[str, Any]] = {}
            steps_by_run: dict[str, list[dict[str, Any]]] = defaultdict(list)
            for line in read_jsonl(records_path):
                data = line.data
                record_type = data.get("type")
                if record_type == "run":
                    run_id = data.get("run_id")
                    if isinstance(run_id, str):
                        runs[run_id] = data
                elif record_type == "step":
                    run_id = data.get("run_id")
                    if isinstance(run_id, str):
                        steps_by_run[run_id].append(data)
            for steps in steps_by_run.values():
                steps.sort(key=lambda row: int(row.get("hop") or 0))

            for run_id, run in runs.items():
                matchup_id = run.get("matchup_id")
                if not isinstance(matchup_id, str) or matchup_id not in evidence_state:
                    continue
                item = evidence_state[matchup_id]
                bundle_label = _bundle_label_from_run(records_path, run)
                item["_bundle_labels"].add(bundle_label)
                item["bundles_total"] += 1
                won = run.get("result") == "win"
                if won:
                    item["wins_total"] += 1
                else:
                    item["losses_total"] += 1
                item["_bundle_results"][bundle_label] = 1 if won else 0
                if won:
                    continue
                signals = oracle.analyze_run(run=run, steps=steps_by_run.get(run_id) or [])
                if signals.revisit_flag:
                    item["losses_with_revisit"] += 1
                if signals.carrier_drift_steps >= 2:
                    item["losses_with_carrier_drift"] += 1
                if signals.direct_target_miss_flag:
                    item["losses_with_direct_target_miss"] += 1
                if signals.near_target_progress_miss_flag:
                    item["losses_with_near_target_progress_miss"] += 1
                if signals.wrong_basin_steps >= 2:
                    item["losses_with_wrong_basin_step"] += 1
                if signals.variant_confusion_flag:
                    item["losses_with_variant_confusion"] += 1
                if signals.reached_distance_1:
                    item["losses_reaching_distance_1"] += 1
                if signals.reached_distance_2:
                    item["losses_reaching_distance_2"] += 1
                if signals.reached_distance_3:
                    item["losses_reaching_distance_3"] += 1
                if signals.min_distance_to_target is not None:
                    item["_loss_min_distances"].append(float(signals.min_distance_to_target))

    rows: list[FrontierItemEvidenceV1] = []
    for matchup in dataset_rows:
        raw = evidence_state[matchup.id]
        bundle_values = list(raw["_bundle_results"].values())
        min_model_win_rate = min(bundle_values) if bundle_values else None
        max_model_win_rate = max(bundle_values) if bundle_values else None
        mean_min_distance_on_loss = None
        if raw["_loss_min_distances"]:
            mean_min_distance_on_loss = float(statistics.mean(raw["_loss_min_distances"]))
        rows.append(
            FrontierItemEvidenceV1.model_validate(
                {
                    **{key: value for key, value in raw.items() if not key.startswith("_")},
                    "mean_min_distance_on_loss": mean_min_distance_on_loss,
                    "min_model_win_rate": min_model_win_rate,
                    "max_model_win_rate": max_model_win_rate,
                    "example_bundle_labels": sorted(raw["_bundle_labels"])[:8],
                }
            )
        )
    return rows


def suggest_frontier_audit_item(evidence: FrontierItemEvidenceV1) -> FrontierAuditItemV1:
    canonical = evidence.slice_id == "diag_canonical_target_v1"
    sparse_local_closure: Optional[bool]
    if isinstance(evidence.target_in_degree, int):
        if evidence.target_in_degree <= 4:
            sparse_local_closure = True
        elif evidence.target_in_degree >= 7:
            sparse_local_closure = False
        else:
            sparse_local_closure = None
    else:
        sparse_local_closure = None

    carrier_pressure: Optional[bool]
    easy_corridor_half = 0
    if isinstance(evidence.sampled_shortest_path_count, int) and evidence.sampled_shortest_path_count > 0:
        easy_corridor_half = math.ceil(evidence.sampled_shortest_path_count / 2)
    if (
        (evidence.witness_carrier_bridge_count >= 2 and evidence.witness_informative_bridge_count <= 1)
        or evidence.family_easy_corridor_path_count >= max(2, easy_corridor_half)
        or evidence.losses_with_carrier_drift >= 2
    ):
        carrier_pressure = True
    elif (
        evidence.witness_carrier_bridge_count == 0
        and evidence.family_easy_corridor_path_count == 0
        and evidence.losses_with_carrier_drift == 0
    ):
        carrier_pressure = False
    else:
        carrier_pressure = None

    loop_prone = _rate_true_count(evidence.losses_with_revisit, evidence.losses_total)
    wrong_basin_present = _rate_present_count(evidence.losses_with_wrong_basin_step, evidence.losses_total)
    near_target_sibling_present = _rate_present_count(evidence.losses_with_near_target_progress_miss, evidence.losses_total)
    wrong_child_present = True if evidence.losses_with_direct_target_miss > 0 else False

    surface_tags: list[FrontierSurfaceTag] = []
    if evidence.losses_with_variant_confusion > 0:
        surface_tags.append("alias_rebrand_title_variant")
    if sparse_local_closure is True:
        surface_tags.append("sparse_local_closure")
    high_precision_ontology = (
        (evidence.witness_carrier_bridge_count >= 2 and evidence.witness_informative_bridge_count == 0)
        or (
            evidence.family_easy_corridor_path_count >= max(2, easy_corridor_half)
            and evidence.witness_informative_bridge_count <= 1
        )
        or (
            evidence.losses_with_carrier_drift >= max(2, math.ceil(evidence.losses_total * 0.40))
            and evidence.losses_with_wrong_basin_step >= max(2, math.ceil(evidence.losses_total * 0.33))
        )
    )
    if high_precision_ontology:
        surface_tags.append("ontology_boundary")

    if canonical:
        primary_slice: FrontierPrimarySlice = "canonical_easy"
    else:
        core_controller = int(loop_prone is True) + int(wrong_basin_present is True) + int(near_target_sibling_present is True)
        support_controller = int(carrier_pressure is True) + int(high_precision_ontology)
        surface_score = int(sparse_local_closure is True) + int(evidence.losses_with_variant_confusion > 0)

        if core_controller >= 2:
            primary_slice = "controller_hard"
        elif core_controller >= 1 and support_controller >= 1 and surface_score == 0:
            primary_slice = "controller_hard"
        elif surface_score >= 1 and core_controller == 0:
            primary_slice = "graph_surface_fragile"
        else:
            primary_slice = "mixed_unclear"

    if canonical:
        recommended_action: FrontierRecommendedAction = "demote"
    elif evidence.losses_with_variant_confusion >= 2 and evidence.wins_total <= evidence.losses_total:
        recommended_action = "replace"
    else:
        recommended_action = "keep"

    null_supports = sum(
        value is None
        for value in (carrier_pressure, loop_prone, wrong_basin_present, near_target_sibling_present, sparse_local_closure)
    )
    if primary_slice == "canonical_easy":
        confidence: ConfidenceLevel = "high"
    elif primary_slice == "mixed_unclear" or null_supports >= 3:
        confidence = "low"
    elif primary_slice == "controller_hard" and (
        int(loop_prone is True) + int(wrong_basin_present is True) + int(near_target_sibling_present is True)
    ) >= 2 and null_supports <= 1:
        confidence = "high"
    elif primary_slice == "graph_surface_fragile" and sparse_local_closure is True and evidence.losses_with_variant_confusion == 0:
        confidence = "high" if null_supports == 0 else "medium"
    elif null_supports >= 1:
        confidence = "medium"
    else:
        confidence = "medium"

    reasons: list[str] = []
    if carrier_pressure is True:
        reasons.append("carrier pressure")
    if loop_prone is True:
        reasons.append("recurrent revisit loops")
    if wrong_basin_present is True:
        reasons.append("wrong-basin drift")
    if near_target_sibling_present is True:
        reasons.append("last-mile miss")
    if wrong_child_present is True:
        reasons.append("direct-target miss")
    if sparse_local_closure is True:
        reasons.append("sparse local closure")
    if evidence.losses_with_variant_confusion > 0:
        reasons.append("title-variant confusion")
    if canonical:
        reasons.append("canonical diagnostic")
    rationale = ", ".join(reasons) if reasons else "no strong audited signal"

    return FrontierAuditItemV1(
        benchmark_name=evidence.benchmark_name,
        benchmark_sha256=evidence.benchmark_sha256,
        item_key=evidence.item_key,
        line_idx=evidence.line_idx,
        matchup_id=evidence.matchup_id,
        start=evidence.start,
        target=evidence.target,
        suite_id=evidence.suite_id,
        slice_id=evidence.slice_id,
        path_bucket=evidence.path_bucket,
        start_width_bucket=evidence.start_width_bucket,
        review_status="reviewed",
        confidence=confidence,
        primary_slice=primary_slice,
        surface_tags=surface_tags,
        canonical=canonical,
        carrier_pressure=carrier_pressure,
        loop_prone=loop_prone,
        wrong_basin_present=wrong_basin_present,
        near_target_sibling_present=near_target_sibling_present,
        wrong_child_present=wrong_child_present,
        recommended_action=recommended_action,
        notes="",
        decision_rationale=rationale,
    )


def review_csv_rows(
    evidence_rows: list[FrontierItemEvidenceV1],
    audit_rows: list[FrontierAuditItemV1],
) -> list[dict[str, Any]]:
    audit_by_item = {row.item_key: row for row in audit_rows}
    rows: list[dict[str, Any]] = []
    for evidence in evidence_rows:
        audit = audit_by_item[evidence.item_key]
        rows.append(
            {
                "item_key": evidence.item_key,
                "slice_id": evidence.slice_id,
                "start": evidence.start,
                "target": evidence.target,
                "shortest_path_hops": evidence.shortest_path_hops,
                "primary_slice": audit.primary_slice,
                "recommended_action": audit.recommended_action,
                "confidence": audit.confidence,
                "surface_tags": "|".join(audit.surface_tags),
                "canonical": audit.canonical,
                "carrier_pressure": audit.carrier_pressure,
                "loop_prone": audit.loop_prone,
                "wrong_basin_present": audit.wrong_basin_present,
                "near_target_sibling_present": audit.near_target_sibling_present,
                "wrong_child_present": audit.wrong_child_present,
                "wins_total": evidence.wins_total,
                "losses_total": evidence.losses_total,
                "losses_with_revisit": evidence.losses_with_revisit,
                "losses_with_carrier_drift": evidence.losses_with_carrier_drift,
                "losses_with_near_target_progress_miss": evidence.losses_with_near_target_progress_miss,
                "losses_with_wrong_basin_step": evidence.losses_with_wrong_basin_step,
                "losses_with_variant_confusion": evidence.losses_with_variant_confusion,
                "target_in_degree": evidence.target_in_degree,
                "witness_carrier_bridge_count": evidence.witness_carrier_bridge_count,
                "witness_informative_bridge_count": evidence.witness_informative_bridge_count,
                "family_easy_corridor_path_count": evidence.family_easy_corridor_path_count,
                "decision_rationale": audit.decision_rationale,
            }
        )
    return rows


def summarize_audit_counts(audit_rows: list[FrontierAuditItemV1]) -> dict[str, Any]:
    from collections import Counter

    primary_counts = Counter(row.primary_slice for row in audit_rows)
    action_counts = Counter(row.recommended_action for row in audit_rows)
    confidence_counts = Counter(row.confidence for row in audit_rows)
    tag_counts = Counter(tag for row in audit_rows for tag in row.surface_tags)
    bool_counts: dict[str, Counter[str]] = {
        "carrier_pressure": Counter(str(row.carrier_pressure) for row in audit_rows),
        "loop_prone": Counter(str(row.loop_prone) for row in audit_rows),
        "wrong_basin_present": Counter(str(row.wrong_basin_present) for row in audit_rows),
        "near_target_sibling_present": Counter(str(row.near_target_sibling_present) for row in audit_rows),
        "wrong_child_present": Counter(str(row.wrong_child_present) for row in audit_rows),
    }
    return {
        "primary_slice_counts": dict(sorted(primary_counts.items())),
        "recommended_action_counts": dict(sorted(action_counts.items())),
        "confidence_counts": dict(sorted(confidence_counts.items())),
        "surface_tag_counts": dict(sorted(tag_counts.items())),
        "boolean_counts": {key: dict(sorted(value.items())) for key, value in sorted(bool_counts.items())},
    }
