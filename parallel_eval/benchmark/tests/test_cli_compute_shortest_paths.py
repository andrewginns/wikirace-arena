from __future__ import annotations

import json
import sqlite3
import tempfile
import unittest
from pathlib import Path

from parallel_eval.benchmark.__main__ import main


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


class ComputeShortestPathsCliTests(unittest.TestCase):
    def test_compute_shortest_paths_cli_writes_output_and_meta(self):
        with tempfile.TemporaryDirectory() as td:
            root = Path(td)
            db_path = root / "wikihop.db"
            dataset_path = root / "dataset.jsonl"
            out_path = root / "out.jsonl"
            meta_path = root / "out.meta.json"

            _create_test_db(
                db_path,
                {
                    "A": ["B"],
                    "B": ["C"],
                    "C": [],
                },
            )
            _write_dataset(
                dataset_path,
                [
                    {
                        "id": "m1",
                        "tier": "baseline",
                        "start": "A",
                        "target": "C",
                        "tags": ["dist=2"],
                        "shortest_path_hops": 2,
                    }
                ],
            )

            rc = main(
                [
                    "compute-shortest-paths",
                    "--dataset",
                    str(dataset_path),
                    "--db-path",
                    str(db_path),
                    "--out",
                    str(out_path),
                    "--out-meta",
                    str(meta_path),
                    "--max-depth",
                    "10",
                    "--max-nodes",
                    "10000",
                    "--search-mode",
                    "bidirectional",
                ]
            )
            self.assertEqual(rc, 0)

            rows = [json.loads(line) for line in out_path.read_text("utf-8").splitlines() if line.strip()]
            self.assertEqual(rows[0]["shortest_path"], ["A", "B", "C"])
            meta = json.loads(meta_path.read_text("utf-8"))
            self.assertEqual(meta["search_mode"], "bidirectional")
            self.assertEqual(meta["cli_args"]["search_mode"], "bidirectional")

    def test_compute_shortest_paths_cli_overwrite_hops_behavior(self):
        with tempfile.TemporaryDirectory() as td:
            root = Path(td)
            db_path = root / "wikihop.db"
            dataset_path = root / "dataset.jsonl"
            out_path = root / "out.jsonl"

            _create_test_db(
                db_path,
                {
                    "A": ["B"],
                    "B": ["C"],
                    "C": [],
                },
            )
            _write_dataset(
                dataset_path,
                [
                    {
                        "id": "m1",
                        "tier": "baseline",
                        "start": "A",
                        "target": "C",
                        "tags": ["dist=3", "nonhub"],
                        "shortest_path_hops": 3,
                    }
                ],
            )

            with self.assertRaises(ValueError):
                main(
                    [
                        "compute-shortest-paths",
                        "--dataset",
                        str(dataset_path),
                        "--db-path",
                        str(db_path),
                        "--out",
                        str(out_path),
                        "--max-depth",
                        "10",
                    ]
                )

            rc = main(
                [
                    "compute-shortest-paths",
                    "--dataset",
                    str(dataset_path),
                    "--db-path",
                    str(db_path),
                    "--out",
                    str(out_path),
                    "--max-depth",
                    "10",
                    "--overwrite-hops",
                ]
            )
            self.assertEqual(rc, 0)
            rows = [json.loads(line) for line in out_path.read_text("utf-8").splitlines() if line.strip()]
            self.assertEqual(rows[0]["shortest_path_hops"], 2)
            self.assertIn("dist=2", rows[0]["tags"])


if __name__ == "__main__":
    unittest.main()
