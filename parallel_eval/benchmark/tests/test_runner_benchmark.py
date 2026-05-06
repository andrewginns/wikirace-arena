from __future__ import annotations

import asyncio
import json
import sqlite3
import tempfile
import unittest
from pathlib import Path
from unittest import mock

import api
from llm_client import NormalizedChatResult, NormalizedUsage
from parallel_eval.benchmark.runner import ChooseLinkResult, _dataset_id_for_run, _run_one, run_benchmark_dataset
from parallel_eval.benchmark.schema import MatchupV1, RunBudgetsV1, RunModelSettingsV1, RunProvenanceV1, read_jsonl
from parallel_eval.game import SQLiteDB


def _build_test_db(path: Path) -> None:
    conn = sqlite3.connect(path)
    cur = conn.cursor()
    cur.execute("CREATE TABLE core_articles (title TEXT PRIMARY KEY, links_json TEXT NOT NULL)")
    rows = {
        "CleanStart": ["Target", "Other"],
        "RetryWinStart": ["Target", "Other"],
        "RetryLoseStart": ["Target", "Other"],
        "DeadEndStart": ["DeadEnd"],
        "DeadEnd": [],
        "MaxStepStart": ["Mid"],
        "Mid": ["Other"],
        "AliasStart": ["Alias", "Other"],
        "Alias": ["Target"],
        "NoLinksStart": [],
        "Target": [],
        "Other": [],
        "CaptureStart": ["CaptureTarget", "Other"],
        "CaptureTarget": [],
    }
    for title, links in rows.items():
        cur.execute("INSERT INTO core_articles (title, links_json) VALUES (?, ?)", (title, json.dumps(links)))
    conn.commit()
    conn.close()


class RunnerBenchmarkTests(unittest.TestCase):
    def test_dataset_id_for_suite_level_runs_uses_suite_all(self):
        matchups = [
            MatchupV1(
                id="m1",
                tier="core_rank_v1",
                start="A",
                target="B",
                suite_id="classic_local_simplewiki_v1",
                slice_id="core_rank_v1",
                setup_id="classic_local_v1",
            ),
            MatchupV1(
                id="m2",
                tier="diag_wide_choice_v1",
                start="C",
                target="D",
                suite_id="classic_local_simplewiki_v1",
                slice_id="diag_wide_choice_v1",
                setup_id="classic_local_v1",
            ),
        ]

        dataset_id = _dataset_id_for_run(Path("benchmarks/matchups/classic_local_simplewiki_v1/all.jsonl"), matchups)
        self.assertEqual(dataset_id, "matchups/classic_local_simplewiki_v1/all")

    def _run_app_case(
        self,
        *,
        db_path: Path,
        start: str,
        target: str,
        max_steps: int,
        app_choose_outputs: list[tuple[int | None, dict[str, object]]],
    ) -> tuple[str, int, str | None]:
        original_db = api.db
        local_db = api.SQLiteDB(str(db_path))
        api.db = local_db

        async def fake_choose_llm_link(**_kwargs):
            if not app_choose_outputs:
                raise AssertionError("Unexpected LLM selection call")
            return app_choose_outputs.pop(0)

        async def run_case() -> tuple[str, int, str | None]:
            current = start
            path = [start]
            hops = 0
            while hops < max_steps:
                hops += 1
                step_type, next_article, metadata = await api._compute_llm_next_step(
                    current_article=current,
                    destination_article=target,
                    path_so_far=path,
                    next_hops=hops,
                    max_steps=max_steps,
                    model="test-model",
                    api_base=None,
                    openai_api_mode=None,
                    openai_reasoning_effort=None,
                    openai_reasoning_summary=None,
                    anthropic_thinking_budget_tokens=None,
                    google_thinking_config=None,
                    max_links=None,
                    max_tokens=None,
                )
                reason = metadata.get("reason") if isinstance(metadata, dict) else None
                if step_type == "move":
                    current = api.db.canonical_title(next_article) or next_article
                    path.append(current)
                    continue
                return ("win" if step_type == "win" else "lose", hops, reason if isinstance(reason, str) else None)
            return "lose", hops, "max_steps"

        try:
            with mock.patch.object(api, "_choose_llm_link", side_effect=fake_choose_llm_link):
                return asyncio.run(run_case())
        finally:
            api.db = original_db
            local_db.conn.close()

    def _run_runner_case(
        self,
        *,
        db_path: Path,
        start: str,
        target: str,
        max_steps: int,
        runner_choices: list[ChooseLinkResult],
    ) -> tuple[str, int, str | None]:
        with tempfile.TemporaryDirectory() as td:
            out_path = Path(td) / "records.jsonl"
            db = SQLiteDB(str(db_path))

            async def fake_choose_link(**_kwargs):
                if not runner_choices:
                    raise AssertionError("Unexpected benchmark selection call")
                return runner_choices.pop(0)

            matchup = MatchupV1(id="m1", tier="core_rank_v1", start=start, target=target)

            try:
                with mock.patch("parallel_eval.benchmark.runner._choose_link", side_effect=fake_choose_link):
                    asyncio.run(
                        _run_one(
                            matchup=matchup,
                            db=db,
                            dataset_id="matchups/test",
                            model_settings=RunModelSettingsV1(model="test-model"),
                            budgets=RunBudgetsV1(max_hops=max_steps, max_links=None, max_tokens=None, max_tries=3),
                            provenance=RunProvenanceV1(seed=0, concurrency=1, db_path=str(db_path), db_sha256="sha"),
                            benchmark_setup=None,
                            prompt_version="choose_link_v1",
                            semantics_version="local_parity_v1",
                            raw_output_mode="none",
                            llm_output_max_chars=200,
                            out_path=out_path,
                        )
                    )
            finally:
                db.conn.close()

            lines = read_jsonl(out_path)
            run_record = next(line.data for line in lines if line.data.get("type") == "run")
            step_records = [line.data for line in lines if line.data.get("type") == "step"]
            step_records.sort(key=lambda step: int(step.get("hop") or 0))
            last_reason = None
            if step_records:
                meta = step_records[-1].get("meta")
                if isinstance(meta, dict):
                    reason = meta.get("reason")
                    if isinstance(reason, str):
                        last_reason = reason
            return str(run_record["result"]), int(run_record["hops"]), last_reason

    def test_semantic_parity_cases(self):
        with tempfile.TemporaryDirectory() as td:
            db_path = Path(td) / "test.db"
            _build_test_db(db_path)

            cases = [
                (
                    "clean win",
                    "CleanStart",
                    "Target",
                    20,
                    [(1, {"tries": 0})],
                    [ChooseLinkResult(1, [], 1, None, None, None, None, [], None, None, None, None)],
                    ("win", 1, None),
                ),
                (
                    "bad-answer retry then win",
                    "RetryWinStart",
                    "Target",
                    20,
                    [(1, {"tries": 1, "answer_errors": ["bad"]})],
                    [ChooseLinkResult(1, [], 2, None, None, None, None, ["bad"], None, None, None, None)],
                    ("win", 1, None),
                ),
                (
                    "bad-answer retry then loss",
                    "RetryLoseStart",
                    "Target",
                    20,
                    [(None, {"tries": 2, "answer_errors": ["bad"]})],
                    [ChooseLinkResult(None, [], 2, None, None, None, None, ["bad"], None, None, None, None)],
                    ("lose", 1, "bad_answer"),
                ),
                (
                    "dead-end selected",
                    "DeadEndStart",
                    "Target",
                    20,
                    [(1, {"tries": 0})],
                    [ChooseLinkResult(1, [], 1, None, None, None, None, [], None, None, None, None)],
                    ("lose", 2, "no_links"),
                ),
                (
                    "max-hops loss",
                    "MaxStepStart",
                    "Target",
                    1,
                    [(1, {"tries": 0})],
                    [ChooseLinkResult(1, [], 1, None, None, None, None, [], None, None, None, None)],
                    ("lose", 1, "max_steps"),
                ),
                (
                    "canonical-title-equivalent win",
                    "AliasStart",
                    "Target",
                    20,
                    [(1, {"tries": 0})],
                    [ChooseLinkResult(1, [], 1, None, None, None, None, [], None, None, None, None)],
                    ("win", 1, None),
                ),
                (
                    "no-links-at-start loss",
                    "NoLinksStart",
                    "Target",
                    20,
                    [],
                    [],
                    ("lose", 1, "no_links"),
                ),
            ]

            for name, start, target, max_steps, app_outputs, runner_outputs, expected in cases:
                with self.subTest(name=name):
                    app_result = self._run_app_case(
                        db_path=db_path,
                        start=start,
                        target=target,
                        max_steps=max_steps,
                        app_choose_outputs=list(app_outputs),
                    )
                    runner_result = self._run_runner_case(
                        db_path=db_path,
                        start=start,
                        target=target,
                        max_steps=max_steps,
                        runner_choices=list(runner_outputs),
                    )
                    self.assertEqual(app_result, expected)
                    self.assertEqual(runner_result, expected)

    def test_attempt_capture_and_provenance(self):
        with tempfile.TemporaryDirectory() as td:
            td_path = Path(td)
            db_path = td_path / "capture.db"
            dataset_path = td_path / "dataset.jsonl"
            out_path = td_path / "capture-run" / "records.jsonl"
            _build_test_db(db_path)

            dataset_path.write_text(
                json.dumps(
                    MatchupV1(
                        id="capture-1",
                        tier="core_rank_v1",
                        start="CaptureStart",
                        target="CaptureTarget",
                        suite_id="classic_local_v1",
                        slice_id="core_rank_v1",
                        setup_id="classic_local_v1",
                        prompt_version="choose_link_v1",
                        semantics_version="local_parity_v1",
                        shortest_path_hops=1,
                    ).model_dump(mode="json")
                )
                + "\n",
                "utf-8",
            )

            responses = iter(
                [
                    NormalizedChatResult(
                        content="not valid",
                        usage=NormalizedUsage(prompt_tokens=10, completion_tokens=1, total_tokens=11),
                    ),
                    NormalizedChatResult(
                        content="<answer>0</answer>",
                        usage=NormalizedUsage(prompt_tokens=11, completion_tokens=1, total_tokens=12),
                    ),
                    NormalizedChatResult(
                        content="<answer>1</answer>",
                        usage=NormalizedUsage(prompt_tokens=12, completion_tokens=1, total_tokens=13),
                    ),
                ]
            )

            async def fake_achat(**_kwargs):
                return next(responses)

            with mock.patch("parallel_eval.benchmark.runner.achat", side_effect=fake_achat):
                run_benchmark_dataset(
                    dataset_path=dataset_path,
                    db_path=db_path,
                    out_path=out_path,
                    model="test-model",
                    api_base=None,
                    openai_api_mode=None,
                    openai_reasoning_effort=None,
                    openai_reasoning_summary=None,
                    anthropic_thinking_budget_tokens=None,
                    google_thinking_config=None,
                    max_hops=0,
                    max_links=None,
                    max_tokens=None,
                    max_tries=0,
                    concurrency=1,
                    seed=0,
                    raw_output_mode="truncated",
                    llm_output_max_chars=32,
                    write_viewer_json=False,
                    write_summary_json=False,
                    overwrite=False,
                    setup_id="classic_local_v1",
                )

            lines = read_jsonl(out_path)
            run_records = [line.data for line in lines if line.data.get("type") == "run"]
            step_records = [line.data for line in lines if line.data.get("type") == "step"]
            attempt_records = [line.data for line in lines if line.data.get("type") == "attempt"]

            self.assertEqual(len(run_records), 1)
            self.assertEqual(len(step_records), 1)
            self.assertEqual(len(attempt_records), 3)

            step = step_records[0]
            self.assertEqual(step["attempt_count"], 3)
            self.assertEqual(step["choice"]["selected_index"], 1)
            self.assertEqual(step["selected_title"], "CaptureTarget")
            self.assertEqual(step["links_presented_count"], 2)
            self.assertTrue(step["links_presented_ref"])

            final_attempt = attempt_records[-1]
            self.assertEqual(final_attempt["selected_index_parsed"], 1)
            self.assertEqual(final_attempt["selected_title_parsed"], "CaptureTarget")
            self.assertTrue(final_attempt["raw_output_ref"])

            provenance = run_records[0]["provenance"]
            self.assertTrue(provenance["db_sha256"])


if __name__ == "__main__":
    unittest.main()
