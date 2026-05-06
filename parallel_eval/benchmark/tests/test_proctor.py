from __future__ import annotations

import asyncio
import json
import sqlite3
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

from parallel_eval.game import AgentPlayer, Game, SQLiteDB
from parallel_eval.proctor import Proctor, Run


def _build_test_db(path: Path) -> None:
    conn = sqlite3.connect(path)
    cur = conn.cursor()
    cur.execute("CREATE TABLE core_articles (title TEXT PRIMARY KEY, links_json TEXT NOT NULL)")
    cur.execute("INSERT INTO core_articles (title, links_json) VALUES (?, ?)", ("A", "[]"))
    cur.execute("INSERT INTO core_articles (title, links_json) VALUES (?, ?)", ("B", "[]"))
    conn.commit()
    conn.close()


def _build_chain_test_db(path: Path) -> None:
    conn = sqlite3.connect(path)
    cur = conn.cursor()
    cur.execute("CREATE TABLE core_articles (title TEXT PRIMARY KEY, links_json TEXT NOT NULL)")
    cur.execute(
        "INSERT INTO core_articles (title, links_json) VALUES (?, ?)",
        ("A", json.dumps(["B"])),
    )
    cur.execute(
        "INSERT INTO core_articles (title, links_json) VALUES (?, ?)",
        ("B", json.dumps(["C"])),
    )
    cur.execute("INSERT INTO core_articles (title, links_json) VALUES (?, ?)", ("C", "[]"))
    conn.commit()
    conn.close()


class ProctorTests(unittest.TestCase):
    def test_agent_player_passes_reasoning_settings_to_achat(self):
        calls: list[dict[str, object]] = []

        async def fake_achat(**kwargs):
            calls.append(kwargs)
            return SimpleNamespace(content="<answer>1</answer>", usage=None)

        player = AgentPlayer(
            model="openai-responses:gpt-5.2",
            api_base=None,
            max_links=None,
            max_tries=1,
            target_article="B",
            openai_api_mode="responses",
            openai_reasoning_effort="medium",
            openai_reasoning_summary="auto",
            anthropic_thinking_budget_tokens=1024,
            google_thinking_config={"thinkingBudget": 64},
        )

        with patch("parallel_eval.game.achat", side_effect=fake_achat):
            move, _ = asyncio.run(
                player.get_move(
                    [
                        {
                            "type": "start",
                            "article": "A",
                            "links": ["B"],
                        }
                    ]
                )
            )

        self.assertEqual(move, "B")
        self.assertEqual(calls[0]["openai_reasoning_summary"], "auto")
        self.assertEqual(calls[0]["anthropic_thinking_budget_tokens"], 1024)
        self.assertEqual(calls[0]["google_thinking_config"], {"thinkingBudget": 64})

    def test_game_marks_last_allowed_non_target_move_as_terminal_loss(self):
        class FixedMovePlayer:
            async def get_move(self, game_state):
                return "B", {"selected_index": 1}

        with tempfile.TemporaryDirectory() as td:
            db_path = Path(td) / "wikihop.db"
            _build_chain_test_db(db_path)
            db = SQLiteDB(str(db_path))

            steps = asyncio.run(
                Game(
                    "A",
                    "C",
                    db,
                    max_allowed_steps=1,
                    player=FixedMovePlayer(),
                    verbose=False,
                ).run()
            )

        self.assertEqual(steps[-1]["type"], "lose")
        self.assertEqual(steps[-1]["article"], "B")
        self.assertEqual(steps[-1]["metadata"]["reason"], "max_steps")
        self.assertEqual(steps[-1]["metadata"]["max_steps"], 1)
        self.assertNotEqual(steps[-1]["type"], "move")

    def test_analyze_runs_handles_all_loss_outputs(self):
        with tempfile.TemporaryDirectory() as td:
            td_path = Path(td)
            db_path = td_path / "wikihop.db"
            _build_test_db(db_path)

            proctor = Proctor(
                article_list=["A", "B"],
                num_trials=1,
                num_workers=1,
                max_steps=5,
                agent_settings={"model": "openai-responses:gpt-5.2", "api_base": None, "max_links": None, "max_tries": 3},
                db_path=str(db_path),
                verbose=False,
                output_dir=str(td_path),
                proctor_id="proctor_test",
            )

            for run in proctor.runs:
                Path(run.output_file).write_text(
                    json.dumps(
                        {
                            "model": "openai-responses:gpt-5.2",
                            "api_base": None,
                            "max_links": None,
                            "max_tries": 3,
                            "start_article": run.start_article,
                            "destination_article": run.destination_article,
                            "steps": [
                                {"type": "start", "article": run.start_article},
                                {"type": "lose", "article": run.start_article},
                            ],
                            "result": "lose",
                        }
                    ),
                    "utf-8",
                )

            proctor.analyze_runs()

            final_results = json.loads((td_path / "proctor_test-final-results.json").read_text("utf-8"))
            self.assertEqual(final_results["hops_distribution"], [])
            self.assertIsNone(final_results["average_hops"])
            self.assertEqual(final_results["win_rate"], 0.0)
            self.assertEqual(final_results["lose_rate"], 1.0)

    def test_analyze_runs_handles_empty_suite(self):
        with tempfile.TemporaryDirectory() as td:
            td_path = Path(td)
            db_path = td_path / "wikihop.db"
            _build_test_db(db_path)

            proctor = Proctor(
                article_list=["A"],
                num_trials=1,
                num_workers=1,
                max_steps=5,
                agent_settings={"model": "openai-responses:gpt-5.2", "api_base": None, "max_links": None, "max_tries": 3},
                db_path=str(db_path),
                verbose=False,
                output_dir=str(td_path),
                proctor_id="proctor_empty",
            )

            self.assertEqual(proctor.runs, [])

            proctor.analyze_runs()

            final_results = json.loads((td_path / "proctor_empty-final-results.json").read_text("utf-8"))
            self.assertEqual(final_results["hops_distribution"], [])
            self.assertIsNone(final_results["average_hops"])
            self.assertEqual(final_results["win_rate"], 0.0)
            self.assertEqual(final_results["lose_rate"], 0.0)

    def test_analyze_runs_uses_transition_hops_for_noop_fragments(self):
        with tempfile.TemporaryDirectory() as td:
            td_path = Path(td)
            db_path = td_path / "wikihop.db"
            _build_test_db(db_path)

            proctor = Proctor(
                article_list=["A", "B"],
                num_trials=1,
                num_workers=1,
                max_steps=5,
                agent_settings={
                    "model": "openai-responses:gpt-5.2",
                    "api_base": None,
                    "max_links": None,
                    "max_tries": 3,
                },
                db_path=str(db_path),
                verbose=False,
                output_dir=str(td_path),
                proctor_id="proctor_hops",
            )

            for run in proctor.runs:
                Path(run.output_file).write_text(
                    json.dumps(
                        {
                            "model": "openai-responses:gpt-5.2",
                            "api_base": None,
                            "max_links": None,
                            "max_tries": 3,
                            "start_article": run.start_article,
                            "destination_article": run.destination_article,
                            "steps": [
                                {"type": "start", "article": run.start_article},
                                {"type": "move", "article": f"{run.start_article}#Section"},
                                {"type": "move", "article": run.start_article},
                                {"type": "win", "article": run.destination_article},
                            ],
                            "result": "win",
                        }
                    ),
                    "utf-8",
                )

            proctor.analyze_runs()

            final_results = json.loads((td_path / "proctor_hops-final-results.json").read_text("utf-8"))
            self.assertEqual(final_results["hops_distribution"], [1, 1])
            self.assertEqual(final_results["average_hops"], 1.0)
            self.assertEqual(final_results["win_rate"], 1.0)
            self.assertEqual(final_results["lose_rate"], 0.0)

    def test_run_uses_bounded_worker_tasks_instead_of_one_task_per_run(self):
        with tempfile.TemporaryDirectory() as td:
            td_path = Path(td)
            db_path = td_path / "wikihop.db"
            _build_test_db(db_path)

            proctor = Proctor(
                article_list=["A", "B"],
                num_trials=3,
                num_workers=2,
                max_steps=5,
                agent_settings={
                    "model": "openai-responses:gpt-5.2",
                    "api_base": None,
                    "max_links": None,
                    "max_tries": 3,
                },
                db_path=str(db_path),
                verbose=False,
                output_dir=str(td_path),
                proctor_id="proctor_workers",
            )

            async def fake_run(run_instance: Run):
                await asyncio.sleep(0)
                Path(run_instance.output_file).write_text(
                    json.dumps(
                        {
                            "model": "openai-responses:gpt-5.2",
                            "api_base": None,
                            "max_links": None,
                            "max_tries": 3,
                            "start_article": run_instance.start_article,
                            "destination_article": run_instance.destination_article,
                            "steps": [
                                {"type": "start", "article": run_instance.start_article},
                                {"type": "lose", "article": run_instance.start_article},
                            ],
                            "result": "lose",
                        }
                    ),
                    "utf-8",
                )

            created_tasks = []
            original_create_task = asyncio.create_task

            def tracking_create_task(coro):
                task = original_create_task(coro)
                created_tasks.append(task)
                return task

            with (
                patch.object(Run, "run", fake_run),
                patch("parallel_eval.proctor.asyncio.create_task", side_effect=tracking_create_task),
            ):
                asyncio.run(proctor.run())

            self.assertEqual(len(created_tasks), 2)
            self.assertTrue((td_path / "proctor_workers-final-results.json").exists())

    def test_run_skips_existing_valid_output_file(self):
        with tempfile.TemporaryDirectory() as td:
            td_path = Path(td)
            db_path = td_path / "wikihop.db"
            _build_test_db(db_path)

            proctor = Proctor(
                article_list=["A", "B"],
                num_trials=1,
                num_workers=1,
                max_steps=5,
                agent_settings={
                    "model": "openai-responses:gpt-5.2",
                    "api_base": None,
                    "max_links": None,
                    "max_tries": 3,
                },
                db_path=str(db_path),
                verbose=False,
                output_dir=str(td_path),
                proctor_id="proctor_resume",
            )
            run = proctor.runs[0]
            Path(run.output_file).write_text(
                json.dumps(
                    {
                        "model": "openai-responses:gpt-5.2",
                        "api_base": None,
                        "max_links": None,
                        "max_tries": 3,
                        "max_steps": run.max_steps,
                        "run_config": run.run_config,
                        "run_config_hash": run.run_config_hash,
                        "start_article": run.start_article,
                        "destination_article": run.destination_article,
                        "steps": [
                            {"type": "start", "article": run.start_article},
                            {"type": "lose", "article": run.start_article},
                        ],
                        "result": "lose",
                    }
                ),
                "utf-8",
            )

            with patch("parallel_eval.proctor.Game") as game_mock:
                asyncio.run(run.run())

            game_mock.assert_not_called()

    def test_run_regenerates_legacy_output_without_config_hash(self):
        with tempfile.TemporaryDirectory() as td:
            td_path = Path(td)
            db_path = td_path / "wikihop.db"
            _build_test_db(db_path)

            proctor = Proctor(
                article_list=["A", "B"],
                num_trials=1,
                num_workers=1,
                max_steps=5,
                agent_settings={
                    "model": "openai-responses:gpt-5.2",
                    "api_base": None,
                    "max_links": None,
                    "max_tries": 3,
                },
                db_path=str(db_path),
                verbose=False,
                output_dir=str(td_path),
                proctor_id="proctor_resume_legacy",
            )
            run = proctor.runs[0]
            Path(run.output_file).write_text(
                json.dumps(
                    {
                        "model": "openai-responses:gpt-5.2",
                        "api_base": None,
                        "max_links": None,
                        "max_tries": 3,
                        "start_article": run.start_article,
                        "destination_article": run.destination_article,
                        "steps": [
                            {"type": "start", "article": run.start_article},
                            {"type": "lose", "article": run.start_article},
                        ],
                        "result": "lose",
                    }
                ),
                "utf-8",
            )

            replacement_steps = [
                {"type": "start", "article": run.start_article},
                {"type": "lose", "article": run.start_article},
            ]

            with (
                patch("parallel_eval.proctor.AgentPlayer", return_value=SimpleNamespace()),
                patch(
                    "parallel_eval.proctor.Game",
                    return_value=SimpleNamespace(run=lambda: asyncio.sleep(0, result=replacement_steps)),
                ) as game_mock,
            ):
                asyncio.run(run.run())

            game_mock.assert_called_once()
            output = json.loads(Path(run.output_file).read_text("utf-8"))
            self.assertEqual(output["result"], "lose")
            self.assertEqual(output["run_config_hash"], run.run_config_hash)

    def test_run_regenerates_existing_output_from_different_config(self):
        with tempfile.TemporaryDirectory() as td:
            td_path = Path(td)
            db_path = td_path / "wikihop.db"
            _build_test_db(db_path)

            first_proctor = Proctor(
                article_list=["A", "B"],
                num_trials=1,
                num_workers=1,
                max_steps=5,
                agent_settings={
                    "model": "openai-responses:gpt-5.2",
                    "api_base": None,
                    "max_links": None,
                    "max_tries": 3,
                },
                db_path=str(db_path),
                verbose=False,
                output_dir=str(td_path),
                proctor_id="proctor_resume_config",
            )
            first_run = first_proctor.runs[0]
            Path(first_run.output_file).write_text(
                json.dumps(
                    {
                        "model": "openai-responses:gpt-5.2",
                        "api_base": None,
                        "max_links": None,
                        "max_tries": 3,
                        "max_steps": first_run.max_steps,
                        "run_config": first_run.run_config,
                        "run_config_hash": first_run.run_config_hash,
                        "start_article": first_run.start_article,
                        "destination_article": first_run.destination_article,
                        "steps": [
                            {"type": "start", "article": first_run.start_article},
                            {"type": "lose", "article": first_run.start_article},
                        ],
                        "result": "lose",
                    }
                ),
                "utf-8",
            )

            second_proctor = Proctor(
                article_list=["A", "B"],
                num_trials=1,
                num_workers=1,
                max_steps=5,
                agent_settings={
                    "model": "openai-responses:gpt-5.4",
                    "api_base": None,
                    "max_links": None,
                    "max_tries": 3,
                },
                db_path=str(db_path),
                verbose=False,
                output_dir=str(td_path),
                proctor_id="proctor_resume_config",
            )
            second_run = second_proctor.runs[0]
            self.assertEqual(first_run.output_file, second_run.output_file)
            self.assertNotEqual(first_run.run_config_hash, second_run.run_config_hash)

            replacement_steps = [
                {"type": "start", "article": second_run.start_article},
                {"type": "lose", "article": second_run.start_article},
            ]

            with (
                patch("parallel_eval.proctor.AgentPlayer", return_value=SimpleNamespace()),
                patch(
                    "parallel_eval.proctor.Game",
                    return_value=SimpleNamespace(run=lambda: asyncio.sleep(0, result=replacement_steps)),
                ) as game_mock,
            ):
                asyncio.run(second_run.run())

            game_mock.assert_called_once()
            output = json.loads(Path(second_run.output_file).read_text("utf-8"))
            self.assertEqual(output["model"], "openai-responses:gpt-5.4")
            self.assertEqual(output["run_config_hash"], second_run.run_config_hash)

    def test_run_regenerates_invalid_existing_output_file(self):
        with tempfile.TemporaryDirectory() as td:
            td_path = Path(td)
            db_path = td_path / "wikihop.db"
            _build_test_db(db_path)

            proctor = Proctor(
                article_list=["A", "B"],
                num_trials=1,
                num_workers=1,
                max_steps=5,
                agent_settings={
                    "model": "openai-responses:gpt-5.2",
                    "api_base": None,
                    "max_links": None,
                    "max_tries": 3,
                },
                db_path=str(db_path),
                verbose=False,
                output_dir=str(td_path),
                proctor_id="proctor_resume_corrupt",
            )
            run = proctor.runs[0]
            Path(run.output_file).write_text('{"result": "win"', "utf-8")

            replacement_steps = [
                {"type": "start", "article": run.start_article},
                {"type": "lose", "article": run.start_article},
            ]

            with (
                patch("parallel_eval.proctor.AgentPlayer", return_value=SimpleNamespace()),
                patch(
                    "parallel_eval.proctor.Game",
                    return_value=SimpleNamespace(run=lambda: asyncio.sleep(0, result=replacement_steps)),
                ) as game_mock,
            ):
                asyncio.run(run.run())

            game_mock.assert_called_once()
            output = json.loads(Path(run.output_file).read_text("utf-8"))
            self.assertEqual(output["result"], "lose")
            self.assertEqual(output["steps"], replacement_steps)

    def test_run_passes_reasoning_settings_to_agent_player(self):
        with tempfile.TemporaryDirectory() as td:
            td_path = Path(td)
            db_path = td_path / "wikihop.db"
            _build_test_db(db_path)

            proctor = Proctor(
                article_list=["A", "B"],
                num_trials=1,
                num_workers=1,
                max_steps=5,
                agent_settings={
                    "model": "openai-responses:gpt-5.2",
                    "api_base": None,
                    "max_links": None,
                    "max_tries": 3,
                    "openai_api_mode": "responses",
                    "openai_reasoning_effort": "medium",
                    "openai_reasoning_summary": "auto",
                    "anthropic_thinking_budget_tokens": 1024,
                    "google_thinking_config": {"thinkingBudget": 64},
                },
                db_path=str(db_path),
                verbose=False,
                output_dir=str(td_path),
                proctor_id="proctor_reasoning_settings",
            )
            run = proctor.runs[0]
            replacement_steps = [
                {"type": "start", "article": run.start_article},
                {"type": "lose", "article": run.start_article},
            ]

            with (
                patch("parallel_eval.proctor.AgentPlayer", return_value=SimpleNamespace()) as agent_mock,
                patch(
                    "parallel_eval.proctor.Game",
                    return_value=SimpleNamespace(run=lambda: asyncio.sleep(0, result=replacement_steps)),
                ),
            ):
                asyncio.run(run.run())

            agent_kwargs = agent_mock.call_args.kwargs
            self.assertEqual(agent_kwargs["openai_reasoning_summary"], "auto")
            self.assertEqual(agent_kwargs["anthropic_thinking_budget_tokens"], 1024)
            self.assertEqual(agent_kwargs["google_thinking_config"], {"thinkingBudget": 64})

            output = json.loads(Path(run.output_file).read_text("utf-8"))
            self.assertEqual(output["openai_reasoning_summary"], "auto")
            self.assertEqual(output["anthropic_thinking_budget_tokens"], 1024)
            self.assertEqual(output["google_thinking_config"], {"thinkingBudget": 64})


if __name__ == "__main__":
    unittest.main()
