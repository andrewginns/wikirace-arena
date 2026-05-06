from __future__ import annotations

import tempfile
import unittest
from pathlib import Path

from parallel_eval.benchmark.report_text import build_text_report
from parallel_eval.benchmark.schema import (
    BenchmarkRunRecordV1,
    RunBudgetsV1,
    RunModelSettingsV1,
    TokenTotalsV1,
    write_jsonl_line,
)


class ReportTextTests(unittest.TestCase):
    def test_report_prefers_lexicographic_release_order(self):
        with tempfile.TemporaryDirectory() as td:
            td_path = Path(td)
            faster = td_path / "faster.jsonl"
            closer = td_path / "closer.jsonl"

            write_jsonl_line(
                faster,
                BenchmarkRunRecordV1(
                    run_id="run_fast",
                    dataset_id="matchups/classic_local_v1/core_rank_v1",
                    matchup_id="m1",
                    tier="core_rank_v1",
                    suite_id="classic_local_v1",
                    slice_id="core_rank_v1",
                    setup_id="classic_local_v1",
                    prompt_version="choose_link_v1",
                    semantics_version="local_parity_v1",
                    start="A",
                    target="B",
                    started_at="2026-01-01T00:00:00Z",
                    finished_at="2026-01-01T00:00:01Z",
                    result="win",
                    hops=6,
                    duration_ms=100,
                    llm_latency_ms=100,
                    model_settings=RunModelSettingsV1(model="model-fast"),
                    budgets=RunBudgetsV1(max_hops=20, max_links=None, max_tokens=None, max_tries=3),
                    totals=TokenTotalsV1(total_tokens=100),
                    score_inputs={"shortest_path_hops": 5, "hops_over_shortest": 1},
                ),
            )

            write_jsonl_line(
                closer,
                BenchmarkRunRecordV1(
                    run_id="run_closer",
                    dataset_id="matchups/classic_local_v1/core_rank_v1",
                    matchup_id="m1",
                    tier="core_rank_v1",
                    suite_id="classic_local_v1",
                    slice_id="core_rank_v1",
                    setup_id="classic_local_v1",
                    prompt_version="choose_link_v1",
                    semantics_version="local_parity_v1",
                    start="A",
                    target="B",
                    started_at="2026-01-01T00:00:00Z",
                    finished_at="2026-01-01T00:00:20Z",
                    result="win",
                    hops=5,
                    duration_ms=20_000,
                    llm_latency_ms=20_000,
                    model_settings=RunModelSettingsV1(model="model-closer"),
                    budgets=RunBudgetsV1(max_hops=20, max_links=None, max_tokens=None, max_tries=3),
                    totals=TokenTotalsV1(total_tokens=100_000),
                    score_inputs={"shortest_path_hops": 5, "hops_over_shortest": 0},
                ),
            )

            report = build_text_report(inputs=[faster, closer], slice_id="core_rank_v1")

            self.assertIn("## Suite Status", report)
            self.assertIn("## Success-Rate Leaderboard", report)
            self.assertIn("## Tokens vs Success Rate", report)
            self.assertIn("## Weakness Areas", report)
            self.assertIn("## Navigation Patterns", report)
            self.assertIn("## Loss Costs", report)
            self.assertIn("Legacy score", report)

            ranking_rows = [line for line in report.splitlines() if line.startswith("| 1 |")]
            self.assertEqual(len(ranking_rows), 1)
            self.assertIn("model-closer", ranking_rows[0])


if __name__ == "__main__":
    unittest.main()
