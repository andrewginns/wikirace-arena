from __future__ import annotations

import copy
import json
import tempfile
import unittest
from pathlib import Path

from parallel_eval.benchmark import frontier_companion as companion
from parallel_eval.benchmark.fixed_suite import CandidateMatchup


def _candidate_record(
    *,
    start: str,
    target: str,
    slice_id: str,
    path_bucket: str = "short",
    hops: int = 4,
    start_width_bucket: str = "normal",
    target_in_degree: int = 7,
    informative: int = 1,
    low_degree: int = 0,
    easy_corridors: int = 1,
    shortest_path_count: int = 4,
) -> dict[str, object]:
    return {
        "suite_id": "frontier_local_simplewiki_v1_1",
        "slice_id": slice_id,
        "tier": slice_id,
        "status": "reserve",
        "reasons": [],
        "start": start,
        "target": target,
        "shortest_path_hops": hops,
        "shortest_path": [start, f"{start} bridge", target] if hops == 4 else [start, f"{start} bridge", "Mid", target],
        "path_bucket": path_bucket,
        "start_out_degree": 20,
        "target_in_degree": target_in_degree,
        "start_width_bucket": start_width_bucket,
        "feature_tags": ["companion-test"],
        "shortest_path_count": shortest_path_count,
        "sampled_shortest_path_count": min(shortest_path_count, 4),
        "sampled_shortest_paths": [],
        "witness_artifact_bridge_count": 0,
        "witness_carrier_bridge_count": 0,
        "witness_informative_bridge_count": informative,
        "witness_low_degree_bridge_count": low_degree,
        "witness_hub_bridge_count": 0,
        "family_artifact_path_count": 0,
        "family_easy_corridor_path_count": easy_corridors,
        "family_carrier_bridge_count_min": 0,
        "family_carrier_bridge_count_max": 0,
        "family_informative_bridge_count_min": max(0, informative - 1),
        "family_informative_bridge_count_max": informative,
    }


class FrontierCompanionTests(unittest.TestCase):
    def test_core_rank_hard_gate_rejects_vanilla_medium_controller_shape(self) -> None:
        candidate = CandidateMatchup(
            start="A",
            target="B",
            shortest_path_hops=5,
            shortest_path=["A", "M1", "M2", "M3", "M4", "B"],
            path_bucket="medium",
            start_out_degree=25,
            target_in_degree=3,
            start_width_bucket="narrow",
            feature_tags=("core",),
            tier="core_rank_v1",
            stable_rank="x",
            shortest_path_count=4,
            sampled_shortest_path_count=4,
            sampled_shortest_paths=(),
            witness_artifact_bridge_count=0,
            witness_carrier_bridge_count=0,
            witness_informative_bridge_count=2,
            witness_low_degree_bridge_count=1,
            witness_hub_bridge_count=0,
            family_artifact_path_count=0,
            family_easy_corridor_path_count=1,
            family_carrier_bridge_count_min=0,
            family_carrier_bridge_count_max=0,
            family_informative_bridge_count_min=1,
            family_informative_bridge_count_max=2,
        )
        self.assertFalse(
            companion._passes_hard_gate(
                candidate,
                config=companion._companion_config(companion.FRONTIER_COMPANION_V0_1_SUITE_ID),
            )
        )

    def test_aggressive_diag_gates_reject_uncoupled_soft_shapes(self) -> None:
        config = companion._companion_config(companion.FRONTIER_COMPANION_V0_2_DIAG_SUITE_ID)
        uncoupled_canonical = CandidateMatchup(
            start="CanonA",
            target="CanonB",
            shortest_path_hops=4,
            shortest_path=["CanonA", "Bridge", "Mid", "CanonB"],
            path_bucket="short",
            start_out_degree=22,
            target_in_degree=11,
            start_width_bucket="normal",
            feature_tags=("diagnostic",),
            tier="diag_canonical_target_v1",
            stable_rank="canon",
            shortest_path_count=6,
            sampled_shortest_path_count=4,
            sampled_shortest_paths=(),
            witness_artifact_bridge_count=0,
            witness_carrier_bridge_count=0,
            witness_informative_bridge_count=2,
            witness_low_degree_bridge_count=0,
            witness_hub_bridge_count=0,
            family_artifact_path_count=0,
            family_easy_corridor_path_count=1,
            family_carrier_bridge_count_min=0,
            family_carrier_bridge_count_max=1,
            family_informative_bridge_count_min=1,
            family_informative_bridge_count_max=2,
        )
        uncoupled_rarity = CandidateMatchup(
            start="RareA",
            target="RareB",
            shortest_path_hops=4,
            shortest_path=["RareA", "Bridge", "Mid", "RareB"],
            path_bucket="short",
            start_out_degree=22,
            target_in_degree=5,
            start_width_bucket="normal",
            feature_tags=("diagnostic",),
            tier="diag_target_rarity_v1",
            stable_rank="rare",
            shortest_path_count=7,
            sampled_shortest_path_count=4,
            sampled_shortest_paths=(),
            witness_artifact_bridge_count=0,
            witness_carrier_bridge_count=0,
            witness_informative_bridge_count=2,
            witness_low_degree_bridge_count=0,
            witness_hub_bridge_count=0,
            family_artifact_path_count=0,
            family_easy_corridor_path_count=2,
            family_carrier_bridge_count_min=0,
            family_carrier_bridge_count_max=1,
            family_informative_bridge_count_min=1,
            family_informative_bridge_count_max=2,
        )
        self.assertFalse(companion._passes_hard_gate(uncoupled_canonical, config=config))
        self.assertFalse(companion._passes_hard_gate(uncoupled_rarity, config=config))

    def test_build_frontier_companion_selection_respects_overlap_bans_and_slice_targets(self) -> None:
        original_counts = copy.deepcopy(companion.FRONTIER_COMPANION_V0_1_SLICE_COUNTS)
        original_bands = copy.deepcopy(companion.COMPANION_SOFT_BANDS)
        original_alternates = companion.FRONTIER_COMPANION_V0_1_ALTERNATE_COUNT
        try:
            companion.FRONTIER_COMPANION_V0_1_SLICE_COUNTS = {
                "core_rank_v1": 1,
                "diag_canonical_target_v1": 1,
                "diag_target_rarity_v1": 1,
                "diag_bridge_pressure_v1": 1,
                "diag_dead_end_prone_v1": 1,
            }
            companion.COMPANION_SOFT_BANDS = {
                axis: {bucket: (0, 99) for bucket in buckets}
                for axis, buckets in companion.COMPANION_SOFT_BANDS.items()
            }
            companion.FRONTIER_COMPANION_V0_1_ALTERNATE_COUNT = 2

            with tempfile.TemporaryDirectory() as td:
                td_path = Path(td)
                audit_path = td_path / "audit.jsonl"
                candidate_pool_path = td_path / "candidate_pool.jsonl"

                audit_rows = [
                    {
                        "primary_slice": "controller_hard",
                        "start": "HardStart",
                        "target": "HardTarget",
                    }
                ]
                audit_path.write_text("\n".join(json.dumps(row) for row in audit_rows) + "\n", "utf-8")

                candidate_rows = [
                    _candidate_record(
                        start="HardStart",
                        target="OtherTarget",
                        slice_id="core_rank_v1",
                        path_bucket="short",
                        start_width_bucket="broad",
                    ),
                    {**_candidate_record(start="HardStart", target="HardTarget", slice_id="core_rank_v1"), "status": "selected"},
                    _candidate_record(
                        start="CoreStart",
                        target="CoreTarget",
                        slice_id="core_rank_v1",
                        path_bucket="short",
                        start_width_bucket="broad",
                        target_in_degree=8,
                    ),
                    _candidate_record(
                        start="CoreAlt",
                        target="CoreAltTarget",
                        slice_id="core_rank_v1",
                        path_bucket="short",
                        start_width_bucket="normal",
                        informative=1,
                    ),
                    _candidate_record(
                        start="CanonStart",
                        target="CanonTarget",
                        slice_id="diag_canonical_target_v1",
                        path_bucket="medium",
                        hops=5,
                        informative=2,
                        easy_corridors=1,
                    ),
                    _candidate_record(
                        start="RarityStart",
                        target="RarityTarget",
                        slice_id="diag_target_rarity_v1",
                        informative=1,
                        easy_corridors=1,
                    ),
                    _candidate_record(
                        start="BridgeStart",
                        target="BridgeTarget",
                        slice_id="diag_bridge_pressure_v1",
                        path_bucket="medium",
                        hops=5,
                        informative=2,
                        low_degree=1,
                        easy_corridors=1,
                    ),
                    _candidate_record(
                        start="DeadStart",
                        target="DeadTarget",
                        slice_id="diag_dead_end_prone_v1",
                        informative=0,
                        easy_corridors=1,
                        shortest_path_count=3,
                    ),
                ]
                candidate_pool_path.write_text("\n".join(json.dumps(row) for row in candidate_rows) + "\n", "utf-8")

                result = companion.build_frontier_companion_selection(
                    candidate_pool_path=candidate_pool_path,
                    hard99_audit_path=audit_path,
                    seed=7,
                )

                selected_pairs = {(row.candidate.start, row.candidate.target) for row in result.selected}
                self.assertEqual(len(result.selected), 5)
                self.assertNotIn(("HardStart", "OtherTarget"), selected_pairs)
                self.assertEqual(
                    result.report["selected_counts_by_slice"],
                    {
                        "core_rank_v1": 1,
                        "diag_bridge_pressure_v1": 1,
                        "diag_canonical_target_v1": 1,
                        "diag_dead_end_prone_v1": 1,
                        "diag_target_rarity_v1": 1,
                    },
                )
                self.assertLessEqual(len(result.alternates), 2)
        finally:
            companion.FRONTIER_COMPANION_V0_1_SLICE_COUNTS = original_counts
            companion.COMPANION_SOFT_BANDS = original_bands
            companion.FRONTIER_COMPANION_V0_1_ALTERNATE_COUNT = original_alternates


if __name__ == "__main__":
    unittest.main()
