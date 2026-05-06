from __future__ import annotations

import json
import tempfile
import unittest
from pathlib import Path
from unittest import mock

from parallel_eval.benchmark.leaderboard import build_leaderboard
from parallel_eval.benchmark.schema import (
    BenchmarkRunRecordV1,
    RunBudgetsV1,
    RunModelSettingsV1,
    TokenTotalsV1,
    write_jsonl_line,
)


class LeaderboardTests(unittest.TestCase):
    def _write_run(
        self,
        path: Path,
        *,
        run_id: str,
        model: str,
        effort: str,
        result: str = "win",
        hops: int = 5,
        total_tokens: int = 100,
        latency_ms: int = 900,
        duration_ms: int = 1000,
        slice_id: str = "core_rank_v1",
        hops_over_shortest: int | None = None,
        dataset_id: str = "matchups/v1",
        setup_id: str = "classic_local_v1",
    ) -> None:
        score_inputs = {}
        if hops_over_shortest is not None:
            score_inputs["hops_over_shortest"] = hops_over_shortest

        write_jsonl_line(
            path,
            BenchmarkRunRecordV1(
                run_id=run_id,
                dataset_id=dataset_id,
                matchup_id=f"{run_id}-matchup",
                tier="baseline",
                suite_id="classic_local_simplewiki_v1",
                slice_id=slice_id,
                setup_id=setup_id,
                prompt_version="choose_link_v1",
                semantics_version="local_parity_v1",
                start="A",
                target="B",
                started_at="2026-01-01T00:00:00Z",
                finished_at="2026-01-01T00:00:01Z",
                result=result,
                hops=hops,
                duration_ms=duration_ms,
                llm_latency_ms=latency_ms,
                model_settings=RunModelSettingsV1(
                    model=model,
                    openai_reasoning_effort=effort,
                ),
                budgets=RunBudgetsV1(max_hops=20, max_links=None, max_tokens=None, max_tries=3),
                totals=TokenTotalsV1(total_tokens=total_tokens),
                score_inputs=score_inputs,
            ),
        )

    def test_build_leaderboard_uses_lexicographic_ranking_for_default_slice(self):
        with tempfile.TemporaryDirectory() as td:
            td_path = Path(td)
            a = td_path / "a.jsonl"
            b = td_path / "b.jsonl"

            self._write_run(
                a,
                run_id="run_a",
                model="openai-responses:gpt-5.2",
                effort="high",
                hops=6,
                total_tokens=120,
                latency_ms=1000,
                hops_over_shortest=0,
            )
            self._write_run(
                b,
                run_id="run_b",
                model="openai-responses:gpt-5.2",
                effort="medium",
                hops=6,
                total_tokens=110,
                latency_ms=800,
                hops_over_shortest=1,
            )

            with mock.patch(
                "parallel_eval.benchmark.leaderboard._suite_manifest_detail",
                return_value={
                    "suite_id": "classic_local_simplewiki_v1",
                    "generator_version": "classic_local_simplewiki_v1_gen1",
                    "is_seeded_fallback": False,
                    "benchmark_label": "Frontier 200",
                    "benchmark_role": "standard",
                    "methodology_notes": ["Ground truth uses exact shortest paths."],
                    "model_summaries": {
                        "gpt-5.2 high": {
                            "headline": "Strong published cell.",
                        }
                    },
                },
            ):
                leaderboard = build_leaderboard(inputs=[b, a])
            entries = leaderboard["entries"]
            self.assertEqual(leaderboard["version"], 2)
            self.assertEqual(leaderboard["default_slice_id"], "core_rank_v1")
            self.assertIn("classic_local_simplewiki_v1", leaderboard["suite_details"])
            self.assertFalse(leaderboard["suite_details"]["classic_local_simplewiki_v1"]["is_seeded_fallback"])
            self.assertEqual(
                leaderboard["suite_details"]["classic_local_simplewiki_v1"]["benchmark_label"],
                "Frontier 200",
            )
            self.assertEqual(
                leaderboard["suite_details"]["classic_local_simplewiki_v1"]["methodology_notes"],
                ["Ground truth uses exact shortest paths."],
            )
            self.assertEqual(
                leaderboard["suite_details"]["classic_local_simplewiki_v1"]["model_summaries"][
                    "gpt-5.2 high"
                ]["headline"],
                "Strong published cell.",
            )
            self.assertEqual(entries[0]["rank"], 1)
            self.assertEqual(entries[0]["label"], "gpt-5.2 high")
            self.assertEqual(entries[1]["rank"], 2)
            self.assertEqual(entries[1]["label"], "gpt-5.2 medium")

            meta0 = entries[0]["summary"]["meta"]
            self.assertEqual(meta0["model_settings"]["model"], "openai-responses:gpt-5.2")
            self.assertEqual(meta0["model_settings"]["openai_reasoning_effort"], "high")

            json.dumps(leaderboard)

    def test_dataset_filter(self):
        with tempfile.TemporaryDirectory() as td:
            td_path = Path(td)
            a = td_path / "a.jsonl"
            b = td_path / "b.jsonl"
            self._write_run(
                a,
                run_id="run_a",
                model="model-a",
                effort="low",
                dataset_id="matchups/classic_local_simplewiki_v1/all",
            )
            self._write_run(
                b,
                run_id="run_b",
                model="model-b",
                effort="high",
                dataset_id="matchups/legacy/all",
            )

            leaderboard = build_leaderboard(inputs=[a, b], dataset_id="matchups/other")
            self.assertEqual(len(leaderboard["entries"]), 0)
            self.assertEqual(leaderboard["available_dataset_ids"], [])
            self.assertEqual(leaderboard["available_suite_ids"], [])
            self.assertEqual(leaderboard["available_setup_ids"], [])

            filtered = build_leaderboard(inputs=[a, b], dataset_id="matchups/classic_local_simplewiki_v1/all")
            self.assertEqual(len(filtered["entries"]), 1)
            self.assertEqual(filtered["available_dataset_ids"], ["matchups/classic_local_simplewiki_v1/all"])

    def test_build_leaderboard_can_copy_viewer_artifacts(self):
        with tempfile.TemporaryDirectory() as td:
            td_path = Path(td)
            run_dir = td_path / "run"
            run_dir.mkdir(parents=True)
            records = run_dir / "records.jsonl"

            self._write_run(
                records,
                run_id="run_a",
                model="openai-responses:gpt-5.1",
                effort="medium",
            )

            viewer_json = run_dir / "viewer.json"
            viewer_json.write_text(json.dumps({"runs": [{"result": "win", "steps": ["A", "B"], "start_article": "A", "destination_article": "B"}]}), "utf-8")

            leaderboard = build_leaderboard(
                inputs=[records],
                viewer_out_dir=td_path / "public" / "benchmarks" / "viewers",
            )

            entry = leaderboard["entries"][0]
            self.assertTrue(entry["viewer_url"].startswith("/benchmarks/viewers/"))
            copied_path = Path(entry["viewer_public_path"])
            self.assertTrue(copied_path.exists())
            self.assertEqual(json.loads(copied_path.read_text("utf-8"))["runs"][0]["result"], "win")


if __name__ == "__main__":
    unittest.main()
