from __future__ import annotations

from collections import Counter
from functools import lru_cache
from pathlib import Path
from typing import Any, Optional

from parallel_eval.benchmark.graph import DegreeStats, compute_degrees
from parallel_eval.benchmark.utils import normalized_attempt_count


def _normalize_title(value: str) -> str:
    return value.replace("_", " ").strip().lower()


def _top_fraction_titles(
    degrees: dict[str, DegreeStats],
    *,
    fraction: float,
    value_fn,
) -> set[str]:
    if not degrees:
        return set()
    count = max(1, int(len(degrees) * fraction))
    ordered = sorted(degrees.items(), key=lambda item: (-value_fn(item[1]), item[0]))
    return {title for title, _stats in ordered[:count]}


@lru_cache(maxsize=8)
def _load_degree_context(db_path_str: str) -> tuple[dict[str, DegreeStats], set[str]]:
    degrees = compute_degrees(Path(db_path_str))
    hub_titles = _top_fraction_titles(degrees, fraction=0.01, value_fn=lambda stats: stats.out_degree) | _top_fraction_titles(
        degrees,
        fraction=0.01,
        value_fn=lambda stats: stats.in_degree,
    )
    return degrees, hub_titles


def _behavior_context(db_paths: set[str]) -> Optional[tuple[dict[str, DegreeStats], set[str]]]:
    if len(db_paths) != 1:
        return None
    db_path = next(iter(db_paths), "")
    if not db_path:
        return None
    try:
        return _load_degree_context(db_path)
    except Exception:
        return None


def _safe_attempt_count(step: dict[str, Any], attempt_count: Optional[int] = None) -> int:
    if isinstance(attempt_count, int) and attempt_count > 0:
        return attempt_count
    choice = step.get("choice") if isinstance(step.get("choice"), dict) else {}
    meta = step.get("meta") if isinstance(step.get("meta"), dict) else {}
    return normalized_attempt_count(
        attempt_count=step.get("attempt_count"),
        tries=choice.get("tries"),
        selected_index=choice.get("selected_index"),
        reason=meta.get("reason"),
        llm_output=meta.get("llm_output") or meta.get("llm_output_preview"),
        llm_outputs=meta.get("llm_outputs"),
        answer_errors=choice.get("answer_errors"),
    )


def _extract_reason(step: dict[str, Any]) -> Optional[str]:
    meta = step.get("meta")
    if isinstance(meta, dict):
        reason = meta.get("reason")
        if isinstance(reason, str) and reason:
            return reason
    return None


def _extract_preview(step: dict[str, Any]) -> Optional[str]:
    meta = step.get("meta")
    if not isinstance(meta, dict):
        return None
    for key in ("llm_output_preview", "llm_output", "message"):
        value = meta.get(key)
        if isinstance(value, str) and value.strip():
            return value.strip()
    llm_outputs = meta.get("llm_outputs")
    if isinstance(llm_outputs, list):
        for value in llm_outputs:
            if isinstance(value, str) and value.strip():
                return value.strip()
    return None


def _metric_rate(numerator: int, denominator: int) -> Optional[float]:
    if denominator <= 0:
        return None
    return float(numerator) / float(denominator)


def _example_payload(
    *,
    run: dict[str, Any],
    step: dict[str, Any],
    preview: Optional[str],
    category: str,
    selected_title: Optional[str] = None,
    attempt_count: Optional[int] = None,
) -> dict[str, Any]:
    return {
        "category": category,
        "run_id": run.get("run_id"),
        "matchup_id": run.get("matchup_id"),
        "slice_id": run.get("slice_id"),
        "start": run.get("start"),
        "target": run.get("target"),
        "current_article": step.get("current_article"),
        "selected_title": selected_title,
        "step_type": step.get("step_type"),
        "reason": _extract_reason(step),
        "attempt_count": _safe_attempt_count(step, attempt_count),
        "preview": preview,
    }


def _behavior_for_bucket(
    *,
    run_ids: list[str],
    runs: dict[str, dict[str, Any]],
    steps_by_run: dict[str, list[dict[str, Any]]],
    attempts_by_run: dict[str, list[dict[str, Any]]],
    context: Optional[tuple[dict[str, DegreeStats], set[str]]],
) -> dict[str, Any]:
    llm_steps = 0
    decision_steps = 0
    retry_steps = 0
    revisit_steps = 0
    bad_answer_steps = 0
    attempt_counts: list[int] = []
    hub_moves = 0
    dead_end_moves = 0

    retry_example: Optional[tuple[int, dict[str, Any]]] = None
    failure_example: Optional[dict[str, Any]] = None
    hub_example: Optional[dict[str, Any]] = None

    degrees = context[0] if context is not None else {}
    hub_titles = context[1] if context is not None else set()

    for run_id in run_ids:
        run = runs.get(run_id)
        if not run:
            continue
        model_settings = run.get("model_settings") if isinstance(run.get("model_settings"), dict) else {}
        run_kind = model_settings.get("run_kind")
        if isinstance(run_kind, str) and run_kind == "human":
            continue

        seen_titles = {_normalize_title(str(run.get("start") or ""))}
        attempt_counts_by_hop = Counter(
            int(attempt.get("hop") or 0) for attempt in (attempts_by_run.get(run_id) or [])
        )
        for step in steps_by_run.get(run_id) or []:
            hop = int(step.get("hop") or 0)
            attempt_count = _safe_attempt_count(step, attempt_counts_by_hop.get(hop))
            if attempt_count > 0:
                llm_steps += 1
                attempt_counts.append(attempt_count)
                if attempt_count > 1:
                    retry_steps += 1
            reason = _extract_reason(step)
            if reason == "bad_answer" and attempt_count > 0:
                bad_answer_steps += 1

            preview = _extract_preview(step)
            if attempt_count > 1 and preview:
                selected_title = step.get("selected_title")
                payload = _example_payload(
                    run=run,
                    step=step,
                    preview=preview,
                    category="retry_step",
                    selected_title=selected_title if isinstance(selected_title, str) and selected_title.strip() else None,
                    attempt_count=attempt_count,
                )
                score = attempt_count
                if retry_example is None or score > retry_example[0]:
                    retry_example = (score, payload)

            selected_title = step.get("selected_title")
            if not isinstance(selected_title, str) or not selected_title.strip():
                choice = step.get("choice") if isinstance(step.get("choice"), dict) else {}
                if isinstance(choice.get("selected_index"), int) and isinstance(step.get("article"), str):
                    selected_title = str(step.get("article"))
            if not isinstance(selected_title, str) or not selected_title.strip():
                article = step.get("article")
                if isinstance(article, str) and article.strip():
                    seen_titles.add(_normalize_title(article))
                continue

            decision_steps += 1
            normalized_selected = _normalize_title(selected_title)
            if normalized_selected in seen_titles:
                revisit_steps += 1

            stats = degrees.get(selected_title)
            if stats is not None:
                if selected_title in hub_titles:
                    hub_moves += 1
                    if hub_example is None and preview:
                        hub_example = _example_payload(
                            run=run,
                            step=step,
                            preview=preview,
                            category="hub_move",
                            selected_title=selected_title,
                            attempt_count=attempt_count,
                        )
                if stats.out_degree <= 2:
                    dead_end_moves += 1

            if step.get("step_type") == "lose" and failure_example is None:
                failure_example = _example_payload(
                    run=run,
                    step=step,
                    preview=preview,
                    category="failure_step",
                    selected_title=selected_title,
                    attempt_count=attempt_count,
                )

            article = step.get("article")
            if isinstance(article, str) and article.strip():
                seen_titles.add(_normalize_title(article))

    examples: dict[str, Any] = {}
    if retry_example is not None:
        examples["retry_step"] = retry_example[1]
    if failure_example is not None:
        examples["failure_step"] = failure_example
    if hub_example is not None:
        examples["hub_move"] = hub_example

    return {
        "llm_steps": llm_steps,
        "decision_steps": decision_steps,
        "mean_attempt_count": (sum(attempt_counts) / len(attempt_counts)) if attempt_counts else None,
        "retry_step_rate": _metric_rate(retry_steps, llm_steps),
        "bad_answer_step_rate": _metric_rate(bad_answer_steps, llm_steps),
        "revisit_rate": _metric_rate(revisit_steps, decision_steps),
        "hub_move_rate": _metric_rate(hub_moves, decision_steps),
        "dead_end_move_rate": _metric_rate(dead_end_moves, decision_steps),
        "examples": examples,
    }


def _slice_diagnostics(summary_slices: dict[str, dict[str, Any]]) -> dict[str, Any]:
    core_bucket = summary_slices.get("core_rank_v1") if isinstance(summary_slices, dict) else None
    core_win_rate = None
    if isinstance(core_bucket, dict):
        value = core_bucket.get("win_rate")
        if isinstance(value, (int, float)):
            core_win_rate = float(value)

    slices: dict[str, Any] = {}
    strongest_slice_id: Optional[str] = None
    strongest_delta: Optional[float] = None
    weakest_slice_id: Optional[str] = None
    weakest_delta: Optional[float] = None

    for slice_id, bucket in summary_slices.items():
        if not isinstance(bucket, dict):
            continue
        value = bucket.get("win_rate")
        if not isinstance(value, (int, float)):
            continue
        win_rate = float(value)
        delta_vs_core = (win_rate - core_win_rate) if core_win_rate is not None else None
        slices[slice_id] = {
            "win_rate": win_rate,
            "delta_vs_core": delta_vs_core,
        }
        if slice_id == "core_rank_v1" or delta_vs_core is None:
            continue
        if strongest_delta is None or delta_vs_core > strongest_delta:
            strongest_slice_id = slice_id
            strongest_delta = delta_vs_core
        if weakest_delta is None or delta_vs_core < weakest_delta:
            weakest_slice_id = slice_id
            weakest_delta = delta_vs_core

    return {
        "core_slice_id": "core_rank_v1" if "core_rank_v1" in slices else None,
        "strongest_slice_id": strongest_slice_id,
        "strongest_delta_vs_core": strongest_delta,
        "weakest_slice_id": weakest_slice_id,
        "weakest_delta_vs_core": weakest_delta,
        "slices": slices,
    }


def build_summary_analysis(
    *,
    runs: dict[str, dict[str, Any]],
    steps_by_run: dict[str, list[dict[str, Any]]],
    attempts_by_run: dict[str, list[dict[str, Any]]],
    all_run_ids: list[str],
    slice_run_ids: dict[str, list[str]],
    summary_slices: dict[str, dict[str, Any]],
    db_paths: set[str],
) -> dict[str, Any]:
    context = _behavior_context(db_paths)
    return {
        "overall": _behavior_for_bucket(
            run_ids=all_run_ids,
            runs=runs,
            steps_by_run=steps_by_run,
            attempts_by_run=attempts_by_run,
            context=context,
        ),
        "slices": {
            slice_id: _behavior_for_bucket(
                run_ids=run_ids,
                runs=runs,
                steps_by_run=steps_by_run,
                attempts_by_run=attempts_by_run,
                context=context,
            )
            for slice_id, run_ids in sorted(slice_run_ids.items())
        },
        "diagnostics": _slice_diagnostics(summary_slices),
    }
