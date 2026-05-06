from __future__ import annotations

import hashlib
from pathlib import Path
from typing import TYPE_CHECKING, Any, Iterable, Optional

if TYPE_CHECKING:
    from parallel_eval.benchmark.schema import MatchupV1


def sha256_hex(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as f:
        for chunk in iter(lambda: f.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def benchmark_dataset_id(dataset_path: Path, matchups: Iterable["MatchupV1"]) -> str:
    rows = list(matchups)
    if not rows:
        return f"matchups/{dataset_path.stem}"

    suite_ids = {
        matchup.suite_id.strip()
        for matchup in rows
        if isinstance(matchup.suite_id, str) and matchup.suite_id.strip()
    }
    slice_ids = {
        matchup.slice_id.strip()
        for matchup in rows
        if isinstance(matchup.slice_id, str) and matchup.slice_id.strip()
    }

    if len(suite_ids) == 1:
        suite_id = next(iter(suite_ids))
        if len(slice_ids) == 1:
            return f"matchups/{suite_id}/{next(iter(slice_ids))}"
        return f"matchups/{suite_id}/all"

    return f"matchups/{dataset_path.stem}"


def retries_from_attempt_count(attempt_count: Optional[int]) -> int:
    if not isinstance(attempt_count, int) or attempt_count <= 0:
        return 0
    return max(attempt_count - 1, 0)


def normalized_attempt_count(
    *,
    attempt_count: Any = None,
    tries: Any = None,
    selected_index: Any = None,
    reason: Any = None,
    llm_output: Any = None,
    llm_outputs: Any = None,
    answer_errors: Any = None,
) -> int:
    if isinstance(attempt_count, int) and attempt_count > 0:
        return attempt_count

    if isinstance(llm_outputs, list) and llm_outputs:
        string_outputs = [value for value in llm_outputs if isinstance(value, str) and value.strip()]
        if string_outputs:
            return len(string_outputs)

    tries_value = tries if isinstance(tries, int) and tries >= 0 else None
    has_selected_index = isinstance(selected_index, int) and selected_index > 0
    reason_value = reason.strip() if isinstance(reason, str) else None
    has_llm_output = isinstance(llm_output, str) and llm_output.strip()
    has_answer_errors = isinstance(answer_errors, list) and any(
        isinstance(value, str) and value.strip() for value in answer_errors
    )
    has_llm_activity = bool(has_selected_index or has_llm_output or has_answer_errors)

    if tries_value is None:
        return 1 if has_llm_activity else 0

    if reason_value in {"bad_answer", "llm_error"} and has_llm_activity:
        return max(tries_value, 1)

    # App exports use retry-count semantics on success.
    if has_selected_index:
        return tries_value + 1

    # App exports use attempt-count semantics on exhausted failure.
    if has_llm_activity:
        return max(tries_value, 1)

    return 0
