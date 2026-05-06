from __future__ import annotations

import json
import tempfile
import unittest
from pathlib import Path

from parallel_eval.benchmark.schema import (
    BenchmarkRunRecordV1,
    BenchmarkStepRecordV1,
    RunBudgetsV1,
    RunModelSettingsV1,
    TokenTotalsV1,
    write_jsonl_line,
)
from parallel_eval.benchmark.summarize import summarize_benchmark_jsonl


class RoundTripTests(unittest.TestCase):
    def test_jsonl_to_summary_and_viewer(self):
        with tempfile.TemporaryDirectory() as td:
            td_path = Path(td)
            jsonl_path = td_path / "run.jsonl"
            summary_path = td_path / "run.summary.json"
            viewer_path = td_path / "run.viewer.json"

            run = BenchmarkRunRecordV1(
                run_id="run_test",
                dataset_id="matchups/smoke",
                matchup_id="m1",
                tier="baseline",
                start="A",
                target="D",
                shortest_path_hops=2,
                started_at="2026-01-01T00:00:00Z",
                finished_at="2026-01-01T00:00:10Z",
                result="win",
                hops=2,
                duration_ms=10_000,
                llm_latency_ms=5_000,
                model_settings=RunModelSettingsV1(model="test-model"),
                budgets=RunBudgetsV1(max_hops=20, max_links=200, max_tokens=None, max_tries=3),
                totals=TokenTotalsV1(prompt_tokens=10, completion_tokens=5, total_tokens=15),
            )
            write_jsonl_line(jsonl_path, run)
            write_jsonl_line(
                jsonl_path,
                BenchmarkStepRecordV1(
                    run_id="run_test",
                    hop=1,
                    at="2026-01-01T00:00:02Z",
                    step_type="move",
                    article="B",
                    choice={"selected_index": 1, "tries": 0, "answer_errors": []},
                    usage={"prompt_tokens": 5, "completion_tokens": 2, "total_tokens": 7},
                    latency_ms=100,
                ),
            )
            write_jsonl_line(
                jsonl_path,
                BenchmarkStepRecordV1(
                    run_id="run_test",
                    hop=2,
                    at="2026-01-01T00:00:05Z",
                    step_type="win",
                    article="D",
                    choice={"selected_index": 2, "tries": 0, "answer_errors": []},
                    usage={"prompt_tokens": 5, "completion_tokens": 3, "total_tokens": 8},
                    latency_ms=200,
                ),
            )

            summarize_benchmark_jsonl(
                jsonl_path=jsonl_path,
                out_summary_path=summary_path,
                out_viewer_path=viewer_path,
            )

            self.assertTrue(summary_path.exists())
            self.assertTrue(viewer_path.exists())

            summary = json.loads(summary_path.read_text("utf-8"))
            self.assertIn("overall", summary)
            self.assertEqual(summary["overall"]["wins"], 1)
            self.assertEqual(summary["overall"]["ground_truth_coverage"]["runs_with_shortest_path_hops"], 1)
            self.assertEqual(summary["overall"]["hops_gap_win"]["mean"], 0.0)
            self.assertEqual(summary["overall"]["solved_at_optimal_win"]["count"], 1)
            self.assertEqual(summary["overall"]["solved_at_optimal_win"]["rate"], 1.0)

            viewer = json.loads(viewer_path.read_text("utf-8"))
            self.assertIn("runs", viewer)
            self.assertEqual(len(viewer["runs"]), 1)
            self.assertEqual(viewer["runs"][0]["shortest_path_hops"], 2)
            self.assertEqual(viewer["runs"][0]["hops_gap"], 0)


if __name__ == "__main__":
    unittest.main()
