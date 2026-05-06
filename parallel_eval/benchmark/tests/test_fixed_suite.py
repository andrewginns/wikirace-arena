from __future__ import annotations

import json
import tempfile
import unittest
from pathlib import Path
from unittest import mock

from parallel_eval.benchmark.graph import DegreeStats
from parallel_eval.benchmark.fixed_suite import (
    ALL_DATASET_FILENAME,
    CLASSIC_SUITE_ID,
    DEFAULT_SUITE_ID,
    FRONTIER_COMPANION_REGEN_V1_SUITE_ID,
    FRONTIER_COMPANION_REGEN_V2_SUITE_ID,
    FRONTIER_REGRESSION_SUITE_ID,
    FRONTIER_STANDARD_SUITE_ID,
    FRONTIER_SUITE_ID,
    FRONTIER_V1_1_SUITE_ID,
    CandidateMatchup,
    GRAPH_NATIVE_CORE_CELL_QUOTAS,
    GRAPH_NATIVE_SLICE_COUNTS,
    _select_core_candidates,
    _write_audit_sample,
    generate_fixed_suite,
    probe_fixed_suite,
)


def _candidate(*, start: str, target: str, hops: int, width: str, tier: str, seed_rank: str) -> CandidateMatchup:
    return CandidateMatchup(
        start=start,
        target=target,
        shortest_path_hops=hops,
        shortest_path=[start, target],
        path_bucket={3: "short", 5: "medium", 7: "long", 9: "stretch"}[hops],
        start_out_degree={"narrow": 10, "normal": 50, "broad": 150, "wide": 400}[width],
        target_in_degree=20,
        start_width_bucket=width,
        feature_tags=(tier,),
        tier=tier,
        stable_rank=seed_rank,
    )


class FixedSuiteTests(unittest.TestCase):
    def test_select_core_candidates_meets_quotas_and_uniqueness(self):
        pools: dict[tuple[str, str], list[CandidateMatchup]] = {}
        for (path_bucket, width_bucket), quota in GRAPH_NATIVE_CORE_CELL_QUOTAS.items():
            hops = {"short": 3, "medium": 5}[path_bucket]
            pool: list[CandidateMatchup] = []
            for index in range(quota + 5):
                pool.append(
                    _candidate(
                        start=f"{width_bucket}-start-{path_bucket}-{index}",
                        target=f"{path_bucket}-target-{width_bucket}-{index}",
                        hops=hops,
                        width=width_bucket,
                        tier="core_rank_v1",
                        seed_rank=f"{path_bucket}-{width_bucket}-{index:04d}",
                    )
                )
            pools[(path_bucket, width_bucket)] = pool

        chosen = _select_core_candidates(pools=pools, seed=0, core_cell_quotas=GRAPH_NATIVE_CORE_CELL_QUOTAS)
        self.assertEqual(len(chosen), GRAPH_NATIVE_SLICE_COUNTS["core_rank_v1"])

        by_path = {}
        by_width = {}
        start_counts = {}
        seen_pairs = set()
        seen_targets = set()
        for candidate in chosen:
            by_path[candidate.path_bucket] = by_path.get(candidate.path_bucket, 0) + 1
            by_width[candidate.start_width_bucket] = by_width.get(candidate.start_width_bucket, 0) + 1
            start_counts[candidate.start] = start_counts.get(candidate.start, 0) + 1
            seen_pairs.add((candidate.start, candidate.target))
            seen_targets.add(candidate.target)

        self.assertEqual(by_path, {"short": 75, "medium": 75})
        self.assertEqual(by_width, {"narrow": 50, "normal": 50, "broad": 50})
        self.assertEqual(len(seen_pairs), len(chosen))
        self.assertEqual(len(seen_targets), len(chosen))
        self.assertGreaterEqual(len(start_counts), 50)
        self.assertLessEqual(max(start_counts.values()), 3)

    def test_generate_fixed_suite_writes_expected_files(self):
        core = [
            _candidate(
                start=f"core-start-{index}",
                target=f"core-target-{index}",
                hops=5,
                width="normal",
                tier="core_rank_v1",
                seed_rank=f"core-{index:04d}",
            )
            for index in range(150)
        ]
        diag_lists = [
            [
                _candidate(
                    start=f"{slice_name}-start-{index}",
                    target=f"{slice_name}-target-{index}",
                    hops=5,
                    width="wide" if slice_name == "diag_wide_choice_v1" else "normal",
                    tier=slice_name,
                    seed_rank=f"{slice_name}-{index:04d}",
                )
                for index in range(10)
            ]
            for slice_name in (
                "diag_wide_choice_v1",
                "diag_hub_escape_v1",
                "diag_hub_seek_v1",
                "diag_canonical_target_v1",
                "diag_dead_end_prone_v1",
            )
        ]

        degrees = {f"title-{index}": DegreeStats(out_degree=50, in_degree=20) for index in range(20)}
        fake_graph = mock.Mock()

        with tempfile.TemporaryDirectory() as td:
            td_path = Path(td)
            db_path = td_path / "fake.db"
            db_path.write_text("db", "utf-8")

            with (
                mock.patch("parallel_eval.benchmark.fixed_suite.compute_degrees", return_value=degrees),
                mock.patch("parallel_eval.benchmark.fixed_suite.SQLiteGraph", return_value=fake_graph),
                mock.patch("parallel_eval.benchmark.fixed_suite._identity_canonical_title", return_value=True),
                mock.patch("parallel_eval.benchmark.fixed_suite._dead_end_prone_ratio", return_value=0.5),
                mock.patch("parallel_eval.benchmark.fixed_suite._build_core_slice", return_value=core),
                mock.patch(
                    "parallel_eval.benchmark.fixed_suite._collect_diag_candidates",
                    return_value=[],
                ),
                mock.patch(
                    "parallel_eval.benchmark.fixed_suite._select_unique_candidates",
                    side_effect=diag_lists,
                ),
                mock.patch("parallel_eval.benchmark.fixed_suite.sha256_file", return_value="fake-sha256"),
            ):
                generate_fixed_suite(db_path=db_path, out_dir=td_path / "suite", suite_id=CLASSIC_SUITE_ID, seed=0)

            for slice_id, expected_count in GRAPH_NATIVE_SLICE_COUNTS.items():
                slice_path = td_path / "suite" / f"{slice_id}.jsonl"
                self.assertTrue(slice_path.exists())
                lines = [line for line in slice_path.read_text("utf-8").splitlines() if line.strip()]
                self.assertEqual(len(lines), expected_count)

            all_rows = [
                line
                for line in (td_path / "suite" / ALL_DATASET_FILENAME).read_text("utf-8").splitlines()
                if line.strip()
            ]
            self.assertEqual(len(all_rows), sum(GRAPH_NATIVE_SLICE_COUNTS.values()))

            manifest = json.loads((td_path / "suite" / "suite_manifest.json").read_text("utf-8"))
            for key in (
                "suite_id",
                "setup_id",
                "generated_at",
                "db_path",
                "db_sha256",
                "generator_version",
                "prompt_version",
                "semantics_version",
                "slice_counts",
                "selection_quotas",
                "selection_filters",
                "notes",
            ):
                self.assertIn(key, manifest)

    def test_probe_fixed_suite_reports_suite_status(self):
        with tempfile.TemporaryDirectory() as td:
            td_path = Path(td)
            db_path = td_path / "fake.db"
            db_path.write_text("db", "utf-8")
            fake_slices = {
                "core_rank_v1": [
                    _candidate(
                        start="start-a",
                        target="target-a",
                        hops=3,
                        width="narrow",
                        tier="core_rank_v1",
                        seed_rank="0001",
                    ),
                    _candidate(
                        start="start-a",
                        target="target-b",
                        hops=5,
                        width="narrow",
                        tier="core_rank_v1",
                        seed_rank="0002",
                    ),
                ],
                "diag_wide_choice_v1": [],
                "diag_hub_escape_v1": [],
                "diag_hub_seek_v1": [],
                "diag_canonical_target_v1": [],
                "diag_dead_end_prone_v1": [],
            }

            with (
                mock.patch("parallel_eval.benchmark.fixed_suite.generate_fixed_suite", return_value=fake_slices),
                mock.patch("parallel_eval.benchmark.fixed_suite.sha256_file", return_value="fake-sha256"),
            ):
                graph_report = probe_fixed_suite(db_path=db_path, suite_id=DEFAULT_SUITE_ID, seed=0)

            self.assertEqual(graph_report["status"], "supported")
            self.assertEqual(graph_report["slice_counts"]["core_rank_v1"], 2)
            self.assertEqual(graph_report["core_path_bucket_counts"], {"medium": 1, "short": 1})
            self.assertEqual(graph_report["core_unique_starts"], 1)
            self.assertEqual(graph_report["core_max_matchups_per_start"], 2)
            self.assertEqual(graph_report["db_sha256"], "fake-sha256")

    def test_probe_fixed_suite_reports_generation_failure(self):
        with tempfile.TemporaryDirectory() as td:
            td_path = Path(td)
            db_path = td_path / "fake.db"
            db_path.write_text("db", "utf-8")

            with mock.patch(
                "parallel_eval.benchmark.fixed_suite.generate_fixed_suite",
                side_effect=RuntimeError("missing diag slice"),
            ):
                graph_report = probe_fixed_suite(db_path=db_path, suite_id=DEFAULT_SUITE_ID, seed=0)

            self.assertEqual(graph_report["status"], "unsupported")
            self.assertIn("missing diag slice", graph_report["error"])

    def test_probe_fixed_suite_rejects_unknown_suite(self):
        with tempfile.TemporaryDirectory() as td:
            td_path = Path(td)
            db_path = td_path / "fake.db"
            db_path.write_text("db", "utf-8")

            with self.assertRaises(ValueError):
                probe_fixed_suite(db_path=db_path, suite_id="classic_local_v1", seed=0)

    def test_generate_fixed_suite_dispatches_to_frontier_suite(self):
        with tempfile.TemporaryDirectory() as td:
            td_path = Path(td)
            db_path = td_path / "fake.db"
            db_path.write_text("db", "utf-8")

            with mock.patch(
                "parallel_eval.benchmark.fixed_suite._generate_frontier_fixed_suite",
                return_value={"core_rank_v1": []},
            ) as generate_frontier:
                result = generate_fixed_suite(
                    db_path=db_path,
                    out_dir=td_path / "suite",
                    suite_id=FRONTIER_SUITE_ID,
                    seed=7,
                )

            self.assertEqual(result, {"core_rank_v1": []})
            generate_frontier.assert_called_once()

    def test_generate_fixed_suite_dispatches_to_frontier_v1_1_suite(self):
        with tempfile.TemporaryDirectory() as td:
            td_path = Path(td)
            db_path = td_path / "fake.db"
            db_path.write_text("db", "utf-8")

            with mock.patch(
                "parallel_eval.benchmark.fixed_suite._generate_frontier_v1_1_fixed_suite",
                return_value={"core_rank_v1": []},
            ) as generate_frontier:
                result = generate_fixed_suite(
                    db_path=db_path,
                    out_dir=td_path / "suite",
                    suite_id=FRONTIER_V1_1_SUITE_ID,
                    seed=11,
                )

            self.assertEqual(result, {"core_rank_v1": []})
            generate_frontier.assert_called_once()

    def test_generate_fixed_suite_dispatches_to_frontier_standard_alias(self):
        with tempfile.TemporaryDirectory() as td:
            td_path = Path(td)
            db_path = td_path / "fake.db"
            db_path.write_text("db", "utf-8")

            with mock.patch(
                "parallel_eval.benchmark.fixed_suite._materialize_prebuilt_alias_suite",
                return_value={"core_rank_v1": []},
            ) as generate_alias:
                result = generate_fixed_suite(
                    db_path=db_path,
                    out_dir=td_path / "suite",
                    suite_id=FRONTIER_STANDARD_SUITE_ID,
                    seed=19,
                )

            self.assertEqual(result, {"core_rank_v1": []})
            generate_alias.assert_called_once()

    def test_generate_fixed_suite_dispatches_to_frontier_regression_alias(self):
        with tempfile.TemporaryDirectory() as td:
            td_path = Path(td)
            db_path = td_path / "fake.db"
            db_path.write_text("db", "utf-8")

            with mock.patch(
                "parallel_eval.benchmark.fixed_suite._materialize_prebuilt_alias_suite",
                return_value={"core_rank_v1": []},
            ) as generate_alias:
                result = generate_fixed_suite(
                    db_path=db_path,
                    out_dir=td_path / "suite",
                    suite_id=FRONTIER_REGRESSION_SUITE_ID,
                    seed=23,
                )

            self.assertEqual(result, {"core_rank_v1": []})
            generate_alias.assert_called_once()

    def test_generate_fixed_suite_dispatches_to_frontier_regen_suite(self):
        with tempfile.TemporaryDirectory() as td:
            td_path = Path(td)
            db_path = td_path / "fake.db"
            db_path.write_text("db", "utf-8")

            with mock.patch(
                "parallel_eval.benchmark.frontier_companion_regen.generate_frontier_companion_regen_fixed_suite",
                return_value={"diag_bridge_pressure_v2": []},
            ) as generate_regen:
                result = generate_fixed_suite(
                    db_path=db_path,
                    out_dir=td_path / "suite",
                    suite_id=FRONTIER_COMPANION_REGEN_V1_SUITE_ID,
                    seed=13,
                )

            self.assertEqual(result, {"diag_bridge_pressure_v2": []})
            generate_regen.assert_called_once()

    def test_generate_fixed_suite_dispatches_to_frontier_regen_v2_suite(self):
        with tempfile.TemporaryDirectory() as td:
            td_path = Path(td)
            db_path = td_path / "fake.db"
            db_path.write_text("db", "utf-8")

            with mock.patch(
                "parallel_eval.benchmark.frontier_companion_regen_v2.generate_frontier_companion_regen_v2_fixed_suite",
                return_value={"route_fragility_v1": []},
            ) as generate_regen_v2:
                result = generate_fixed_suite(
                    db_path=db_path,
                    out_dir=td_path / "suite",
                    suite_id=FRONTIER_COMPANION_REGEN_V2_SUITE_ID,
                    seed=17,
                )

            self.assertEqual(result, {"route_fragility_v1": []})
            generate_regen_v2.assert_called_once()

    def test_write_audit_sample_includes_selected_records(self):
        candidate_records = [
            {
                "status": "selected",
                "start": "start-a",
                "target": "target-a",
                "shortest_path": ["start-a", "bridge-a", "target-a"],
                "reasons": [],
                "shortest_path_count": 2,
                "witness_informative_bridge_count": 2,
                "family_carrier_bridge_count_max": 1,
            },
            {
                "status": "rejected",
                "start": "start-b",
                "target": "target-b",
                "shortest_path": ["start-b", "bridge-b", "target-b"],
                "reasons": ["artifact_bridge_in_shortest_family"],
                "shortest_path_count": 1,
                "family_easy_corridor_path_count": 1,
                "family_carrier_bridge_count_max": 1,
                "witness_low_degree_bridge_count": 1,
                "family_informative_bridge_count_max": 0,
            },
        ]

        with tempfile.TemporaryDirectory() as td:
            td_path = Path(td)
            _write_audit_sample(out_dir=td_path, candidate_records=candidate_records)
            text = (td_path / "audit_sample.md").read_text("utf-8")

        self.assertIn("## Selected: Fair-Hard Sample", text)
        self.assertIn("`start-a -> target-a`", text)


if __name__ == "__main__":
    unittest.main()
