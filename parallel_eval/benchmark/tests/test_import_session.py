from __future__ import annotations

import json
import sqlite3
import tempfile
import unittest
import warnings
from pathlib import Path

from parallel_eval.benchmark.import_session import import_session_json
from parallel_eval.benchmark.schema import read_jsonl


def _build_test_db(path: Path) -> None:
    conn = sqlite3.connect(path)
    cur = conn.cursor()
    cur.execute("CREATE TABLE core_articles (title TEXT PRIMARY KEY, links_json TEXT NOT NULL)")
    rows = {
        "Start": ["Target", "Other"],
        "Target": [],
        "Other": [],
    }
    for title, links in rows.items():
        cur.execute("INSERT INTO core_articles (title, links_json) VALUES (?, ?)", (title, json.dumps(links)))
    conn.commit()
    conn.close()


class ImportSessionTests(unittest.TestCase):
    def test_import_session_preserves_explicit_unlimited_budgets(self):
        with tempfile.TemporaryDirectory() as td:
            td_path = Path(td)
            db_path = td_path / "test.db"
            _build_test_db(db_path)

            session_path = td_path / "session.json"
            session_path.write_text(
                json.dumps(
                    {
                        "schema_version": 1,
                        "session": {
                            "id": "session_1",
                            "start_article": "Start",
                            "destination_article": "Target",
                            "rules": {
                                "max_hops": 20,
                                "max_links": 200,
                                "max_tokens": 16000,
                            },
                            "runs": [
                                {
                                    "id": "run_llm",
                                    "kind": "llm",
                                    "model": "openai-responses:gpt-5.2",
                                    "result": "win",
                                    "hops": 1,
                                    "max_links": None,
                                    "max_tokens": None,
                                    "steps": [
                                        {"type": "start", "article": "Start", "at": "2026-03-08T12:00:10Z"},
                                        {"type": "win", "article": "Target", "at": "2026-03-08T12:00:13Z"},
                                    ],
                                }
                            ],
                        },
                    }
                ),
                "utf-8",
            )

            out_path = td_path / "records.jsonl"
            with warnings.catch_warnings(record=True):
                warnings.simplefilter("always")
                import_session_json(
                    session_json_path=session_path,
                    dataset_path=None,
                    dataset_id=None,
                    db_path=db_path,
                    out_path=out_path,
                    overwrite=False,
                )

            lines = read_jsonl(out_path)
            run = next(line.data for line in lines if line.data.get("type") == "run")
            self.assertIsNone(run["budgets"]["max_links"])
            self.assertIsNone(run["budgets"]["max_tokens"])

    def test_import_session_reads_input_output_token_aliases(self):
        with tempfile.TemporaryDirectory() as td:
            td_path = Path(td)
            db_path = td_path / "test.db"
            _build_test_db(db_path)

            session_path = td_path / "session.json"
            session_path.write_text(
                json.dumps(
                    {
                        "schema_version": 1,
                        "session": {
                            "id": "session_1",
                            "start_article": "Start",
                            "destination_article": "Target",
                            "runs": [
                                {
                                    "id": "run_llm",
                                    "kind": "llm",
                                    "model": "openai-responses:gpt-5.2",
                                    "result": "win",
                                    "steps": [
                                        {"type": "start", "article": "Start", "at": "2026-03-08T12:00:10Z"},
                                        {
                                            "type": "win",
                                            "article": "Target",
                                            "at": "2026-03-08T12:00:13Z",
                                            "metadata": {
                                                "selected_index": 1,
                                                "input_tokens": 120,
                                                "output_tokens": 30,
                                            },
                                        },
                                    ],
                                }
                            ],
                        },
                    }
                ),
                "utf-8",
            )

            out_path = td_path / "records.jsonl"
            with warnings.catch_warnings(record=True):
                warnings.simplefilter("always")
                import_session_json(
                    session_json_path=session_path,
                    dataset_path=None,
                    dataset_id=None,
                    db_path=db_path,
                    out_path=out_path,
                    overwrite=False,
                )

            lines = read_jsonl(out_path)
            run = next(line.data for line in lines if line.data.get("type") == "run")
            step = next(line.data for line in lines if line.data.get("type") == "step")
            self.assertEqual(run["totals"]["prompt_tokens"], 120)
            self.assertEqual(run["totals"]["completion_tokens"], 30)
            self.assertEqual(run["totals"]["total_tokens"], 150)
            self.assertEqual(step["usage"]["prompt_tokens"], 120)
            self.assertEqual(step["usage"]["completion_tokens"], 30)
            self.assertEqual(step["usage"]["total_tokens"], 150)

    def test_import_session_preserves_human_and_llm_runs(self):
        with tempfile.TemporaryDirectory() as td:
            td_path = Path(td)
            db_path = td_path / "test.db"
            _build_test_db(db_path)

            dataset_path = td_path / "dataset.jsonl"
            dataset_path.write_text(
                json.dumps(
                    {
                        "id": "m1",
                        "tier": "core_rank_v1",
                        "start": "Start",
                        "target": "Target",
                        "suite_id": "classic_local_v1",
                        "slice_id": "core_rank_v1",
                        "setup_id": "classic_local_v1",
                        "prompt_version": "choose_link_v1",
                        "semantics_version": "local_parity_v1",
                        "shortest_path_hops": 1,
                        "path_bucket": "short",
                    }
                )
                + "\n",
                "utf-8",
            )

            session_path = td_path / "session.json"
            session_path.write_text(
                json.dumps(
                    {
                        "schema_version": 1,
                        "exported_at": "2026-03-08T12:00:00Z",
                        "session": {
                            "id": "session_1",
                            "title": "Start to Target",
                            "start_article": "Start",
                            "destination_article": "Target",
                            "created_at": "2026-03-08T11:59:00Z",
                            "rules": {
                                "max_hops": 20,
                                "max_links": None,
                                "max_tokens": None,
                                "include_image_links": False,
                                "disable_links_view": False,
                            },
                            "runs": [
                                {
                                    "id": "run_human",
                                    "kind": "human",
                                    "player_name": "Andrew",
                                    "started_at": "2026-03-08T12:00:01Z",
                                    "finished_at": "2026-03-08T12:00:06Z",
                                    "status": "finished",
                                    "result": "win",
                                    "hops": 1,
                                    "duration_ms": 4321,
                                    "steps": [
                                        {"type": "start", "article": "Start", "at": "2026-03-08T12:00:01Z"},
                                        {"type": "win", "article": "Target", "at": "2026-03-08T12:00:06Z"},
                                    ],
                                },
                                {
                                    "id": "run_llm",
                                    "kind": "llm",
                                    "model": "openai-responses:gpt-5.2",
                                    "openai_reasoning_effort": "high",
                                    "started_at": "2026-03-08T12:00:10Z",
                                    "finished_at": "2026-03-08T12:00:13Z",
                                    "status": "finished",
                                    "result": "lose",
                                    "hops": 1,
                                    "duration_ms": 3000,
                                    "steps": [
                                        {"type": "start", "article": "Start", "at": "2026-03-08T12:00:10Z"},
                                        {
                                            "type": "lose",
                                            "article": "Start",
                                            "at": "2026-03-08T12:00:13Z",
                                            "metadata": {
                                                "reason": "bad_answer",
                                                "tries": 2,
                                                "selected_index": 1,
                                                "llm_output": "<answer>1</answer>",
                                                "prompt_tokens": 120,
                                                "completion_tokens": 30,
                                                "total_tokens": 150,
                                                "latency_ms": 2222,
                                            },
                                        },
                                    ],
                                },
                            ],
                        },
                    }
                ),
                "utf-8",
            )

            out_path = td_path / "records.jsonl"
            import_session_json(
                session_json_path=session_path,
                dataset_path=dataset_path,
                dataset_id=None,
                db_path=db_path,
                out_path=out_path,
                overwrite=False,
            )

            lines = read_jsonl(out_path)
            run_records = [line.data for line in lines if line.data.get("type") == "run"]
            step_records = [line.data for line in lines if line.data.get("type") == "step"]
            self.assertEqual(len(run_records), 2)
            self.assertEqual(len(step_records), 2)

            human_run = next(record for record in run_records if record["model_settings"]["run_kind"] == "human")
            self.assertEqual(human_run["model_settings"]["player_name"], "Andrew")
            self.assertEqual(human_run["duration_ms"], 4321)
            self.assertEqual(human_run["dataset_id"], "matchups/classic_local_v1/core_rank_v1")
            self.assertEqual(human_run["score_inputs"]["shortest_path_hops"], 1)
            self.assertTrue(human_run["provenance"]["db_sha256"])

            llm_run = next(record for record in run_records if record["model_settings"]["run_kind"] == "llm")
            self.assertEqual(llm_run["model_settings"]["model"], "openai-responses:gpt-5.2")
            self.assertEqual(llm_run["llm_latency_ms"], 2222)
            self.assertEqual(llm_run["totals"]["total_tokens"], 150)
            self.assertEqual(llm_run["score_inputs"]["final_reason"], "bad_answer")

            llm_step = next(record for record in step_records if record["run_id"] == llm_run["run_id"])
            self.assertEqual(llm_step["attempt_count"], 2)
            self.assertEqual(llm_step["choice"]["tries"], 1)
            self.assertEqual(llm_step["meta"]["reason"], "bad_answer")
            self.assertEqual(llm_step["target_canonical"], "Target")

    def test_import_session_falls_back_to_legacy_result_and_preserves_abandoned_reason(self):
        with tempfile.TemporaryDirectory() as td:
            td_path = Path(td)
            db_path = td_path / "test.db"
            _build_test_db(db_path)

            session_path = td_path / "session.json"
            session_path.write_text(
                json.dumps(
                    {
                        "schema_version": 1,
                        "session": {
                            "id": "session_partial",
                            "start_article": "Start",
                            "destination_article": "Target",
                            "runs": [
                                {
                                    "id": "run_legacy_lose",
                                    "kind": "llm",
                                    "model": "openai-responses:gpt-5.2",
                                    "status": "finished",
                                    "result": "lose",
                                    "steps": [
                                        {
                                            "type": "start",
                                            "article": "Start",
                                            "at": "2026-03-08T12:00:10Z",
                                        }
                                    ],
                                },
                                {
                                    "id": "run_running",
                                    "kind": "llm",
                                    "model": "openai-responses:gpt-5.2",
                                    "status": "running",
                                    "result": "unknown",
                                    "steps": [
                                        {
                                            "type": "start",
                                            "article": "Start",
                                            "at": "2026-03-08T12:00:10Z",
                                        }
                                    ],
                                },
                                {
                                    "id": "run_abandoned",
                                    "kind": "human",
                                    "player_name": "Andrew",
                                    "status": "finished",
                                    "result": "abandoned",
                                    "steps": [
                                        {
                                            "type": "start",
                                            "article": "Start",
                                            "at": "2026-03-08T12:00:10Z",
                                        },
                                        {
                                            "type": "lose",
                                            "article": "Start",
                                            "at": "2026-03-08T12:00:11Z",
                                        },
                                    ],
                                },
                            ],
                        },
                    }
                ),
                "utf-8",
            )

            out_path = td_path / "records.jsonl"
            with warnings.catch_warnings(record=True) as caught:
                warnings.simplefilter("always")
                import_session_json(
                    session_json_path=session_path,
                    dataset_path=None,
                    dataset_id=None,
                    db_path=db_path,
                    out_path=out_path,
                    overwrite=False,
                )

            lines = read_jsonl(out_path)
            run_records = [line.data for line in lines if line.data.get("type") == "run"]
            step_records = [line.data for line in lines if line.data.get("type") == "step"]

            self.assertEqual(len(run_records), 2)
            self.assertEqual(len(step_records), 1)
            records_by_model = {
                record["model_settings"]["run_kind"]: record for record in run_records
            }
            self.assertEqual(records_by_model["llm"]["result"], "lose")
            self.assertEqual(
                records_by_model["llm"]["score_inputs"]["result_source"],
                "legacy_result",
            )
            self.assertEqual(records_by_model["human"]["result"], "lose")
            self.assertEqual(
                records_by_model["human"]["score_inputs"]["final_reason"],
                "abandoned",
            )
            self.assertTrue(
                any(
                    "run_running" in str(warning.message)
                    and "without a terminal win/lose step" in str(warning.message)
                    for warning in caught
                ),
                [str(warning.message) for warning in caught],
            )

    def test_import_session_normalizes_successful_retry_counts(self):
        with tempfile.TemporaryDirectory() as td:
            td_path = Path(td)
            db_path = td_path / "test.db"
            _build_test_db(db_path)

            session_path = td_path / "session.json"
            session_path.write_text(
                json.dumps(
                    {
                        "schema_version": 1,
                        "session": {
                            "id": "session_2",
                            "start_article": "Start",
                            "destination_article": "Target",
                            "runs": [
                                {
                                    "id": "run_llm",
                                    "kind": "llm",
                                    "model": "openai-responses:gpt-5.2",
                                    "result": "win",
                                    "hops": 1,
                                    "steps": [
                                        {"type": "start", "article": "Start", "at": "2026-03-08T12:00:10Z"},
                                        {
                                            "type": "win",
                                            "article": "Target",
                                            "at": "2026-03-08T12:00:13Z",
                                            "metadata": {
                                                "selected_index": 1,
                                                "selected_title": "Target",
                                                "tries": 1,
                                                "llm_output": "<answer>1</answer>",
                                                "llm_outputs": ["bad", "good"],
                                                "answer_errors": ["bad_json"],
                                                "latency_ms": 1000,
                                            },
                                        },
                                    ],
                                }
                            ],
                        },
                    }
                ),
                "utf-8",
            )

            out_path = td_path / "records.jsonl"
            import_session_json(
                session_json_path=session_path,
                dataset_path=None,
                dataset_id=None,
                db_path=db_path,
                out_path=out_path,
                overwrite=False,
            )

            lines = read_jsonl(out_path)
            llm_step = next(line.data for line in lines if line.data.get("type") == "step")
            self.assertEqual(llm_step["attempt_count"], 2)
            self.assertEqual(llm_step["choice"]["tries"], 1)
            self.assertEqual(llm_step["choice"]["answer_errors"], ["bad_json"])

    def test_import_session_counts_only_article_transitions_as_hops(self):
        with tempfile.TemporaryDirectory() as td:
            td_path = Path(td)
            db_path = td_path / "test.db"
            _build_test_db(db_path)

            session_path = td_path / "session.json"
            session_path.write_text(
                json.dumps(
                    {
                        "schema_version": 1,
                        "session": {
                            "id": "session_noop",
                            "start_article": "Start",
                            "destination_article": "Target",
                            "runs": [
                                {
                                    "id": "run_llm",
                                    "kind": "llm",
                                    "model": "openai-responses:gpt-5.2",
                                    "result": "lose",
                                    "hops": 1,
                                    "steps": [
                                        {"type": "start", "article": "Start", "at": "2026-03-08T12:00:10Z"},
                                        {
                                            "type": "lose",
                                            "article": "Start",
                                            "at": "2026-03-08T12:00:11Z",
                                            "metadata": {"reason": "bad_answer"},
                                        },
                                    ],
                                }
                            ],
                        },
                    }
                ),
                "utf-8",
            )

            out_path = td_path / "records.jsonl"
            import_session_json(
                session_json_path=session_path,
                dataset_path=None,
                dataset_id=None,
                db_path=db_path,
                out_path=out_path,
                overwrite=False,
            )

            lines = read_jsonl(out_path)
            run = next(line.data for line in lines if line.data.get("type") == "run")
            step = next(line.data for line in lines if line.data.get("type") == "step")
            self.assertEqual(run["hops"], 0)
            self.assertEqual(run["score_inputs"]["legacy_reported_hops"], 1)
            self.assertTrue(run["score_inputs"]["legacy_hops_mismatch"])
            self.assertEqual(step["hop"], 0)
            self.assertEqual(step["current_article"], "Start")
            self.assertEqual(step["article"], "Start")

    def test_import_session_strips_fragment_only_noop_transitions(self):
        with tempfile.TemporaryDirectory() as td:
            td_path = Path(td)
            session_path = td_path / "session.json"
            session_path.write_text(
                json.dumps(
                    {
                        "schema_version": 1,
                        "session": {
                            "id": "session_fragment_noop",
                            "start_article": "Start",
                            "destination_article": "Target",
                            "runs": [
                                {
                                    "id": "run_llm_fragment",
                                    "kind": "llm",
                                    "model": "openai-responses:gpt-5.2",
                                    "result": "lose",
                                    "steps": [
                                        {"type": "start", "article": "Start", "at": "2026-03-08T12:00:10Z"},
                                        {
                                            "type": "move",
                                            "article": "Start#History",
                                            "at": "2026-03-08T12:00:11Z",
                                        },
                                        {
                                            "type": "lose",
                                            "article": "Start#References",
                                            "at": "2026-03-08T12:00:12Z",
                                            "metadata": {"reason": "bad_answer"},
                                        },
                                    ],
                                }
                            ],
                        },
                    }
                ),
                "utf-8",
            )

            out_path = td_path / "records.jsonl"
            import_session_json(
                session_json_path=session_path,
                dataset_path=None,
                dataset_id=None,
                db_path=None,
                out_path=out_path,
                overwrite=False,
            )

            lines = read_jsonl(out_path)
            run = next(line.data for line in lines if line.data.get("type") == "run")
            steps = [line.data for line in lines if line.data.get("type") == "step"]
            self.assertEqual(run["hops"], 0)
            self.assertEqual([step["hop"] for step in steps], [0, 0])
            self.assertEqual([step["article"] for step in steps], ["Start", "Start"])

    def test_import_session_uses_duration_ms_step_latency_alias(self):
        with tempfile.TemporaryDirectory() as td:
            td_path = Path(td)
            session_path = td_path / "session.json"
            session_path.write_text(
                json.dumps(
                    {
                        "schema_version": 1,
                        "session": {
                            "id": "session_duration_alias",
                            "start_article": "Start",
                            "destination_article": "Target",
                            "runs": [
                                {
                                    "id": "run_llm_duration_alias",
                                    "kind": "llm",
                                    "model": "openai-responses:gpt-5.2",
                                    "result": "win",
                                    "steps": [
                                        {"type": "start", "article": "Start", "at": "2026-03-08T12:00:10Z"},
                                        {
                                            "type": "win",
                                            "article": "Target",
                                            "at": "2026-03-08T12:00:11Z",
                                            "metadata": {"duration_ms": 1234},
                                        },
                                    ],
                                }
                            ],
                        },
                    }
                ),
                "utf-8",
            )

            out_path = td_path / "records.jsonl"
            import_session_json(
                session_json_path=session_path,
                dataset_path=None,
                dataset_id=None,
                db_path=None,
                out_path=out_path,
                overwrite=False,
            )

            lines = read_jsonl(out_path)
            run = next(line.data for line in lines if line.data.get("type") == "run")
            step = next(line.data for line in lines if line.data.get("type") == "step")
            self.assertEqual(run["llm_latency_ms"], 1234)
            self.assertEqual(step["latency_ms"], 1234)

    def test_import_session_treats_fragment_only_steps_as_noops(self):
        with tempfile.TemporaryDirectory() as td:
            td_path = Path(td)
            db_path = td_path / "test.db"
            _build_test_db(db_path)

            session_path = td_path / "session.json"
            session_path.write_text(
                json.dumps(
                    {
                        "schema_version": 1,
                        "session": {
                            "id": "session_fragment",
                            "start_article": "Start",
                            "destination_article": "Target",
                            "runs": [
                                {
                                    "id": "run_fragment",
                                    "kind": "llm",
                                    "model": "openai-responses:gpt-5.2",
                                    "result": "lose",
                                    "steps": [
                                        {
                                            "type": "start",
                                            "article": "Start",
                                            "at": "2026-03-08T12:00:10Z",
                                        },
                                        {
                                            "type": "move",
                                            "article": "Start#Section",
                                            "at": "2026-03-08T12:00:11Z",
                                        },
                                        {
                                            "type": "lose",
                                            "article": "Start",
                                            "at": "2026-03-08T12:00:12Z",
                                            "metadata": {"reason": "bad_answer"},
                                        },
                                    ],
                                }
                            ],
                        },
                    }
                ),
                "utf-8",
            )

            out_path = td_path / "records.jsonl"
            import_session_json(
                session_json_path=session_path,
                dataset_path=None,
                dataset_id=None,
                db_path=db_path,
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

    def test_import_session_treats_anchor_only_steps_as_noops(self):
        with tempfile.TemporaryDirectory() as td:
            td_path = Path(td)
            db_path = td_path / "test.db"
            _build_test_db(db_path)

            session_path = td_path / "session.json"
            session_path.write_text(
                json.dumps(
                    {
                        "schema_version": 1,
                        "session": {
                            "id": "session_anchor_only",
                            "start_article": "Start",
                            "destination_article": "Target",
                            "runs": [
                                {
                                    "id": "run_anchor_only",
                                    "kind": "llm",
                                    "model": "openai-responses:gpt-5.2",
                                    "result": "lose",
                                    "steps": [
                                        {
                                            "type": "start",
                                            "article": "Start",
                                            "at": "2026-03-08T12:00:10Z",
                                        },
                                        {
                                            "type": "move",
                                            "article": "#Section",
                                            "at": "2026-03-08T12:00:11Z",
                                        },
                                        {
                                            "type": "lose",
                                            "article": "#References",
                                            "at": "2026-03-08T12:00:12Z",
                                            "metadata": {"reason": "bad_answer"},
                                        },
                                    ],
                                }
                            ],
                        },
                    }
                ),
                "utf-8",
            )

            out_path = td_path / "records.jsonl"
            import_session_json(
                session_json_path=session_path,
                dataset_path=None,
                dataset_id=None,
                db_path=db_path,
                out_path=out_path,
                overwrite=False,
            )

            lines = read_jsonl(out_path)
            run = next(line.data for line in lines if line.data.get("type") == "run")
            steps = [line.data for line in lines if line.data.get("type") == "step"]

            self.assertEqual(run["hops"], 0)
            self.assertEqual([step["hop"] for step in steps], [0, 0])
            self.assertEqual([step["article"] for step in steps], ["Start", "Start"])

    def test_import_session_uses_last_hop_row_to_detect_terminal_result(self):
        with tempfile.TemporaryDirectory() as td:
            td_path = Path(td)
            db_path = td_path / "test.db"
            _build_test_db(db_path)

            session_path = td_path / "session.json"
            session_path.write_text(
                json.dumps(
                    {
                        "schema_version": 1,
                        "session": {
                            "id": "session_trailing_note",
                            "start_article": "Start",
                            "destination_article": "Target",
                            "runs": [
                                {
                                    "id": "run_trailing_note",
                                    "kind": "llm",
                                    "model": "openai-responses:gpt-5.2",
                                    "steps": [
                                        {
                                            "type": "start",
                                            "article": "Start",
                                            "at": "2026-03-08T12:00:10Z",
                                        },
                                        {
                                            "type": "win",
                                            "article": "Target",
                                            "at": "2026-03-08T12:00:11Z",
                                            "metadata": {"reason": "win"},
                                        },
                                        {
                                            "type": "note",
                                            "article": "Target",
                                            "at": "2026-03-08T12:00:12Z",
                                            "metadata": {"reason": "debug_note"},
                                        },
                                    ],
                                }
                            ],
                        },
                    }
                ),
                "utf-8",
            )

            out_path = td_path / "records.jsonl"
            import_session_json(
                session_json_path=session_path,
                dataset_path=None,
                dataset_id=None,
                db_path=db_path,
                out_path=out_path,
                overwrite=False,
            )

            lines = read_jsonl(out_path)
            run = next(line.data for line in lines if line.data.get("type") == "run")
            step_records = [line.data for line in lines if line.data.get("type") == "step"]

            self.assertEqual(run["result"], "win")
            self.assertEqual(run["hops"], 1)
            self.assertEqual(run["score_inputs"]["final_reason"], "win")
            self.assertEqual(len(step_records), 1)
            self.assertEqual(step_records[0]["step_type"], "win")

    def test_import_session_ignores_unknown_step_articles_for_hop_state(self):
        with tempfile.TemporaryDirectory() as td:
            td_path = Path(td)
            db_path = td_path / "test.db"
            _build_test_db(db_path)

            session_path = td_path / "session.json"
            session_path.write_text(
                json.dumps(
                    {
                        "schema_version": 1,
                        "session": {
                            "id": "session_note_teleport",
                            "start_article": "Start",
                            "destination_article": "Target",
                            "runs": [
                                {
                                    "id": "run_note_teleport",
                                    "kind": "llm",
                                    "model": "openai-responses:gpt-5.2",
                                    "steps": [
                                        {"type": "start", "article": "Start"},
                                        {"type": "note", "article": "Other"},
                                        {"type": "win", "article": "Target"},
                                    ],
                                }
                            ],
                        },
                    }
                ),
                "utf-8",
            )

            out_path = td_path / "records.jsonl"
            import_session_json(
                session_json_path=session_path,
                dataset_path=None,
                dataset_id=None,
                db_path=db_path,
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

    def test_import_session_creates_empty_output_when_every_run_is_skipped(self):
        with tempfile.TemporaryDirectory() as td:
            td_path = Path(td)

            session_path = td_path / "session.json"
            session_path.write_text(
                json.dumps(
                    {
                        "schema_version": 1,
                        "session": {
                            "id": "session_running",
                            "start_article": "Start",
                            "destination_article": "Target",
                            "runs": [
                                {
                                    "id": "run_running",
                                    "kind": "llm",
                                    "model": "openai-responses:gpt-5.2",
                                    "status": "running",
                                    "steps": [
                                        {
                                            "type": "start",
                                            "article": "Start",
                                            "at": "2026-03-08T12:00:10Z",
                                        }
                                    ],
                                }
                            ],
                        },
                    }
                ),
                "utf-8",
            )

            out_path = td_path / "nested" / "records.jsonl"
            with self.assertWarnsRegex(
                RuntimeWarning,
                "Skipped 1 session run\\(s\\) without a terminal win/lose step: run_running",
            ):
                import_session_json(
                    session_json_path=session_path,
                    dataset_path=None,
                    dataset_id=None,
                    db_path=None,
                    out_path=out_path,
                    overwrite=False,
                )

            self.assertTrue(out_path.exists())
            self.assertEqual(out_path.read_text("utf-8"), "")
            self.assertEqual(read_jsonl(out_path), [])

    def test_import_session_does_not_truncate_existing_output_on_invalid_json(self):
        with tempfile.TemporaryDirectory() as td:
            td_path = Path(td)
            session_path = td_path / "session.json"
            session_path.write_text("{not json", "utf-8")
            out_path = td_path / "records.jsonl"
            out_path.write_text("previous-record\n", "utf-8")

            with self.assertRaises(json.JSONDecodeError):
                import_session_json(
                    session_json_path=session_path,
                    dataset_path=None,
                    dataset_id=None,
                    db_path=None,
                    out_path=out_path,
                    overwrite=True,
                )

            self.assertEqual(out_path.read_text("utf-8"), "previous-record\n")

    def test_import_session_rejects_aliased_input_and_output_paths(self):
        with tempfile.TemporaryDirectory() as td:
            td_path = Path(td)
            session_path = td_path / "session.json"
            session_path.write_text(
                json.dumps(
                    {
                        "schema_version": 1,
                        "session": {
                            "id": "session_alias",
                            "start_article": "Start",
                            "destination_article": "Target",
                            "runs": [
                                {
                                    "id": "run_alias",
                                    "kind": "human",
                                    "status": "finished",
                                    "result": "win",
                                    "steps": [
                                        {"type": "start", "article": "Start"},
                                        {"type": "win", "article": "Target"},
                                    ],
                                }
                            ],
                        },
                    }
                ),
                "utf-8",
            )

            with self.assertRaisesRegex(ValueError, "Input and output paths must be different"):
                import_session_json(
                    session_json_path=session_path,
                    dataset_path=None,
                    dataset_id=None,
                    db_path=None,
                    out_path=session_path,
                    overwrite=True,
                )

            self.assertIn('"session_alias"', session_path.read_text("utf-8"))


if __name__ == "__main__":
    unittest.main()
