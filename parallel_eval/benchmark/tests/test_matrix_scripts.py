from __future__ import annotations

import importlib.util
import json
import sys
import tempfile
import threading
import time
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest import mock

REPO_ROOT = Path(__file__).resolve().parents[3]
if str(REPO_ROOT) not in sys.path:
    sys.path.insert(0, str(REPO_ROOT))

from parallel_eval.benchmark.schema import (  # noqa: E402
    BenchmarkRunRecordV1,
    MatchupV1,
    RunBudgetsV1,
    RunModelSettingsV1,
    TokenTotalsV1,
    write_jsonl_line,
)
from parallel_eval.benchmark.settings import DEFAULT_BENCHMARK_DB_PATH  # noqa: E402


def _load_script_module(name: str, rel_path: str):
    path = REPO_ROOT / rel_path
    spec = importlib.util.spec_from_file_location(name, path)
    if spec is None or spec.loader is None:
        raise RuntimeError(f"Failed to load {rel_path}")
    module = importlib.util.module_from_spec(spec)
    sys.modules[name] = module
    spec.loader.exec_module(module)
    return module


merge_benchmark_matrix = _load_script_module("merge_benchmark_matrix", "scripts/merge_benchmark_matrix.py")
run_benchmark_matrix = _load_script_module("run_benchmark_matrix", "scripts/run_benchmark_matrix.py")

_infer_dataset_ids = merge_benchmark_matrix._infer_dataset_ids
DEFAULT_DB_PATH = run_benchmark_matrix.DEFAULT_DB_PATH
DEFAULT_DATASET = run_benchmark_matrix.DEFAULT_DATASET
_dataset_id_for_matchups = run_benchmark_matrix._dataset_id_for_matchups
_existing_run_matches = run_benchmark_matrix._existing_run_matches
_records_for_publish = run_benchmark_matrix._records_for_publish
_run_cells = run_benchmark_matrix._run_cells
_selected_efforts = run_benchmark_matrix._selected_efforts
_selected_models = run_benchmark_matrix._selected_models


def _write_run_record(
    path: Path,
    *,
    model: str,
    effort: str | None = None,
    dataset_id: str = "matchups/classic_local_simplewiki_v1/all",
    run_id: str = "run-1",
) -> None:
    write_jsonl_line(
        path,
        BenchmarkRunRecordV1(
            run_id=run_id,
            dataset_id=dataset_id,
            matchup_id="m1",
            tier="core_rank_v1",
            suite_id="classic_local_simplewiki_v1",
            slice_id="core_rank_v1",
            setup_id="classic_local_v1",
            prompt_version="choose_link_v1",
            semantics_version="local_parity_v1",
            start="A",
            target="B",
            started_at="2026-01-01T00:00:00Z",
            finished_at="2026-01-01T00:00:01Z",
            result="win",
            hops=3,
            duration_ms=1000,
            llm_latency_ms=900,
            model_settings=RunModelSettingsV1(
                model=model,
                openai_reasoning_effort=effort,
            ),
            budgets=RunBudgetsV1(max_hops=20, max_links=None, max_tokens=None, max_tries=3),
            totals=TokenTotalsV1(total_tokens=123),
            provenance={"db_path": str(DEFAULT_BENCHMARK_DB_PATH)},
        ),
    )


class MatrixScriptTests(unittest.TestCase):
    def test_run_matrix_defaults_to_frozen_benchmark_db(self):
        self.assertEqual(DEFAULT_DB_PATH, DEFAULT_BENCHMARK_DB_PATH)

    def test_run_matrix_defaults_to_standard_frontier_dataset(self):
        self.assertEqual(
            DEFAULT_DATASET,
            Path("benchmarks/matchups/frontier_local_simplewiki_standard_v1/all.jsonl"),
        )

    def test_run_matrix_concurrency_defaults_to_one(self):
        with mock.patch.object(
            sys,
            "argv",
            ["run_benchmark_matrix.py"],
        ):
            args = run_benchmark_matrix._parse_args()
        self.assertEqual(args.concurrency, 1)

    def test_run_matrix_max_active_cells_defaults_to_one(self):
        with mock.patch.object(
            sys,
            "argv",
            ["run_benchmark_matrix.py"],
        ):
            args = run_benchmark_matrix._parse_args()
        self.assertEqual(args.max_active_cells, 1)

    def test_run_matrix_accepts_arbitrary_models_and_efforts(self):
        self.assertEqual(
            _selected_models(["gpt-5.3-codex", "gpt-5.4", "gpt-5.3-codex"]),
            ["gpt-5.3-codex", "gpt-5.4"],
        )
        self.assertEqual(
            _selected_efforts(["none", "medium", "none", "xhigh"]),
            ["none", "medium", "xhigh"],
        )

    def test_dataset_id_for_all_dataset_uses_suite_all(self):
        with tempfile.TemporaryDirectory() as td:
            dataset_path = Path(td) / "all.jsonl"
            write_jsonl_line(
                dataset_path,
                MatchupV1(
                    id="m1",
                    tier="core_rank_v1",
                    start="A",
                    target="B",
                    suite_id="classic_local_simplewiki_v1",
                    slice_id="core_rank_v1",
                    setup_id="classic_local_v1",
                ),
            )
            write_jsonl_line(
                dataset_path,
                MatchupV1(
                    id="m2",
                    tier="diag_wide_choice_v1",
                    start="C",
                    target="D",
                    suite_id="classic_local_simplewiki_v1",
                    slice_id="diag_wide_choice_v1",
                    setup_id="classic_local_v1",
                ),
            )

            self.assertEqual(
                _dataset_id_for_matchups(dataset_path),
                "matchups/classic_local_simplewiki_v1/all",
            )

    def test_merge_infers_dataset_id_from_run_records(self):
        with tempfile.TemporaryDirectory() as td:
            records_path = Path(td) / "records.jsonl"
            write_jsonl_line(
                records_path,
                BenchmarkRunRecordV1(
                    run_id="run-1",
                    dataset_id="matchups/classic_local_simplewiki_v1/all",
                    matchup_id="m1",
                    tier="core_rank_v1",
                    suite_id="classic_local_simplewiki_v1",
                    slice_id="core_rank_v1",
                    setup_id="classic_local_v1",
                    prompt_version="choose_link_v1",
                    semantics_version="local_parity_v1",
                    start="A",
                    target="B",
                    started_at="2026-01-01T00:00:00Z",
                    finished_at="2026-01-01T00:00:01Z",
                    result="win",
                    hops=3,
                    duration_ms=1000,
                    llm_latency_ms=900,
                    model_settings=RunModelSettingsV1(model="openai-responses:gpt-5.4"),
                    budgets=RunBudgetsV1(max_hops=20, max_links=None, max_tokens=None, max_tries=3),
                    totals=TokenTotalsV1(total_tokens=123),
                ),
            )

            self.assertEqual(
                _infer_dataset_ids([records_path]),
                ["matchups/classic_local_simplewiki_v1/all"],
            )

    def test_merge_refuses_to_publish_incomplete_matrix(self):
        with tempfile.TemporaryDirectory() as td:
            td_path = Path(td)
            bundle_dir = td_path / "bundle"
            bundle_dir.mkdir(parents=True)
            status_path = bundle_dir / "status.json"
            records_path = bundle_dir / "records.jsonl"
            write_jsonl_line(
                records_path,
                BenchmarkRunRecordV1(
                    run_id="run-1",
                    dataset_id="matchups/classic_local_simplewiki_v1/all",
                    matchup_id="m1",
                    tier="core_rank_v1",
                    suite_id="classic_local_simplewiki_v1",
                    slice_id="core_rank_v1",
                    setup_id="classic_local_v1",
                    prompt_version="choose_link_v1",
                    semantics_version="local_parity_v1",
                    start="A",
                    target="B",
                    started_at="2026-01-01T00:00:00Z",
                    finished_at="2026-01-01T00:00:01Z",
                    result="win",
                    hops=3,
                    duration_ms=1000,
                    llm_latency_ms=900,
                    model_settings=RunModelSettingsV1(model="openai-responses:gpt-5.4"),
                    budgets=RunBudgetsV1(max_hops=20, max_links=None, max_tokens=None, max_tries=3),
                    totals=TokenTotalsV1(total_tokens=123),
                ),
            )
            status_path.write_text(
                (
                    '{\n'
                    '  "dataset_id": "matchups/classic_local_simplewiki_v1/all",\n'
                    '  "cells": [\n'
                    f'    {{"model": "gpt-5.4", "effort": "none", "status": "completed", "supported": true, "records_path": "{records_path}"}},\n'
                    '    {"model": "gpt-5.4", "effort": "high", "status": "failed", "supported": true}\n'
                    "  ]\n"
                    "}\n"
                ),
                "utf-8",
            )

            args = SimpleNamespace(
                bundle_dirs=[bundle_dir],
                out_dir=td_path / "out",
                public_dir=td_path / "public",
                dataset_id=None,
                no_publish=False,
            )

            with (
                mock.patch.object(merge_benchmark_matrix, "_parse_args", return_value=args),
                mock.patch.object(merge_benchmark_matrix, "write_text_report"),
                mock.patch.object(merge_benchmark_matrix, "write_leaderboard_json") as write_leaderboard_json,
                self.assertRaises(SystemExit),
            ):
                merge_benchmark_matrix.main()

            write_leaderboard_json.assert_not_called()

    def test_skip_existing_requires_matching_run_identity(self):
        with tempfile.TemporaryDirectory() as td:
            td_path = Path(td)
            records_path = td_path / "records.jsonl"
            write_jsonl_line(
                records_path,
                BenchmarkRunRecordV1(
                    run_id="run-1",
                    dataset_id="matchups/classic_local_simplewiki_v1/all",
                    matchup_id="m1",
                    tier="core_rank_v1",
                    suite_id="classic_local_simplewiki_v1",
                    slice_id="core_rank_v1",
                    setup_id="classic_local_v1",
                    prompt_version="choose_link_v1",
                    semantics_version="local_parity_v1",
                    start="A",
                    target="B",
                    started_at="2026-01-01T00:00:00Z",
                    finished_at="2026-01-01T00:00:01Z",
                    result="win",
                    hops=3,
                    duration_ms=1000,
                    llm_latency_ms=900,
                    model_settings=RunModelSettingsV1(
                        model="openai-responses:gpt-5.4",
                        openai_reasoning_effort="high",
                    ),
                    budgets=RunBudgetsV1(max_hops=20, max_links=None, max_tokens=None, max_tries=3),
                    totals=TokenTotalsV1(total_tokens=123),
                    provenance={"db_path": str(DEFAULT_BENCHMARK_DB_PATH)},
                ),
            )

            self.assertTrue(
                _existing_run_matches(
                    records_path=records_path,
                    dataset_id="matchups/classic_local_simplewiki_v1/all",
                    db_path=DEFAULT_BENCHMARK_DB_PATH,
                    model="openai-responses:gpt-5.4",
                    effort="high",
                    setup_id="classic_local_v1",
                )
            )
            self.assertFalse(
                _existing_run_matches(
                    records_path=records_path,
                    dataset_id="matchups/other",
                    db_path=DEFAULT_BENCHMARK_DB_PATH,
                    model="openai-responses:gpt-5.4",
                    effort="high",
                    setup_id="classic_local_v1",
                )
            )
            self.assertFalse(
                _existing_run_matches(
                    records_path=records_path,
                    dataset_id="matchups/classic_local_simplewiki_v1/all",
                    db_path=DEFAULT_BENCHMARK_DB_PATH,
                    model="openai-responses:gpt-5.4",
                    effort="medium",
                    setup_id="classic_local_v1",
                )
            )

    def test_run_cells_limits_active_subprocesses_and_passes_expected_flags(self):
        with tempfile.TemporaryDirectory() as td:
            td_path = Path(td)
            cells: list[run_benchmark_matrix.CellStatus] = []
            for index, effort in enumerate(("none", "medium", "high"), start=1):
                run_dir = td_path / f"run-{index}"
                cells.append(
                    run_benchmark_matrix.CellStatus(
                        model="gpt-5.3-codex",
                        effort=effort,
                        supported=True,
                        status="pending",
                        records_path=str(run_dir / "records.jsonl"),
                        summary_path=str(run_dir / "summary.json"),
                        viewer_path=str(run_dir / "viewer.json"),
                        log_path=str(run_dir / "run.log"),
                    )
                )

            seen_commands: list[list[str]] = []
            counters = {"active": 0, "max_active": 0}
            counter_lock = threading.Lock()

            def fake_run_subprocess(command: list[str], log_path: Path) -> int:
                with counter_lock:
                    counters["active"] += 1
                    counters["max_active"] = max(counters["max_active"], counters["active"])
                seen_commands.append(command)
                self.assertIn("openai-responses:gpt-5.3-codex", command)
                self.assertIn("--concurrency", command)
                self.assertIn("7", command)
                out_path = Path(command[command.index("--out") + 1])
                out_path.parent.mkdir(parents=True, exist_ok=True)
                out_path.write_text('{"type":"run"}\n', "utf-8")
                (out_path.parent / "summary.json").write_text("{}", "utf-8")
                (out_path.parent / "viewer.json").write_text("{}", "utf-8")
                log_path.parent.mkdir(parents=True, exist_ok=True)
                log_path.write_text("ok\n", "utf-8")
                time.sleep(0.05)
                with counter_lock:
                    counters["active"] -= 1
                return 0

            with mock.patch.object(run_benchmark_matrix, "_run_cell_subprocess", side_effect=fake_run_subprocess):
                asyncio_result = run_benchmark_matrix.asyncio.run(
                    _run_cells(
                        cells=cells,
                        dataset=DEFAULT_DATASET,
                        db_path=DEFAULT_DB_PATH,
                        concurrency=7,
                        max_active_cells=2,
                        persist_status=lambda: None,
                    )
                )
                self.assertIsNone(asyncio_result)

            self.assertEqual(len(seen_commands), 3)
            self.assertLessEqual(counters["max_active"], 2)
            self.assertTrue(all(cell.status == "completed" for cell in cells))

    def test_run_matrix_marks_unsupported_probe_and_runs_remaining_cells(self):
        with tempfile.TemporaryDirectory() as td:
            td_path = Path(td)
            dataset_path = td_path / "all.jsonl"
            write_jsonl_line(
                dataset_path,
                MatchupV1(
                    id="m1",
                    tier="core_rank_v1",
                    start="A",
                    target="B",
                    suite_id="classic_local_simplewiki_v1",
                    slice_id="core_rank_v1",
                    setup_id="classic_local_v1",
                ),
            )

            args = SimpleNamespace(
                dataset=dataset_path,
                db_path=DEFAULT_BENCHMARK_DB_PATH,
                public_dir=td_path / "public",
                bundle_dir=td_path / "bundle",
                dataset_id="matchups/classic_local_simplewiki_v1/all",
                concurrency=2,
                max_active_cells=2,
                models=["gpt-5.1", "gpt-5.3-codex"],
                efforts=["none", "xhigh"],
                skip_existing=False,
                no_publish=True,
            )

            async def fake_probe(model: str, effort: str) -> tuple[bool, str | None]:
                if model == "gpt-5.1" and effort == "xhigh":
                    return False, "unsupported xhigh"
                return True, None

            async def fake_run_cells(**kwargs: object) -> None:
                cells = kwargs["cells"]
                for cell in cells:
                    records_path = Path(cell.records_path)
                    records_path.parent.mkdir(parents=True, exist_ok=True)
                    records_path.write_text('{"type":"run"}\n', "utf-8")
                    Path(cell.summary_path).write_text("{}", "utf-8")
                    Path(cell.viewer_path).write_text("{}", "utf-8")
                    Path(cell.log_path).write_text("ok\n", "utf-8")
                    cell.status = "completed"

            with (
                mock.patch.object(run_benchmark_matrix, "_parse_args", return_value=args),
                mock.patch.object(run_benchmark_matrix, "_probe_support", side_effect=fake_probe),
                mock.patch.object(run_benchmark_matrix, "_run_cells", side_effect=fake_run_cells),
                mock.patch.object(run_benchmark_matrix, "write_text_report"),
            ):
                run_benchmark_matrix.main()

            status = json.loads((td_path / "bundle" / "status.json").read_text("utf-8"))
            self.assertEqual(status["unsupported"], 1)
            unsupported = {
                (cell["model"], cell["effort"]): cell
                for cell in status["cells"]
                if cell["status"] == "unsupported"
            }
            self.assertIn(("gpt-5.1", "xhigh"), unsupported)
            self.assertEqual(unsupported[("gpt-5.1", "xhigh")]["probe_error"], "unsupported xhigh")
            completed = [
                (cell["model"], cell["effort"])
                for cell in status["cells"]
                if cell["status"] == "completed"
            ]
            self.assertEqual(
                completed,
                [("gpt-5.1", "none"), ("gpt-5.3-codex", "none"), ("gpt-5.3-codex", "xhigh")],
            )

    def test_records_for_publish_replaces_duplicate_model_effort_with_new_run(self):
        with tempfile.TemporaryDirectory() as td:
            td_path = Path(td)
            public_dir = td_path / "public" / "benchmarks"
            public_dir.mkdir(parents=True)
            existing_keep = td_path / "existing-keep.jsonl"
            existing_replace = td_path / "existing-replace.jsonl"
            new_replace = td_path / "new-replace.jsonl"
            new_add = td_path / "new-add.jsonl"

            _write_run_record(existing_keep, model="openai-responses:gpt-5.1", effort="low", run_id="keep")
            _write_run_record(existing_replace, model="openai-responses:gpt-5.4", effort="medium", run_id="old")
            _write_run_record(new_replace, model="openai-responses:gpt-5.4", effort="medium", run_id="new")
            _write_run_record(new_add, model="openai-responses:gpt-5.3-codex", effort="medium", run_id="add")

            (public_dir / "leaderboard.json").write_text(
                json.dumps(
                    {
                        "entries": [
                            {"source_jsonl": str(existing_keep)},
                            {"source_jsonl": str(existing_replace)},
                        ]
                    }
                ),
                "utf-8",
            )

            merged = _records_for_publish(
                public_dir=public_dir,
                completed_records=[new_replace, new_add],
            )
            self.assertEqual(
                merged,
                [existing_keep, new_replace, new_add],
            )

    def test_merge_refuses_duplicate_model_effort_cells(self):
        with tempfile.TemporaryDirectory() as td:
            td_path = Path(td)
            bundle_a = td_path / "bundle-a"
            bundle_b = td_path / "bundle-b"
            bundle_a.mkdir(parents=True)
            bundle_b.mkdir(parents=True)

            for idx, bundle_dir in enumerate((bundle_a, bundle_b), start=1):
                records_path = bundle_dir / f"records-{idx}.jsonl"
                write_jsonl_line(
                    records_path,
                    BenchmarkRunRecordV1(
                        run_id=f"run-{idx}",
                        dataset_id="matchups/classic_local_simplewiki_v1/all",
                        matchup_id=f"m{idx}",
                        tier="core_rank_v1",
                        suite_id="classic_local_simplewiki_v1",
                        slice_id="core_rank_v1",
                        setup_id="classic_local_v1",
                        prompt_version="choose_link_v1",
                        semantics_version="local_parity_v1",
                        start="A",
                        target="B",
                        started_at="2026-01-01T00:00:00Z",
                        finished_at="2026-01-01T00:00:01Z",
                        result="win",
                        hops=3,
                        duration_ms=1000,
                        llm_latency_ms=900,
                        model_settings=RunModelSettingsV1(model="openai-responses:gpt-5.4"),
                        budgets=RunBudgetsV1(max_hops=20, max_links=None, max_tokens=None, max_tries=3),
                        totals=TokenTotalsV1(total_tokens=123),
                    ),
                )
                (bundle_dir / "status.json").write_text(
                    (
                        '{\n'
                        '  "dataset_id": "matchups/classic_local_simplewiki_v1/all",\n'
                        '  "cells": [\n'
                        f'    {{"model": "gpt-5.4", "effort": "high", "status": "completed", "supported": true, "records_path": "{records_path}"}}\n'
                        "  ]\n"
                        "}\n"
                    ),
                    "utf-8",
                )

            args = SimpleNamespace(
                bundle_dirs=[bundle_a, bundle_b],
                out_dir=td_path / "out",
                public_dir=td_path / "public",
                dataset_id=None,
                no_publish=True,
            )

            with mock.patch.object(merge_benchmark_matrix, "_parse_args", return_value=args), self.assertRaises(SystemExit):
                merge_benchmark_matrix.main()


if __name__ == "__main__":
    unittest.main()
