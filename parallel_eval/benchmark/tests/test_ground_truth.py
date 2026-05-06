from __future__ import annotations

import json
import sqlite3
import tempfile
import unittest
from pathlib import Path

from parallel_eval.benchmark.ground_truth import compute_ground_truth_shortest_paths


def _create_test_db(path: Path, rows: dict[str, list[str]]) -> None:
    conn = sqlite3.connect(str(path))
    try:
        cur = conn.cursor()
        cur.execute("CREATE TABLE core_articles (title TEXT PRIMARY KEY, links_json TEXT NOT NULL)")
        for title, links in rows.items():
            cur.execute(
                "INSERT INTO core_articles (title, links_json) VALUES (?, ?)",
                (title, json.dumps(links, ensure_ascii=False)),
            )
        conn.commit()
    finally:
        conn.close()


def _write_dataset(path: Path, rows: list[dict[str, object]]) -> None:
    with open(path, "w", encoding="utf-8") as f:
        for row in rows:
            f.write(json.dumps(row, ensure_ascii=False) + "\n")


def _read_jsonl(path: Path) -> list[dict[str, object]]:
    out: list[dict[str, object]] = []
    with open(path, "r", encoding="utf-8") as f:
        for raw in f:
            raw = raw.strip()
            if raw:
                out.append(json.loads(raw))
    return out


class GroundTruthTests(unittest.TestCase):
    def test_compute_shortest_paths_writes_paths_and_meta(self):
        with tempfile.TemporaryDirectory() as td:
            root = Path(td)
            db_path = root / "wikihop.db"
            dataset_path = root / "dataset.jsonl"
            out_path = root / "out.jsonl"
            meta_path = root / "out.jsonl.meta.json"

            _create_test_db(
                db_path,
                {
                    "A": ["B", "C"],
                    "B": ["D"],
                    "C": ["D"],
                    "D": [],
                },
            )
            _write_dataset(
                dataset_path,
                [
                    {
                        "id": "m1",
                        "tier": "baseline",
                        "start": "A",
                        "target": "D",
                        "tags": ["nonhub", "dist=2"],
                        "shortest_path_hops": 2,
                    }
                ],
            )

            compute_ground_truth_shortest_paths(
                db_path=db_path,
                dataset_path=dataset_path,
                out_path=out_path,
                out_meta_path=meta_path,
                max_depth=10,
                max_nodes=10_000,
                overwrite_hops=False,
                search_mode="forward",
                cli_args={"test": True},
            )

            rows = _read_jsonl(out_path)
            self.assertEqual(len(rows), 1)
            self.assertEqual(rows[0]["shortest_path"], ["A", "B", "D"])
            self.assertEqual(rows[0]["shortest_path_hops"], 2)

            meta = json.loads(meta_path.read_text("utf-8"))
            self.assertEqual(meta["matchup_count"], 1)
            self.assertEqual(meta["search_mode"], "forward")
            self.assertEqual(meta["cli_args"]["test"], True)
            self.assertEqual(len(meta["db_sha256"]), 64)

    def test_mismatch_requires_overwrite(self):
        with tempfile.TemporaryDirectory() as td:
            root = Path(td)
            db_path = root / "wikihop.db"
            dataset_path = root / "dataset.jsonl"
            out_path = root / "out.jsonl"

            _create_test_db(db_path, {"A": ["B"], "B": ["D"], "D": []})
            _write_dataset(
                dataset_path,
                [
                    {
                        "id": "m1",
                        "tier": "baseline",
                        "start": "A",
                        "target": "D",
                        "tags": ["dist=3"],
                        "shortest_path_hops": 3,
                    }
                ],
            )

            with self.assertRaises(ValueError):
                compute_ground_truth_shortest_paths(
                    db_path=db_path,
                    dataset_path=dataset_path,
                    out_path=out_path,
                    out_meta_path=None,
                    max_depth=10,
                    max_nodes=10_000,
                    overwrite_hops=False,
                )

    def test_mismatch_overwrite_updates_hops_and_tags(self):
        with tempfile.TemporaryDirectory() as td:
            root = Path(td)
            db_path = root / "wikihop.db"
            dataset_path = root / "dataset.jsonl"
            out_path = root / "out.jsonl"

            _create_test_db(db_path, {"A": ["B"], "B": ["D"], "D": []})
            _write_dataset(
                dataset_path,
                [
                    {
                        "id": "m1",
                        "tier": "baseline",
                        "start": "A",
                        "target": "D",
                        "tags": ["dist=3", "nonhub"],
                        "shortest_path_hops": 3,
                    }
                ],
            )

            compute_ground_truth_shortest_paths(
                db_path=db_path,
                dataset_path=dataset_path,
                out_path=out_path,
                out_meta_path=None,
                max_depth=10,
                max_nodes=10_000,
                overwrite_hops=True,
            )

            rows = _read_jsonl(out_path)
            self.assertEqual(rows[0]["shortest_path_hops"], 2)
            self.assertIn("dist=2", rows[0]["tags"])
            self.assertEqual(rows[0]["shortest_path"], ["A", "B", "D"])

    def test_preflight_missing_titles(self):
        with tempfile.TemporaryDirectory() as td:
            root = Path(td)
            db_path = root / "wikihop.db"
            dataset_path = root / "dataset.jsonl"
            out_path = root / "out.jsonl"

            _create_test_db(db_path, {"A": ["B"], "B": []})
            _write_dataset(
                dataset_path,
                [
                    {
                        "id": "m1",
                        "tier": "baseline",
                        "start": "A",
                        "target": "Z",
                        "shortest_path_hops": 1,
                    }
                ],
            )

            with self.assertRaises(ValueError):
                compute_ground_truth_shortest_paths(
                    db_path=db_path,
                    dataset_path=dataset_path,
                    out_path=out_path,
                    out_meta_path=None,
                    max_depth=10,
                    max_nodes=10_000,
                    overwrite_hops=False,
                )

    def test_bidirectional_mode(self):
        with tempfile.TemporaryDirectory() as td:
            root = Path(td)
            db_path = root / "wikihop.db"
            dataset_path = root / "dataset.jsonl"
            out_path = root / "out.jsonl"

            _create_test_db(
                db_path,
                {
                    "A": ["B", "C"],
                    "B": ["D"],
                    "C": ["E"],
                    "D": [],
                    "E": ["D"],
                },
            )
            _write_dataset(
                dataset_path,
                [
                    {
                        "id": "m1",
                        "tier": "hard",
                        "start": "A",
                        "target": "D",
                        "shortest_path_hops": 2,
                    }
                ],
            )

            compute_ground_truth_shortest_paths(
                db_path=db_path,
                dataset_path=dataset_path,
                out_path=out_path,
                out_meta_path=None,
                max_depth=10,
                max_nodes=10_000,
                overwrite_hops=False,
                search_mode="bidirectional",
            )

            rows = _read_jsonl(out_path)
            self.assertEqual(rows[0]["shortest_path_hops"], 2)
            self.assertEqual(rows[0]["shortest_path"], ["A", "B", "D"])


if __name__ == "__main__":
    unittest.main()
