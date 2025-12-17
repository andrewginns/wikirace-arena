"""Build `wikihop.db` from Wikimedia SQL dumps (no scraping).

This script converts MediaWiki SQL dump files into the DB format used by this repo:

    core_articles(title TEXT PRIMARY KEY, links_json TEXT NOT NULL)

It uses the wiki's `page` table for node titles and the `pagelinks` table for edges.
Modern dumps store pagelink targets via `pl_target_id`, which requires the `linktarget`
table; older dumps store targets via `pl_namespace`/`pl_title`.

Recommended usage (Simple Wikipedia, latest dump):

    uv run python get_wikihop.py --wiki simplewiki --dump-date latest \
      --output parallel_eval/wikihop.db --overwrite --download

You can also point at already-downloaded dump files via --dump-dir.
"""

from __future__ import annotations

import argparse
import gzip
import json
import sqlite3
import sys
import urllib.request
from dataclasses import dataclass
from pathlib import Path
from typing import Dict, Iterable, Iterator, List, Optional, Sequence, Set, Tuple

try:
    from tqdm import tqdm  # type: ignore

    def _progress_bar(*, total_bytes: int, desc: str):
        return tqdm(total=total_bytes, unit="B", unit_scale=True, desc=desc)

except Exception:  # pragma: no cover

    def tqdm(iterable, *args, **kwargs):  # type: ignore
        return iterable

    class _NoopProgressBar:
        def update(self, _n: int) -> None:
            return

        def close(self) -> None:
            return

    def _progress_bar(*, total_bytes: int, desc: str):
        return _NoopProgressBar()


DEFAULT_WIKI = "simplewiki"
DEFAULT_DUMP_DATE = "latest"
DEFAULT_OUTPUT = Path("parallel_eval") / "wikihop.db"
DEFAULT_DUMP_DIR = Path("parallel_eval") / "wikimedia_dumps"


@dataclass(frozen=True)
class DumpFiles:
    page: Path
    pagelinks: Path
    linktarget: Optional[Path]


def normalize_title(title: str) -> str:
    # MediaWiki stores underscores in DB titles; this codebase expects spaces.
    return title.replace("_", " ")


def _open_gzip_text(path: Path):
    return gzip.open(path, mode="rt", encoding="utf-8", errors="replace")


def _download_file(url: str, dest_path: Path) -> None:
    dest_path.parent.mkdir(parents=True, exist_ok=True)
    tmp_path = dest_path.with_suffix(dest_path.suffix + ".part")

    with urllib.request.urlopen(url) as resp:
        total = resp.headers.get("Content-Length")
        total_bytes = int(total) if total and total.isdigit() else None
        with open(tmp_path, "wb") as f:
            if total_bytes is None:
                while True:
                    chunk = resp.read(1024 * 1024)
                    if not chunk:
                        break
                    f.write(chunk)
            else:
                pbar = _progress_bar(total_bytes=total_bytes, desc=dest_path.name)
                try:
                    while True:
                        chunk = resp.read(1024 * 1024)
                        if not chunk:
                            break
                        f.write(chunk)
                        pbar.update(len(chunk))
                finally:
                    pbar.close()

    tmp_path.replace(dest_path)


def _dump_base_url(*, wiki: str, dump_date: str) -> str:
    return f"https://dumps.wikimedia.org/{wiki}/{dump_date}/"


def _dump_filename(*, wiki: str, dump_date: str, table: str) -> str:
    return f"{wiki}-{dump_date}-{table}.sql.gz"


def _ensure_dump_file(*, url: str, local_path: Path, download: bool) -> None:
    if local_path.exists():
        return
    if not download:
        raise FileNotFoundError(
            f"Missing dump file: {local_path}\n"
            f"Either download it from {url} or pass --download to fetch automatically."
        )
    print(f"Downloading {url} -> {local_path}")
    _download_file(url, local_path)


def resolve_dump_files(
    *,
    wiki: str,
    dump_date: str,
    dump_dir: Path,
    download: bool,
) -> DumpFiles:
    base_url = _dump_base_url(wiki=wiki, dump_date=dump_date)

    page_name = _dump_filename(wiki=wiki, dump_date=dump_date, table="page")
    pagelinks_name = _dump_filename(wiki=wiki, dump_date=dump_date, table="pagelinks")
    linktarget_name = _dump_filename(wiki=wiki, dump_date=dump_date, table="linktarget")

    page_path = dump_dir / wiki / dump_date / page_name
    pagelinks_path = dump_dir / wiki / dump_date / pagelinks_name
    linktarget_path = dump_dir / wiki / dump_date / linktarget_name

    _ensure_dump_file(url=base_url + page_name, local_path=page_path, download=download)
    _ensure_dump_file(
        url=base_url + pagelinks_name, local_path=pagelinks_path, download=download
    )

    # linktarget is only required for newer pagelinks schemas; we check later.
    if download:
        # Pre-fetch linktarget if available; if it 404s we'll fall back to old schema.
        try:
            _ensure_dump_file(
                url=base_url + linktarget_name,
                local_path=linktarget_path,
                download=download,
            )
        except Exception:
            linktarget_path = None
    else:
        linktarget_path = linktarget_path if linktarget_path.exists() else None

    return DumpFiles(page=page_path, pagelinks=pagelinks_path, linktarget=linktarget_path)


def _read_table_columns(path: Path, table: str) -> List[str]:
    """Return column names in CREATE TABLE order for `table` within a dump."""
    in_table = False
    columns: List[str] = []
    create_prefix = "CREATE TABLE"
    needle = f"`{table}`"

    with _open_gzip_text(path) as f:
        for line in f:
            if not in_table:
                if line.startswith(create_prefix) and needle in line:
                    in_table = True
                continue

            stripped = line.lstrip()
            if stripped.startswith(")"):
                break

            if not stripped.startswith("`"):
                continue
            # Column lines look like:   `page_id` int(8) unsigned NOT NULL,
            end = stripped.find("`", 1)
            if end == -1:
                continue
            columns.append(stripped[1:end])

    if not columns:
        raise ValueError(f"Could not find CREATE TABLE columns for `{table}` in {path}")
    return columns


def _iter_insert_rows(path: Path, table: str) -> Iterator[List[Optional[str]]]:
    """Yield parsed rows from INSERT statements for the given table.

    Values are returned as raw strings (unquoted/escaped) or None for NULL.
    """

    insert_prefix = f"INSERT INTO `{table}` VALUES "
    with _open_gzip_text(path) as f:
        for line in f:
            if not line.startswith(insert_prefix):
                continue

            statement = [line]
            while not statement[-1].rstrip().endswith(";"):
                nxt = next(f)
                statement.append(nxt)
            sql = "".join(statement)
            values_start = sql.find("VALUES")
            if values_start == -1:
                continue
            values_text = sql[values_start + len("VALUES") :].lstrip()
            yield from _parse_values_list(values_text)


def _parse_values_list(values_text: str) -> Iterator[List[Optional[str]]]:
    i = 0
    n = len(values_text)
    while i < n:
        # Skip whitespace and commas between tuples.
        while i < n and values_text[i] in " \t\r\n,":
            i += 1
        if i >= n or values_text[i] == ";":
            return
        if values_text[i] != "(":
            raise ValueError(f"Expected '(' at position {i}")
        i += 1

        row: List[Optional[str]] = []
        while True:
            while i < n and values_text[i] in " \t\r\n":
                i += 1
            value, i = _parse_value(values_text, i)
            row.append(value)

            while i < n and values_text[i] in " \t\r\n":
                i += 1
            if i >= n:
                raise ValueError("Unexpected EOF while parsing tuple")
            if values_text[i] == ",":
                i += 1
                continue
            if values_text[i] == ")":
                i += 1
                break
            raise ValueError(
                f"Unexpected character while parsing tuple: {values_text[i]!r}"
            )

        yield row

        while i < n and values_text[i] in " \t\r\n":
            i += 1
        if i < n and values_text[i] == ",":
            i += 1
            continue
        if i < n and values_text[i] == ";":
            return


def _parse_value(s: str, i: int) -> Tuple[Optional[str], int]:
    if i >= len(s):
        raise ValueError("Unexpected EOF while parsing value")
    if s[i] == "'":
        return _parse_quoted_string(s, i + 1)

    start = i
    while i < len(s) and s[i] not in ",)":
        i += 1
    token = s[start:i].strip()
    if token.upper() == "NULL":
        return None, i
    return token, i


def _parse_quoted_string(s: str, i: int) -> Tuple[str, int]:
    out: List[str] = []
    while i < len(s):
        c = s[i]
        if c == "\\":
            if i + 1 >= len(s):
                out.append("\\")
                return "".join(out), i + 1
            nxt = s[i + 1]
            out.append(_unescape_mysql_char(nxt))
            i += 2
            continue

        if c == "'":
            # MySQL can escape single quotes as '' (two quotes).
            if i + 1 < len(s) and s[i + 1] == "'":
                out.append("'")
                i += 2
                continue
            return "".join(out), i + 1

        out.append(c)
        i += 1
    raise ValueError("Unterminated quoted string")


def _unescape_mysql_char(c: str) -> str:
    if c == "0":
        return "\x00"
    if c == "b":
        return "\b"
    if c == "n":
        return "\n"
    if c == "r":
        return "\r"
    if c == "t":
        return "\t"
    if c == "Z":
        return "\x1a"
    return c


def _require_columns(columns: Sequence[str], required: Sequence[str], *, table: str) -> None:
    missing = [name for name in required if name not in columns]
    if missing:
        raise ValueError(f"Missing columns in `{table}`: {missing}. Found: {list(columns)}")


def _load_page_titles(page_dump: Path) -> Tuple[Dict[int, str], Set[str]]:
    columns = _read_table_columns(page_dump, "page")
    _require_columns(columns, ["page_id", "page_namespace", "page_title"], table="page")
    idx = {name: i for i, name in enumerate(columns)}

    page_id_to_title: Dict[int, str] = {}
    titles: Set[str] = set()

    for row in tqdm(_iter_insert_rows(page_dump, "page"), desc="Reading page"):
        page_id = int(row[idx["page_id"]] or 0)
        namespace = int(row[idx["page_namespace"]] or 0)
        if namespace != 0:
            continue
        title_raw = row[idx["page_title"]] or ""
        title = normalize_title(title_raw)
        page_id_to_title[page_id] = title
        titles.add(title)

    return page_id_to_title, titles


def _detect_pagelinks_schema(pagelinks_dump: Path) -> Tuple[List[str], str]:
    columns = _read_table_columns(pagelinks_dump, "pagelinks")
    if "pl_target_id" in columns:
        return columns, "target_id"
    if "pl_namespace" in columns and "pl_title" in columns:
        return columns, "namespace_title"
    raise ValueError(
        "Unsupported pagelinks schema: expected either pl_target_id or (pl_namespace, pl_title). "
        f"Columns: {columns}"
    )


def _load_linktargets(linktarget_dump: Path) -> Dict[int, str]:
    columns = _read_table_columns(linktarget_dump, "linktarget")
    _require_columns(columns, ["lt_id", "lt_namespace", "lt_title"], table="linktarget")
    idx = {name: i for i, name in enumerate(columns)}

    target_id_to_title: Dict[int, str] = {}
    for row in tqdm(_iter_insert_rows(linktarget_dump, "linktarget"), desc="Reading linktarget"):
        lt_id = int(row[idx["lt_id"]] or 0)
        namespace = int(row[idx["lt_namespace"]] or 0)
        if namespace != 0:
            continue
        title_raw = row[idx["lt_title"]] or ""
        target_id_to_title[lt_id] = normalize_title(title_raw)
    return target_id_to_title


def _init_sqlite_db(conn: sqlite3.Connection) -> None:
    cursor = conn.cursor()
    cursor.execute(
        """
        CREATE TABLE IF NOT EXISTS core_articles (
            title TEXT PRIMARY KEY,
            links_json TEXT NOT NULL
        );
        """
    )
    cursor.execute("PRAGMA journal_mode = WAL")
    cursor.execute("PRAGMA synchronous = NORMAL")
    conn.commit()


def _prepopulate_articles(
    *,
    conn: sqlite3.Connection,
    titles: Iterable[str],
    batch_size: int = 5000,
) -> None:
    cursor = conn.cursor()
    batch: List[Tuple[str, str]] = []
    total = len(titles) if hasattr(titles, "__len__") else None
    for title in tqdm(titles, total=total, desc="Prepopulating core_articles"):
        batch.append((title, "[]"))
        if len(batch) >= batch_size:
            cursor.executemany(
                "INSERT OR IGNORE INTO core_articles (title, links_json) VALUES (?, ?)",
                batch,
            )
            batch.clear()
    if batch:
        cursor.executemany(
            "INSERT OR IGNORE INTO core_articles (title, links_json) VALUES (?, ?)",
            batch,
        )
    conn.commit()


def _write_pagelinks(
    *,
    conn: sqlite3.Connection,
    pagelinks_dump: Path,
    page_id_to_title: Dict[int, str],
    valid_titles: Set[str],
    target_id_to_title: Optional[Dict[int, str]],
    sort_links: bool,
    batch_size: int = 2000,
) -> None:
    columns, schema_kind = _detect_pagelinks_schema(pagelinks_dump)
    idx = {name: i for i, name in enumerate(columns)}
    _require_columns(columns, ["pl_from"], table="pagelinks")

    if schema_kind == "target_id" and target_id_to_title is None:
        raise ValueError("pagelinks uses pl_target_id but linktarget mapping was not loaded")

    cursor = conn.cursor()

    cursor.execute("DROP TABLE IF EXISTS tmp_edges")
    cursor.execute(
        """
        CREATE TEMP TABLE tmp_edges (
            from_title TEXT NOT NULL,
            to_title TEXT NOT NULL,
            to_title_json TEXT NOT NULL,
            seq INTEGER NOT NULL,
            PRIMARY KEY (from_title, to_title)
        ) WITHOUT ROWID;
        """
    )
    conn.commit()

    edge_batch: List[Tuple[str, str, str, int]] = []
    seq = 0

    for row in tqdm(_iter_insert_rows(pagelinks_dump, "pagelinks"), desc="Reading pagelinks"):
        from_id = int(row[idx["pl_from"]] or 0)
        from_title = page_id_to_title.get(from_id)
        if from_title is None:
            continue

        target_title: Optional[str] = None
        if schema_kind == "target_id":
            target_id = int(row[idx["pl_target_id"]] or 0)
            target_title = (target_id_to_title or {}).get(target_id)
        else:
            target_ns = int(row[idx["pl_namespace"]] or 0)
            if target_ns != 0:
                continue
            target_raw = row[idx["pl_title"]]
            target_title = normalize_title(target_raw or "")

        if not target_title or target_title not in valid_titles:
            continue
        if target_title == from_title:
            continue

        seq += 1
        edge_batch.append(
            (from_title, target_title, json.dumps(target_title, ensure_ascii=False), seq)
        )
        if len(edge_batch) >= batch_size:
            cursor.executemany(
                "INSERT OR IGNORE INTO tmp_edges (from_title, to_title, to_title_json, seq) VALUES (?, ?, ?, ?)",
                edge_batch,
            )
            edge_batch.clear()

    if edge_batch:
        cursor.executemany(
            "INSERT OR IGNORE INTO tmp_edges (from_title, to_title, to_title_json, seq) VALUES (?, ?, ?, ?)",
            edge_batch,
        )
        edge_batch.clear()
    conn.commit()

    cursor.execute("DROP TABLE IF EXISTS tmp_links")
    cursor.execute(
        """
        CREATE TEMP TABLE tmp_links (
            title TEXT PRIMARY KEY,
            links_json TEXT NOT NULL
        ) WITHOUT ROWID;
        """
    )
    conn.commit()

    order_column = "to_title" if sort_links else "seq"
    cursor.execute(
        f"""
        INSERT INTO tmp_links (title, links_json)
        SELECT from_title, links_json
        FROM (
            SELECT
                from_title,
                '[' ||
                    group_concat(to_title_json) OVER (
                        PARTITION BY from_title
                        ORDER BY {order_column}
                    )
                || ']' AS links_json,
                ROW_NUMBER() OVER (
                    PARTITION BY from_title
                    ORDER BY {order_column} DESC
                ) AS rn
            FROM tmp_edges
        )
        WHERE rn = 1;
        """
    )
    conn.commit()

    cursor.execute(
        """
        UPDATE core_articles
        SET links_json = (
            SELECT tmp_links.links_json
            FROM tmp_links
            WHERE tmp_links.title = core_articles.title
        )
        WHERE title IN (SELECT title FROM tmp_links);
        """
    )
    conn.commit()

    cursor.execute("DROP TABLE tmp_edges")
    cursor.execute("DROP TABLE tmp_links")
    conn.commit()


def build_db_from_dumps(
    *,
    wiki: str,
    dump_date: str,
    dump_dir: Path,
    output_path: Path,
    overwrite: bool,
    download: bool,
    sort_links: bool,
) -> None:
    output_path = output_path.resolve()
    output_path.parent.mkdir(parents=True, exist_ok=True)

    if output_path.exists():
        if overwrite:
            output_path.unlink()
        else:
            raise FileExistsError(
                f"Refusing to overwrite existing file: {output_path} (use --overwrite)"
            )

    files = resolve_dump_files(wiki=wiki, dump_date=dump_date, dump_dir=dump_dir, download=download)

    page_id_to_title, titles = _load_page_titles(files.page)
    print(f"Loaded {len(page_id_to_title):,} namespace-0 pages")

    _, pagelinks_schema = _detect_pagelinks_schema(files.pagelinks)
    target_id_to_title: Optional[Dict[int, str]] = None
    if pagelinks_schema == "target_id":
        if files.linktarget is None:
            raise FileNotFoundError(
                "pagelinks uses pl_target_id, but linktarget dump file is missing. "
                "Re-run with --download or provide the file in --dump-dir."
            )
        target_id_to_title = _load_linktargets(files.linktarget)
        print(f"Loaded {len(target_id_to_title):,} namespace-0 linktargets")

    conn = sqlite3.connect(str(output_path))
    try:
        _init_sqlite_db(conn)
        _prepopulate_articles(conn=conn, titles=titles)
        _write_pagelinks(
            conn=conn,
            pagelinks_dump=files.pagelinks,
            page_id_to_title=page_id_to_title,
            valid_titles=titles,
            target_id_to_title=target_id_to_title,
            sort_links=sort_links,
        )
    finally:
        conn.close()

    conn = sqlite3.connect(str(output_path))
    try:
        cursor = conn.cursor()
        cursor.execute("SELECT COUNT(*) FROM core_articles")
        article_count = cursor.fetchone()[0]
    finally:
        conn.close()
    print(f"Wrote {article_count} articles to {output_path}")


def main() -> None:
    parser = argparse.ArgumentParser(
        description="Build wikihop.db from Wikimedia SQL dumps (no scraping)"
    )
    parser.add_argument(
        "--wiki",
        default=DEFAULT_WIKI,
        help=f"Wiki code (default: {DEFAULT_WIKI}, e.g. simplewiki, enwiki)",
    )
    parser.add_argument(
        "--dump-date",
        default=DEFAULT_DUMP_DATE,
        help=(
            "Dump date directory on dumps.wikimedia.org (default: latest). "
            "You can also pass a YYYYMMDD date."
        ),
    )
    parser.add_argument(
        "--dump-dir",
        type=Path,
        default=DEFAULT_DUMP_DIR,
        help=(
            f"Directory to store/read dump files (default: {DEFAULT_DUMP_DIR}). "
            "Files are stored under <dump-dir>/<wiki>/<dump-date>/"
        ),
    )
    parser.add_argument(
        "--download",
        action="store_true",
        help="Download missing dump files from dumps.wikimedia.org",
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
    parser.add_argument(
        "--sort-links",
        action="store_true",
        help="Sort outgoing link titles alphabetically (default is dump/first-seen order)",
    )
    args = parser.parse_args()

    try:
        build_db_from_dumps(
            wiki=args.wiki,
            dump_date=args.dump_date,
            dump_dir=args.dump_dir,
            output_path=args.output,
            overwrite=args.overwrite,
            download=args.download,
            sort_links=args.sort_links,
        )
    except KeyboardInterrupt:
        print("Interrupted", file=sys.stderr)
        raise


if __name__ == "__main__":
    main()

