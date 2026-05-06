from __future__ import annotations

import unittest

from parallel_eval.benchmark.fixed_suite import CandidateMatchup
from parallel_eval.benchmark.graph import DegreeStats
from parallel_eval.benchmark.frontier_companion_regen import _path_fragility_proxy, _pre_dag_filter, _pre_dag_signal_count


def _record(
    *,
    start: str,
    target: str,
    slice_id: str = "core_rank_v1",
    path_bucket: str = "medium",
    easy_corridor: int = 0,
    low_degree_bridge: int = 1,
    informative_bridge: int = 1,
    target_in_degree: int = 4,
    shortest_path_count: int = 2,
) -> dict[str, object]:
    return {
        "start": start,
        "target": target,
        "slice_id": slice_id,
        "path_bucket": path_bucket,
        "family_easy_corridor_path_count": easy_corridor,
        "witness_low_degree_bridge_count": low_degree_bridge,
        "witness_informative_bridge_count": informative_bridge,
        "target_in_degree": target_in_degree,
        "shortest_path_count": shortest_path_count,
    }


class FrontierCompanionRegenTests(unittest.TestCase):
    def test_pre_dag_signal_count_rejects_uncoupled_canonical_rows(self):
        row = _record(
            start="start-a",
            target="target-a",
            slice_id="diag_canonical_target_v1",
            easy_corridor=1,
            low_degree_bridge=0,
            target_in_degree=8,
        )
        self.assertLess(_pre_dag_signal_count(row), 0)

    def test_pre_dag_filter_keeps_only_promising_starts_and_caps_rows(self):
        single_weak_start = [_record(start="weak", target="weak-1", informative_bridge=2, target_in_degree=8, shortest_path_count=4)]
        strong_start = [
            _record(start="strong", target=f"strong-{idx}", target_in_degree=4 if idx % 2 == 0 else 6)
            for idx in range(8)
        ]
        paired_start = [
            _record(start="paired", target="paired-1", low_degree_bridge=0, informative_bridge=1, target_in_degree=3, shortest_path_count=3),
            _record(start="paired", target="paired-2", low_degree_bridge=1, informative_bridge=2, target_in_degree=8, shortest_path_count=2),
        ]

        filtered = _pre_dag_filter(single_weak_start + strong_start + paired_start)
        pairs = {(row["start"], row["target"]) for row in filtered}

        self.assertNotIn(("weak", "weak-1"), pairs)
        self.assertIn(("paired", "paired-1"), pairs)
        self.assertIn(("paired", "paired-2"), pairs)
        self.assertEqual(sum(1 for row in filtered if row["start"] == "strong"), 6)

    def test_path_fragility_proxy_rewards_low_route_multiplicity_and_narrow_internal_nodes(self):
        candidate = CandidateMatchup(
            start="start-a",
            target="target-a",
            shortest_path_hops=4,
            shortest_path=["start-a", "bridge-a", "bridge-b", "target-a"],
            path_bucket="short",
            start_out_degree=20,
            target_in_degree=4,
            start_width_bucket="narrow",
            feature_tags=(),
            tier="core_rank_v1",
            stable_rank="rank-a",
            shortest_path_count=2,
            family_easy_corridor_path_count=0,
            witness_low_degree_bridge_count=1,
            witness_informative_bridge_count=1,
        )
        degrees = {
            "bridge-a": DegreeStats(out_degree=3, in_degree=2),
            "bridge-b": DegreeStats(out_degree=7, in_degree=2),
        }

        share, first_depth, strong_count = _path_fragility_proxy(candidate, degrees=degrees, top_any_10=set())

        self.assertGreaterEqual(share, 0.5)
        self.assertEqual(first_depth, 1)
        self.assertGreaterEqual(strong_count, 1)


if __name__ == "__main__":
    unittest.main()
