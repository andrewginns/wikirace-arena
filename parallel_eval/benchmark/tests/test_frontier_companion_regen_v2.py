from __future__ import annotations

import unittest

from parallel_eval.benchmark.fixed_suite import CandidateMatchup
from parallel_eval.benchmark.frontier_companion_regen import RegenCandidate
from parallel_eval.benchmark.frontier_companion_regen_v2 import (
    CompanionV2Candidate,
    _cheap_primary_family,
    _offender_score,
    _representative_family_sample,
)


def _candidate(*, start: str, target: str, hops: int, path_bucket: str, target_in_degree: int = 4, shortest_path_count: int = 2) -> CandidateMatchup:
    return CandidateMatchup(
        start=start,
        target=target,
        shortest_path_hops=hops,
        shortest_path=[start, "bridge", target],
        path_bucket=path_bucket,
        start_out_degree=20,
        target_in_degree=target_in_degree,
        start_width_bucket="normal",
        feature_tags=(),
        tier="core_rank_v1",
        stable_rank=f"{start}-{target}",
        shortest_path_count=shortest_path_count,
        family_easy_corridor_path_count=0,
        witness_low_degree_bridge_count=1,
        witness_informative_bridge_count=1,
    )


def _regen(candidate: CandidateMatchup, *, source_slice_id: str = "core_rank_v1", canonical: bool = True) -> RegenCandidate:
    return RegenCandidate(
        candidate=candidate,
        source_status="reserve",
        source_slice_id=source_slice_id,
        source_reasons=(),
        target_identity_canonical=canonical,
        shortest_choke_share_max=0.75,
        first_strong_choke_depth=1,
        strong_choke_count=1,
        early_offpath_total=6,
        early_dead_end_ratio=0.2,
        early_carrier_ratio=0.3,
        early_informative_escape_count=0,
        local_information_poverty=1,
        cheap_hard_score=12.0,
        wrong_turn_tax_mean=2.9,
        rejoinable_ratio=0.0,
        unreachable_ratio=0.5,
        hard_score=14.0,
        family_labels=("route_fragility_v1", "core_rank_v2"),
        signature=("sig",),
    )


class FrontierCompanionRegenV2Tests(unittest.TestCase):
    def test_cheap_primary_family_prefers_target_rarity_source_when_coupled(self):
        candidate = _candidate(start="start-a", target="target-a", hops=5, path_bucket="medium", target_in_degree=3)
        family = _cheap_primary_family(
            candidate=candidate,
            source_slice_id="diag_target_rarity_v1",
            target_identity_canonical=False,
            early_dead_end_ratio=0.0,
            early_carrier_ratio=0.0,
            local_information_poverty=0,
        )
        self.assertEqual(family, "target_rarity_coupled_v1")

    def test_offender_score_penalizes_short_canonical_bridge_rows(self):
        candidate = _candidate(start="start-b", target="target-b", hops=4, path_bucket="short", target_in_degree=4)
        regen = _regen(candidate, canonical=True)
        score = _offender_score(regen)
        self.assertGreaterEqual(score, 6.0)

    def test_representative_family_sample_spreads_across_ranked_family(self):
        rows = []
        for index in range(10):
            candidate = _candidate(start=f"start-{index}", target=f"target-{index}", hops=5, path_bucket="medium")
            regen = _regen(candidate, source_slice_id="diag_bridge_pressure_v1", canonical=bool(index % 2))
            rows.append(
                CompanionV2Candidate(
                    regen=regen,
                    primary_family="route_fragility_v1",
                    family_count=2,
                    offender_score=float(index),
                    family_score=20.0 - float(index),
                )
            )

        sample = _representative_family_sample(rows, 4)
        starts = [row.regen.candidate.start for row in sample]
        self.assertEqual(len(sample), 4)
        self.assertIn("start-0", starts)
        self.assertIn("start-9", starts)


if __name__ == "__main__":
    unittest.main()
