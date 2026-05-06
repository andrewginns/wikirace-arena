from __future__ import annotations

import json
import tempfile
import unittest
from pathlib import Path

from parallel_eval.benchmark.import_viewer import import_viewer_json
from parallel_eval.benchmark.schema import read_jsonl


class ImportViewerTests(unittest.TestCase):
    def test_import_viewer_preserves_explicit_unlimited_budgets(self):
        with tempfile.TemporaryDirectory() as td:
            td_path = Path(td)
            viewer_path = td_path / "viewer.json"
            viewer_path.write_text(
                json.dumps(
                    {
                        "agent_settings": {
                            "max_links": 200,
                            "max_tokens": 16000,
                        },
                        "runs": [
                            {
                                "model": "openai-responses:gpt-5.2",
                                "start_article": "Start",
                                "destination_article": "Target",
                                "result": "win",
                                "max_links": None,
                                "max_tokens": None,
                                "steps": [
                                    {"type": "start", "article": "Start"},
                                    {"type": "win", "article": "Target"},
                                ],
                            }
                        ],
                    }
                ),
                "utf-8",
            )

            out_path = td_path / "records.jsonl"
            import_viewer_json(
                viewer_json_path=viewer_path,
                dataset_path=None,
                dataset_id=None,
                out_path=out_path,
                overwrite=False,
            )

            lines = read_jsonl(out_path)
            run = next(line.data for line in lines if line.data.get("type") == "run")
            self.assertIsNone(run["budgets"]["max_links"])
            self.assertIsNone(run["budgets"]["max_tokens"])

    def test_import_viewer_prefers_exported_attempt_count(self):
        with tempfile.TemporaryDirectory() as td:
            td_path = Path(td)
            viewer_path = td_path / "viewer.json"
            viewer_path.write_text(
                json.dumps(
                    {
                        "runs": [
                            {
                                "model": "openai-responses:gpt-5.2",
                                "start_article": "Start",
                                "destination_article": "Target",
                                "result": "lose",
                                "steps": [
                                    {"type": "start", "article": "Start"},
                                    {
                                        "type": "lose",
                                        "article": "Start",
                                        "metadata": {
                                            "reason": "bad_answer",
                                            "tries": 3,
                                            "attempt_count": 3,
                                            "llm_output": "<answer>bad</answer>",
                                        },
                                    },
                                ],
                            }
                        ]
                    }
                ),
                "utf-8",
            )

            out_path = td_path / "records.jsonl"
            import_viewer_json(
                viewer_json_path=viewer_path,
                dataset_path=None,
                dataset_id=None,
                out_path=out_path,
                overwrite=False,
            )

            lines = read_jsonl(out_path)
            step = next(line.data for line in lines if line.data.get("type") == "step")
            self.assertEqual(step["attempt_count"], 3)
            self.assertEqual(step["choice"]["tries"], 2)

    def test_import_viewer_preserves_queue_wait_and_unknown_step_metadata(self):
        with tempfile.TemporaryDirectory() as td:
            td_path = Path(td)
            viewer_path = td_path / "viewer.json"
            viewer_path.write_text(
                json.dumps(
                    {
                        "runs": [
                            {
                                "model": "openai-responses:gpt-5.2",
                                "start_article": "Start",
                                "destination_article": "Target",
                                "result": "lose",
                                "steps": [
                                    {"type": "start", "article": "Start"},
                                    {
                                        "type": "lose",
                                        "article": "Start",
                                        "metadata": {
                                            "reason": "bad_answer",
                                            "queue_wait_ms": 123,
                                            "selected_index": 1,
                                            "custom_debug": {"provider": "test"},
                                        },
                                    },
                                ],
                            }
                        ]
                    }
                ),
                "utf-8",
            )

            out_path = td_path / "records.jsonl"
            import_viewer_json(
                viewer_json_path=viewer_path,
                dataset_path=None,
                dataset_id=None,
                out_path=out_path,
                overwrite=False,
            )

            lines = read_jsonl(out_path)
            step = next(line.data for line in lines if line.data.get("type") == "step")
            self.assertEqual(step["meta"]["queue_wait_ms"], 123)
            self.assertEqual(step["meta"]["selected_index"], 1)
            self.assertEqual(step["meta"]["custom_debug"], {"provider": "test"})

    def test_import_viewer_preserves_zero_usage_and_alias_totals(self):
        with tempfile.TemporaryDirectory() as td:
            td_path = Path(td)
            viewer_path = td_path / "viewer.json"
            viewer_path.write_text(
                json.dumps(
                    {
                        "runs": [
                            {
                                "model": "openai-responses:gpt-5.2",
                                "start_article": "Start",
                                "destination_article": "Target",
                                "result": "lose",
                                "steps": [
                                    {"type": "start", "article": "Start", "at": "2026-03-08T12:00:10Z"},
                                    {
                                        "type": "move",
                                        "article": "Intermediate",
                                        "at": "2026-03-08T12:00:11Z",
                                        "metadata": {
                                            "selected_index": 1,
                                            "prompt_tokens": 0,
                                            "completion_tokens": 0,
                                            "total_tokens": 0,
                                            "latency_ms": 0,
                                            "duration_ms": 99,
                                        },
                                    },
                                    {
                                        "type": "lose",
                                        "article": "Intermediate",
                                        "at": "2026-03-08T12:00:12Z",
                                        "metadata": {
                                            "reason": "bad_answer",
                                            "input_tokens": 12,
                                            "output_tokens": 8,
                                            "duration_ms": 25,
                                        },
                                    },
                                ],
                            }
                        ]
                    }
                ),
                "utf-8",
            )

            out_path = td_path / "records.jsonl"
            import_viewer_json(
                viewer_json_path=viewer_path,
                dataset_path=None,
                dataset_id=None,
                out_path=out_path,
                overwrite=False,
            )

            lines = read_jsonl(out_path)
            run = next(line.data for line in lines if line.data.get("type") == "run")
            steps = [line.data for line in lines if line.data.get("type") == "step"]

            self.assertEqual(run["totals"]["prompt_tokens"], 12)
            self.assertEqual(run["totals"]["completion_tokens"], 8)
            self.assertEqual(run["totals"]["total_tokens"], 20)
            self.assertEqual(run["llm_latency_ms"], 25)

            self.assertEqual(steps[0]["usage"]["prompt_tokens"], 0)
            self.assertEqual(steps[0]["usage"]["completion_tokens"], 0)
            self.assertEqual(steps[0]["usage"]["total_tokens"], 0)
            self.assertEqual(steps[0]["latency_ms"], 0)

            self.assertEqual(steps[1]["usage"]["prompt_tokens"], 12)
            self.assertEqual(steps[1]["usage"]["completion_tokens"], 8)
            self.assertEqual(steps[1]["usage"]["total_tokens"], 20)
            self.assertEqual(steps[1]["latency_ms"], 25)

    def test_import_viewer_counts_only_article_transitions_as_hops(self):
        with tempfile.TemporaryDirectory() as td:
            td_path = Path(td)
            viewer_path = td_path / "viewer.json"
            viewer_path.write_text(
                json.dumps(
                    {
                        "runs": [
                            {
                                "model": "openai-responses:gpt-5.2",
                                "start_article": "Start",
                                "destination_article": "Target",
                                "result": "lose",
                                "steps": [
                                    {"type": "start", "article": "Start"},
                                    {"type": "move", "article": "Intermediate"},
                                    {
                                        "type": "lose",
                                        "article": "Intermediate",
                                        "metadata": {"reason": "bad_answer"},
                                    },
                                ],
                            }
                        ]
                    }
                ),
                "utf-8",
            )

            out_path = td_path / "records.jsonl"
            import_viewer_json(
                viewer_json_path=viewer_path,
                dataset_path=None,
                dataset_id=None,
                out_path=out_path,
                overwrite=False,
            )

            lines = read_jsonl(out_path)
            run = next(line.data for line in lines if line.data.get("type") == "run")
            steps = [line.data for line in lines if line.data.get("type") == "step"]

            self.assertEqual(run["hops"], 1)
            self.assertEqual([step["hop"] for step in steps], [1, 1])

    def test_import_viewer_uses_zero_hop_for_initial_noop_loss(self):
        with tempfile.TemporaryDirectory() as td:
            td_path = Path(td)
            viewer_path = td_path / "viewer.json"
            viewer_path.write_text(
                json.dumps(
                    {
                        "runs": [
                            {
                                "model": "openai-responses:gpt-5.2",
                                "start_article": "Start",
                                "destination_article": "Target",
                                "result": "lose",
                                "steps": [
                                    {"type": "start", "article": "Start"},
                                    {
                                        "type": "lose",
                                        "article": "Start",
                                        "metadata": {"reason": "bad_answer"},
                                    },
                                ],
                            }
                        ]
                    }
                ),
                "utf-8",
            )

            out_path = td_path / "records.jsonl"
            import_viewer_json(
                viewer_json_path=viewer_path,
                dataset_path=None,
                dataset_id=None,
                out_path=out_path,
                overwrite=False,
            )

            lines = read_jsonl(out_path)
            run = next(line.data for line in lines if line.data.get("type") == "run")
            step = next(line.data for line in lines if line.data.get("type") == "step")
            self.assertEqual(run["hops"], 0)
            self.assertEqual(step["hop"], 0)
            self.assertEqual(step["current_article"], "Start")
            self.assertEqual(step["article"], "Start")

    def test_import_viewer_strips_fragment_only_noop_transitions(self):
        with tempfile.TemporaryDirectory() as td:
            td_path = Path(td)
            viewer_path = td_path / "viewer.json"
            viewer_path.write_text(
                json.dumps(
                    {
                        "runs": [
                            {
                                "model": "openai-responses:gpt-5.2",
                                "start_article": "Start",
                                "destination_article": "Target",
                                "result": "lose",
                                "steps": [
                                    {"type": "start", "article": "Start"},
                                    {"type": "move", "article": "Start#History"},
                                    {
                                        "type": "lose",
                                        "article": "Start#References",
                                        "metadata": {"reason": "bad_answer"},
                                    },
                                ],
                            }
                        ]
                    }
                ),
                "utf-8",
            )

            out_path = td_path / "records.jsonl"
            import_viewer_json(
                viewer_json_path=viewer_path,
                dataset_path=None,
                dataset_id=None,
                out_path=out_path,
                overwrite=False,
            )

            lines = read_jsonl(out_path)
            run = next(line.data for line in lines if line.data.get("type") == "run")
            steps = [line.data for line in lines if line.data.get("type") == "step"]
            self.assertEqual(run["hops"], 0)
            self.assertEqual([step["hop"] for step in steps], [0, 0])
            self.assertEqual([step["article"] for step in steps], ["Start", "Start"])

    def test_import_viewer_treats_fragment_only_steps_as_noops(self):
        with tempfile.TemporaryDirectory() as td:
            td_path = Path(td)
            viewer_path = td_path / "viewer.json"
            viewer_path.write_text(
                json.dumps(
                    {
                        "runs": [
                            {
                                "model": "openai-responses:gpt-5.2",
                                "start_article": "Start",
                                "destination_article": "Target",
                                "result": "lose",
                                "steps": [
                                    {"type": "start", "article": "Start"},
                                    {"type": "move", "article": "Start#Section"},
                                    {
                                        "type": "lose",
                                        "article": "Start",
                                        "metadata": {"reason": "bad_answer"},
                                    },
                                ],
                            }
                        ]
                    }
                ),
                "utf-8",
            )

            out_path = td_path / "records.jsonl"
            import_viewer_json(
                viewer_json_path=viewer_path,
                dataset_path=None,
                dataset_id=None,
                out_path=out_path,
                overwrite=False,
            )

            lines = read_jsonl(out_path)
            run = next(line.data for line in lines if line.data.get("type") == "run")
            steps = [line.data for line in lines if line.data.get("type") == "step"]

            self.assertEqual(run["hops"], 0)
            self.assertEqual([step["hop"] for step in steps], [0, 0])
            self.assertEqual(steps[0]["current_article"], "Start")
            self.assertEqual(steps[0]["article"], "Start")

    def test_import_viewer_treats_anchor_only_steps_as_noops(self):
        with tempfile.TemporaryDirectory() as td:
            td_path = Path(td)
            viewer_path = td_path / "viewer.json"
            viewer_path.write_text(
                json.dumps(
                    {
                        "runs": [
                            {
                                "model": "openai-responses:gpt-5.2",
                                "start_article": "Start",
                                "destination_article": "Target",
                                "result": "lose",
                                "steps": [
                                    {"type": "start", "article": "Start"},
                                    {"type": "move", "article": "#Section"},
                                    {
                                        "type": "lose",
                                        "article": "#References",
                                        "metadata": {"reason": "bad_answer"},
                                    },
                                ],
                            }
                        ]
                    }
                ),
                "utf-8",
            )

            out_path = td_path / "records.jsonl"
            import_viewer_json(
                viewer_json_path=viewer_path,
                dataset_path=None,
                dataset_id=None,
                out_path=out_path,
                overwrite=False,
            )

            lines = read_jsonl(out_path)
            run = next(line.data for line in lines if line.data.get("type") == "run")
            steps = [line.data for line in lines if line.data.get("type") == "step"]

            self.assertEqual(run["hops"], 0)
            self.assertEqual([step["hop"] for step in steps], [0, 0])
            self.assertEqual([step["article"] for step in steps], ["Start", "Start"])

    def test_import_viewer_uses_canonical_dataset_id_when_dataset_is_provided(self):
        with tempfile.TemporaryDirectory() as td:
            td_path = Path(td)
            viewer_path = td_path / "viewer.json"
            viewer_path.write_text(
                json.dumps(
                    {
                        "runs": [
                            {
                                "model": "openai-responses:gpt-5.2",
                                "start_article": "Start",
                                "destination_article": "Target",
                                "result": "win",
                                "steps": [
                                    {"type": "start", "article": "Start"},
                                    {"type": "win", "article": "Target"},
                                ],
                            }
                        ]
                    }
                ),
                "utf-8",
            )
            dataset_path = td_path / "dataset.jsonl"
            dataset_path.write_text(
                json.dumps(
                    {
                        "id": "m1",
                        "tier": "core_rank_v1",
                        "start": "Start",
                        "target": "Target",
                        "suite_id": "classic_local_simplewiki_v1",
                        "slice_id": "core_rank_v1",
                        "setup_id": "classic_local_v1",
                    }
                )
                + "\n",
                "utf-8",
            )

            out_path = td_path / "records.jsonl"
            import_viewer_json(
                viewer_json_path=viewer_path,
                dataset_path=dataset_path,
                dataset_id=None,
                out_path=out_path,
                overwrite=False,
            )

            lines = read_jsonl(out_path)
            run = next(line.data for line in lines if line.data.get("type") == "run")
            self.assertEqual(run["dataset_id"], "matchups/classic_local_simplewiki_v1/core_rank_v1")

    def test_import_viewer_clamps_negative_hops_over_shortest(self):
        with tempfile.TemporaryDirectory() as td:
            td_path = Path(td)
            viewer_path = td_path / "viewer.json"
            viewer_path.write_text(
                json.dumps(
                    {
                        "runs": [
                            {
                                "model": "openai-responses:gpt-5.2",
                                "start_article": "Start",
                                "destination_article": "Target",
                                "result": "win",
                                "steps": [
                                    {"type": "start", "article": "Start"},
                                    {"type": "win", "article": "Target"},
                                ],
                            }
                        ]
                    }
                ),
                "utf-8",
            )
            dataset_path = td_path / "dataset.jsonl"
            dataset_path.write_text(
                json.dumps(
                    {
                        "id": "m1",
                        "tier": "core_rank_v1",
                        "start": "Start",
                        "target": "Target",
                        "suite_id": "classic_local_simplewiki_v1",
                        "slice_id": "core_rank_v1",
                        "setup_id": "classic_local_v1",
                        "shortest_path_hops": 5,
                    }
                )
                + "\n",
                "utf-8",
            )

            out_path = td_path / "records.jsonl"
            import_viewer_json(
                viewer_json_path=viewer_path,
                dataset_path=dataset_path,
                dataset_id=None,
                out_path=out_path,
                overwrite=False,
            )

            lines = read_jsonl(out_path)
            run = next(line.data for line in lines if line.data.get("type") == "run")
            self.assertEqual(run["hops"], 1)
            self.assertEqual(run["score_inputs"]["shortest_path_hops"], 5)
            self.assertEqual(run["score_inputs"]["hops_over_shortest"], 0)

    def test_import_viewer_ignores_unknown_step_articles_for_hop_state(self):
        with tempfile.TemporaryDirectory() as td:
            td_path = Path(td)
            viewer_path = td_path / "viewer.json"
            viewer_path.write_text(
                json.dumps(
                    {
                        "runs": [
                            {
                                "id": "run_note_teleport",
                                "model": "openai-responses:gpt-5.2",
                                "start_article": "Start",
                                "destination_article": "Target",
                                "result": "win",
                                "steps": [
                                    {"type": "start", "article": "Start"},
                                    {"type": "note", "article": "Other"},
                                    {"type": "win", "article": "Target"},
                                ],
                            }
                        ]
                    }
                ),
                "utf-8",
            )

            out_path = td_path / "records.jsonl"
            import_viewer_json(
                viewer_json_path=viewer_path,
                dataset_path=None,
                dataset_id=None,
                out_path=out_path,
                overwrite=False,
            )

            lines = read_jsonl(out_path)
            run = next(line.data for line in lines if line.data.get("type") == "run")
            step = next(line.data for line in lines if line.data.get("type") == "step")
            self.assertEqual(run["hops"], 1)
            self.assertEqual(step["current_article"], "Start")
            self.assertEqual(step["article"], "Target")
            self.assertEqual(step["hop"], 1)

    def test_import_viewer_accepts_legacy_string_step_paths(self):
        with tempfile.TemporaryDirectory() as td:
            td_path = Path(td)
            viewer_path = td_path / "viewer.json"
            viewer_path.write_text(
                json.dumps(
                    {
                        "runs": [
                            {
                                "id": "run_legacy_strings",
                                "model": "openai-responses:gpt-5.2",
                                "start_article": "Start",
                                "destination_article": "Target",
                                "result": "win",
                                "steps": ["Start", "Middle", "Target"],
                            }
                        ]
                    }
                ),
                "utf-8",
            )

            out_path = td_path / "records.jsonl"
            import_viewer_json(
                viewer_json_path=viewer_path,
                dataset_path=None,
                dataset_id=None,
                out_path=out_path,
                overwrite=False,
            )

            lines = read_jsonl(out_path)
            run = next(line.data for line in lines if line.data.get("type") == "run")
            steps = [line.data for line in lines if line.data.get("type") == "step"]

            self.assertEqual(run["result"], "win")
            self.assertEqual(run["hops"], 2)
            self.assertEqual([step["article"] for step in steps], ["Middle", "Target"])
            self.assertEqual([step["hop"] for step in steps], [1, 2])

    def test_import_viewer_skips_runs_with_no_valid_step_entries_after_filtering(self):
        with tempfile.TemporaryDirectory() as td:
            td_path = Path(td)
            viewer_path = td_path / "viewer.json"
            viewer_path.write_text(
                json.dumps(
                    {
                        "runs": [
                            {
                                "id": "run_broken",
                                "model": "openai-responses:gpt-5.2",
                                "start_article": "Start",
                                "destination_article": "Target",
                                "result": "lose",
                                "steps": [123],
                            },
                            {
                                "id": "run_valid",
                                "model": "openai-responses:gpt-5.2",
                                "start_article": "Start",
                                "destination_article": "Target",
                                "result": "win",
                                "steps": [
                                    {"type": "start", "article": "Start"},
                                    {"type": "win", "article": "Target"},
                                ],
                            },
                        ]
                    }
                ),
                "utf-8",
            )

            out_path = td_path / "records.jsonl"
            with self.assertWarnsRegex(
                RuntimeWarning,
                "Skipped 1 viewer run\\(s\\) with no valid step entries after filtering: run_broken",
            ):
                import_viewer_json(
                    viewer_json_path=viewer_path,
                    dataset_path=None,
                    dataset_id=None,
                    out_path=out_path,
                    overwrite=False,
                )

            lines = read_jsonl(out_path)
            run_records = [line.data for line in lines if line.data.get("type") == "run"]
            step_records = [line.data for line in lines if line.data.get("type") == "step"]

            self.assertEqual(len(run_records), 1)
            self.assertEqual(len(step_records), 1)
            self.assertEqual(run_records[0]["result"], "win")

    def test_import_viewer_falls_back_to_legacy_result_and_preserves_abandoned_reason(self):
        with tempfile.TemporaryDirectory() as td:
            td_path = Path(td)
            viewer_path = td_path / "viewer.json"
            viewer_path.write_text(
                json.dumps(
                    {
                        "runs": [
                            {
                                "id": "run_partial_legacy",
                                "model": "openai-responses:gpt-5.2",
                                "start_article": "Start",
                                "destination_article": "Target",
                                "result": "lose",
                                "steps": [
                                    {"type": "start", "article": "Start"},
                                ],
                            },
                            {
                                "id": "run_partial_unknown",
                                "model": "openai-responses:gpt-5.2",
                                "start_article": "Start",
                                "destination_article": "Target",
                                "result": "running",
                                "steps": [
                                    {"type": "start", "article": "Start"},
                                ],
                            },
                            {
                                "id": "run_abandoned",
                                "model": "human/Ada",
                                "start_article": "Start",
                                "destination_article": "Target",
                                "result": "abandoned",
                                "steps": [
                                    {"type": "start", "article": "Start"},
                                    {
                                        "type": "lose",
                                        "article": "Start",
                                    },
                                ],
                            },
                            {
                                "id": "run_max_hops",
                                "model": "openai-responses:gpt-5.2",
                                "start_article": "Start",
                                "destination_article": "Target",
                                "result": "lose",
                                "steps": [
                                    {"type": "start", "article": "Start"},
                                    {
                                        "type": "move",
                                        "article": "Intermediate",
                                    },
                                    {
                                        "type": "lose",
                                        "article": "Intermediate",
                                        "metadata": {
                                            "reason": "max_hops",
                                            "max_hops": 1,
                                        },
                                    },
                                ],
                            },
                        ]
                    }
                ),
                "utf-8",
            )

            out_path = td_path / "records.jsonl"
            with self.assertWarnsRegex(
                RuntimeWarning,
                "Skipped 1 viewer run\\(s\\) without a terminal win/lose step: run_partial_unknown",
            ):
                import_viewer_json(
                    viewer_json_path=viewer_path,
                    dataset_path=None,
                    dataset_id=None,
                    out_path=out_path,
                    overwrite=False,
                )

            lines = read_jsonl(out_path)
            run_records = [line.data for line in lines if line.data.get("type") == "run"]

            self.assertEqual(len(run_records), 3)
            llm_records = [
                record
                for record in run_records
                if record["model_settings"]["run_kind"] == "llm"
            ]
            self.assertEqual(
                next(
                    record
                    for record in llm_records
                    if record["score_inputs"].get("result_source") == "legacy_result"
                )["result"],
                "lose",
            )
            reasons_by_run_kind = {
                record["model_settings"]["run_kind"]: record["score_inputs"].get("final_reason")
                for record in run_records
                if record["score_inputs"].get("final_reason")
            }
            self.assertEqual(reasons_by_run_kind["human"], "abandoned")
            self.assertEqual(reasons_by_run_kind["llm"], "max_hops")

    def test_import_viewer_creates_empty_output_when_every_run_is_skipped(self):
        with tempfile.TemporaryDirectory() as td:
            td_path = Path(td)
            viewer_path = td_path / "viewer.json"
            viewer_path.write_text(
                json.dumps(
                    {
                        "runs": [
                            {
                                "id": "run_partial",
                                "model": "openai-responses:gpt-5.2",
                                "start_article": "Start",
                                "destination_article": "Target",
                                "result": "running",
                                "steps": [
                                    {"type": "start", "article": "Start"},
                                ],
                            }
                        ]
                    }
                ),
                "utf-8",
            )

            out_path = td_path / "nested" / "records.jsonl"
            with self.assertWarnsRegex(
                RuntimeWarning,
                "Skipped 1 viewer run\\(s\\) without a terminal win/lose step: run_partial",
            ):
                import_viewer_json(
                    viewer_json_path=viewer_path,
                    dataset_path=None,
                    dataset_id=None,
                    out_path=out_path,
                    overwrite=False,
                )

            self.assertTrue(out_path.exists())
            self.assertEqual(out_path.read_text("utf-8"), "")
            self.assertEqual(read_jsonl(out_path), [])

    def test_import_viewer_does_not_truncate_existing_output_on_invalid_json(self):
        with tempfile.TemporaryDirectory() as td:
            td_path = Path(td)
            viewer_path = td_path / "viewer.json"
            viewer_path.write_text("{not json", "utf-8")
            out_path = td_path / "records.jsonl"
            out_path.write_text("previous-record\n", "utf-8")

            with self.assertRaises(json.JSONDecodeError):
                import_viewer_json(
                    viewer_json_path=viewer_path,
                    dataset_path=None,
                    dataset_id=None,
                    out_path=out_path,
                    overwrite=True,
                )

            self.assertEqual(out_path.read_text("utf-8"), "previous-record\n")

    def test_import_viewer_rejects_aliased_input_and_output_paths(self):
        with tempfile.TemporaryDirectory() as td:
            td_path = Path(td)
            viewer_path = td_path / "viewer.json"
            viewer_path.write_text(
                json.dumps(
                    {
                        "runs": [
                            {
                                "model": "openai-responses:gpt-5.2",
                                "start_article": "Start",
                                "destination_article": "Target",
                                "result": "win",
                                "steps": [
                                    {"type": "start", "article": "Start"},
                                    {"type": "win", "article": "Target"},
                                ],
                            }
                        ]
                    }
                ),
                "utf-8",
            )

            with self.assertRaisesRegex(ValueError, "Input and output paths must be different"):
                import_viewer_json(
                    viewer_json_path=viewer_path,
                    dataset_path=None,
                    dataset_id=None,
                    out_path=viewer_path,
                    overwrite=True,
                )

            self.assertIn('"start_article": "Start"', viewer_path.read_text("utf-8"))


if __name__ == "__main__":
    unittest.main()
