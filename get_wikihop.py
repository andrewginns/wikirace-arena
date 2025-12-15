import argparse
import json
import sqlite3
from pathlib import Path

from datasets import load_dataset
from tqdm import tqdm


DEFAULT_DATASET = "HuggingFaceTB/simplewiki-pruned-350k"
DEFAULT_OUTPUT = Path("parallel_eval") / "wikihop.db"


def build_db(*, dataset_id: str, output_path: Path, overwrite: bool) -> None:
    output_path = output_path.resolve()
    output_path.parent.mkdir(parents=True, exist_ok=True)

    if output_path.exists():
        if overwrite:
            output_path.unlink()
        else:
            raise FileExistsError(
                f"Refusing to overwrite existing file: {output_path} (use --overwrite)"
            )

    dataset = load_dataset(dataset_id, split="train")

    conn = sqlite3.connect(str(output_path))
    cursor = conn.cursor()

    cursor.execute(
        """
        CREATE TABLE IF NOT EXISTS core_articles (
            title TEXT PRIMARY KEY,
            links_json TEXT NOT NULL
        )
        """
    )
    cursor.execute("PRAGMA journal_mode = WAL")
    cursor.execute("PRAGMA synchronous = NORMAL")

    batch: list[tuple[str, str]] = []
    batch_size = 1000

    for example in tqdm(dataset, total=len(dataset), desc="Writing core_articles"):
        title = example["article"]
        links_json = json.dumps(example["links"], ensure_ascii=False)
        batch.append((title, links_json))

        if len(batch) >= batch_size:
            cursor.executemany(
                "INSERT OR REPLACE INTO core_articles (title, links_json) VALUES (?, ?)",
                batch,
            )
            batch.clear()

    if batch:
        cursor.executemany(
            "INSERT OR REPLACE INTO core_articles (title, links_json) VALUES (?, ?)",
            batch,
        )

    conn.commit()
    conn.close()

    # Sanity check: ensure the DB is readable and has the expected table.
    conn = sqlite3.connect(str(output_path))
    cursor = conn.cursor()
    cursor.execute("SELECT COUNT(*) FROM core_articles")
    article_count = cursor.fetchone()[0]
    conn.close()

    print(f"Wrote {article_count} articles to {output_path}")


def main() -> None:
    parser = argparse.ArgumentParser(
        description="Build wikihop.db from the pruned Simple Wikipedia dataset"
    )
    parser.add_argument(
        "--dataset",
        default=DEFAULT_DATASET,
        help=f"Hugging Face dataset id (default: {DEFAULT_DATASET})",
    )
    parser.add_argument(
        "--output",
        type=Path,
        default=DEFAULT_OUTPUT,
        help=f"Output path for the SQLite DB (default: {DEFAULT_OUTPUT})",
    )
    parser.add_argument(
        "--overwrite",
        action="store_true",
        help="Overwrite the output file if it already exists",
    )
    args = parser.parse_args()

    build_db(dataset_id=args.dataset, output_path=args.output, overwrite=args.overwrite)


if __name__ == "__main__":
    main()
