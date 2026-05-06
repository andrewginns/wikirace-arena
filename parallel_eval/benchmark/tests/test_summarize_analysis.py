from __future__ import annotations

import json
import sqlite3
import tempfile
import unittest
from pathlib import Path

from parallel_eval.benchmark.schema import (
    BenchmarkAttemptRecordV1,
    BenchmarkRunRecordV1,
    BenchmarkStepRecordV1,
    RunBudgetsV1,
    RunModelSettingsV1,
    RunProvenanceV1,
    TokenTotalsV1,
)
from parallel_eval.benchmark.summarize import build_summary_and_viewer


def _build_test_db(path: Path) -> None:
    conn = sqlite3.connect(path)
    cur = conn.cursor()
    cur.execute("CREATE TABLE core_articles (title TEXT PRIMARY KEY, links_json TEXT NOT NULL)")
    rows = {
        "Start": ["Target"],
        "Target": [],
        "HumanStart": ["HumanTarget"],
        "HumanTarget": [],
        "NoLinks": [],
    }
    for title, links in rows.items():
        cur.execute("INSERT INTO core_articles (title, links_json) VALUES (?, ?)", (title, json.dumps(links)))
    conn.commit()
    conn.close()


class SummarizeAnalysisTests(unittest.TestCase):
    def test_analysis_ignores_human_and_non_decision_steps(self):
        with tempfile.TemporaryDirectory() as td:
            td_path = Path(td)
            db_path = td_path / "test.db"
            _build_test_db(db_path)

            lines = [
                BenchmarkRunRecordV1(
                    run_id="llm_decision",
                    dataset_id="matchups/classic_local_v1/core_rank_v1",
                    matchup_id="m1",
                    tier="core_rank_v1",
                    suite_id="classic_local_v1",
                    slice_id="core_rank_v1",
                    setup_id="classic_local_v1",
                    prompt_version="choose_link_v1",
                    semantics_version="local_parity_v1",
                    start="Start",
                    target="Target",
                    started_at="2026-03-08T12:00:00Z",
                    finished_at="2026-03-08T12:00:01Z",
                    result="win",
                    hops=1,
                    duration_ms=1000,
                    llm_latency_ms=900,
                    model_settings=RunModelSettingsV1(model="model-llm", run_kind="llm"),
                    budgets=RunBudgetsV1(max_hops=20, max_links=None, max_tokens=None, max_tries=3),
                    totals=TokenTotalsV1(total_tokens=10),
                    provenance=RunProvenanceV1(db_path=str(db_path), db_sha256="sha"),
                ),
                BenchmarkAttemptRecordV1(
                    run_id="llm_decision",
                    hop=1,
                    try_index=0,
                    at="2026-03-08T12:00:00Z",
                    prompt_hash="a",
                    links_presented_count=1,
                    parse_error="bad_answer",
                ),
                BenchmarkAttemptRecordV1(
                    run_id="llm_decision",
                    hop=1,
                    try_index=1,
                    at="2026-03-08T12:00:01Z",
                    prompt_hash="b",
                    links_presented_count=1,
                    selected_index_parsed=1,
                    selected_title_parsed="Target",
                ),
                BenchmarkStepRecordV1(
                    run_id="llm_decision",
                    hop=1,
                    at="2026-03-08T12:00:01Z",
                    step_type="win",
                    article="Target",
                    current_article="Start",
                    selected_title="Target",
                    attempt_count=2,
                    choice={"selected_index": 1, "tries": 1, "answer_errors": ["bad_answer"]},
                ),
                BenchmarkRunRecordV1(
                    run_id="llm_nolinks",
                    dataset_id="matchups/classic_local_v1/core_rank_v1",
                    matchup_id="m2",
                    tier="core_rank_v1",
                    suite_id="classic_local_v1",
                    slice_id="core_rank_v1",
                    setup_id="classic_local_v1",
                    prompt_version="choose_link_v1",
                    semantics_version="local_parity_v1",
                    start="NoLinks",
                    target="Target",
                    started_at="2026-03-08T12:00:00Z",
                    finished_at="2026-03-08T12:00:01Z",
                    result="lose",
                    hops=1,
                    duration_ms=1000,
                    model_settings=RunModelSettingsV1(model="model-llm", run_kind="llm"),
                    budgets=RunBudgetsV1(max_hops=20, max_links=None, max_tokens=None, max_tries=3),
                    provenance=RunProvenanceV1(db_path=str(db_path), db_sha256="sha"),
                ),
                BenchmarkStepRecordV1(
                    run_id="llm_nolinks",
                    hop=1,
                    at="2026-03-08T12:00:01Z",
                    step_type="lose",
                    article="NoLinks",
                    current_article="NoLinks",
                    attempt_count=0,
                    meta={"reason": "no_links"},
                ),
                BenchmarkRunRecordV1(
                    run_id="human_run",
                    dataset_id="observed_app_races/session",
                    matchup_id="m3",
                    tier="observed",
                    start="HumanStart",
                    target="HumanTarget",
                    started_at="2026-03-08T12:00:00Z",
                    finished_at="2026-03-08T12:00:10Z",
                    result="win",
                    hops=1,
                    duration_ms=10000,
                    model_settings=RunModelSettingsV1(model="human/andrew", run_kind="human", player_name="Andrew"),
                    budgets=RunBudgetsV1(max_hops=20, max_links=None, max_tokens=None, max_tries=3),
                    provenance=RunProvenanceV1(db_path=str(db_path), db_sha256="sha"),
                ),
                BenchmarkStepRecordV1(
                    run_id="human_run",
                    hop=1,
                    at="2026-03-08T12:00:10Z",
                    step_type="win",
                    article="HumanTarget",
                    current_article="HumanStart",
                    selected_title="HumanTarget",
                    attempt_count=1,
                ),
            ]

            summary, _viewer = build_summary_and_viewer(
                lines=[type("Line", (), {"data": line.model_dump(mode="json"), "raw": ""}) for line in lines],
                source_jsonl="memory.jsonl",
            )

            analysis = summary["analysis"]["overall"]
            self.assertEqual(analysis["llm_steps"], 1)
            self.assertEqual(analysis["decision_steps"], 1)
            self.assertEqual(analysis["mean_attempt_count"], 2.0)
            self.assertEqual(analysis["retry_step_rate"], 1.0)
            self.assertEqual(analysis["revisit_rate"], 0.0)


if __name__ == "__main__":
    unittest.main()
