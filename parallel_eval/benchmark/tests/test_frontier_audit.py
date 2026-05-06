from __future__ import annotations

import json
import sqlite3
import tempfile
import unittest
from pathlib import Path

from parallel_eval.benchmark.frontier_audit import (
    FrontierAuditItemV1,
    FrontierDistanceOracle,
    FrontierItemEvidenceV1,
    load_frontier_audit_items,
    suggest_frontier_audit_item,
    write_models_jsonl,
)


def _build_test_db(path: Path) -> None:
    conn = sqlite3.connect(path)
    cur = conn.cursor()
    cur.execute("CREATE TABLE core_articles (title TEXT PRIMARY KEY, links_json TEXT NOT NULL)")
    rows = {
        "Start": ["United States", "Closer", "WrongRegion"],
        "United States": ["Loop"],
        "Closer": ["Almost", "WrongSibling"],
        "Almost": ["Target", "WrongSibling"],
        "WrongRegion": ["Detour"],
        "Detour": ["Almost"],
        "WrongSibling": ["Loop"],
        "Loop": ["United States"],
        "Target": [],
    }
    for title, links in rows.items():
        cur.execute("INSERT INTO core_articles (title, links_json) VALUES (?, ?)", (title, json.dumps(links)))
    conn.commit()
    conn.close()


class FrontierAuditTests(unittest.TestCase):
    def test_analyze_run_marks_last_mile_and_wrong_basin_signals(self):
        with tempfile.TemporaryDirectory() as td:
            td_path = Path(td)
            db_path = td_path / "graph.db"
            _build_test_db(db_path)

            run = {"start": "Start", "target": "Target"}
            steps = [
                {
                    "current_article": "Start",
                    "selected_title": "WrongRegion",
                    "article": "WrongRegion",
                },
                {
                    "current_article": "Start",
                    "selected_title": "United States",
                    "article": "United States",
                },
                {
                    "current_article": "United States",
                    "selected_title": "Loop",
                    "article": "Loop",
                },
                {
                    "current_article": "Closer",
                    "selected_title": "WrongSibling",
                    "article": "WrongSibling",
                },
                {
                    "current_article": "Almost",
                    "selected_title": "WrongSibling",
                    "article": "WrongSibling",
                },
            ]

            with FrontierDistanceOracle(db_path, reverse_depth=4) as oracle:
                signals = oracle.analyze_run(run=run, steps=steps)

            self.assertTrue(signals.revisit_flag)
            self.assertTrue(signals.carrier_drift_flag)
            self.assertTrue(signals.near_target_progress_miss_flag)
            self.assertTrue(signals.direct_target_miss_flag)
            self.assertTrue(signals.wrong_basin_flag)
            self.assertTrue(signals.reached_distance_2)

    def test_suggest_frontier_audit_item_demotes_canonical_slice(self):
        evidence = FrontierItemEvidenceV1(
            benchmark_name="frontier_local_simplewiki_v1_1",
            benchmark_sha256="sha",
            item_key="m1",
            line_idx=0,
            matchup_id="m1",
            start="A",
            target="B",
            suite_id="frontier_local_simplewiki_v1_1",
            slice_id="diag_canonical_target_v1",
            target_in_degree=8,
            bundles_total=4,
            wins_total=4,
            losses_total=0,
        )
        audit = suggest_frontier_audit_item(evidence)
        self.assertEqual(audit.primary_slice, "canonical_easy")
        self.assertEqual(audit.recommended_action, "demote")
        self.assertEqual(audit.confidence, "high")

    def test_support_only_carrier_signal_does_not_force_controller_slice(self):
        evidence = FrontierItemEvidenceV1(
            benchmark_name="frontier_local_simplewiki_v1_1",
            benchmark_sha256="sha",
            item_key="m2",
            line_idx=1,
            matchup_id="m2",
            start="A",
            target="B",
            suite_id="frontier_local_simplewiki_v1_1",
            slice_id="core_rank_v1",
            target_in_degree=8,
            sampled_shortest_path_count=6,
            witness_carrier_bridge_count=2,
            witness_informative_bridge_count=1,
            family_easy_corridor_path_count=4,
            bundles_total=6,
            wins_total=3,
            losses_total=3,
            losses_with_revisit=0,
            losses_with_carrier_drift=2,
            losses_with_wrong_basin_step=0,
            losses_with_near_target_progress_miss=0,
        )
        audit = suggest_frontier_audit_item(evidence)
        self.assertNotEqual(audit.primary_slice, "controller_hard")
        self.assertEqual(audit.primary_slice, "mixed_unclear")

    def test_load_frontier_audit_items_rejects_duplicates(self):
        with tempfile.TemporaryDirectory() as td:
            td_path = Path(td)
            path = td_path / "audit.jsonl"
            row = FrontierAuditItemV1(
                benchmark_name="frontier_local_simplewiki_v1_1",
                benchmark_sha256="sha",
                item_key="m1",
                line_idx=0,
                matchup_id="m1",
                start="A",
                target="B",
                review_status="reviewed",
                confidence="high",
                primary_slice="controller_hard",
                recommended_action="keep",
            )
            write_models_jsonl(path, [row, row])
            with self.assertRaises(ValueError):
                load_frontier_audit_items(path)


if __name__ == "__main__":
    unittest.main()
