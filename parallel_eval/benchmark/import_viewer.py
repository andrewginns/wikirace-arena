from __future__ import annotations

import json
import os
import tempfile
import uuid
import warnings
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Optional

from parallel_eval.benchmark.schema import (
    BenchmarkRunRecordV1,
    BenchmarkStepRecordV1,
    MatchupV1,
    RunBudgetsV1,
    RunModelSettingsV1,
    RunProvenanceV1,
    TokenTotalsV1,
    write_jsonl_line,
)
from parallel_eval.benchmark.semantics import hop_rows_from_steps, titles_match
from parallel_eval.benchmark.utils import benchmark_dataset_id, normalized_attempt_count, retries_from_attempt_count


def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")


def _safe_int(value: Any) -> Optional[int]:
    if isinstance(value, bool):
        return None
    if isinstance(value, int):
        return value
    return None


def _usage_from_meta(meta: dict[str, Any]) -> tuple[Optional[int], Optional[int], Optional[int]]:
    prompt_tokens = _safe_int(meta.get("prompt_tokens"))
    if not isinstance(prompt_tokens, int):
        prompt_tokens = _safe_int(meta.get("input_tokens"))

    completion_tokens = _safe_int(meta.get("completion_tokens"))
    if not isinstance(completion_tokens, int):
        completion_tokens = _safe_int(meta.get("output_tokens"))

    total_tokens = _safe_int(meta.get("total_tokens"))
    if not isinstance(total_tokens, int) and (
        isinstance(prompt_tokens, int) or isinstance(completion_tokens, int)
    ):
        total_tokens = (prompt_tokens or 0) + (completion_tokens or 0)

    return prompt_tokens, completion_tokens, total_tokens


def _latency_ms_from_meta(meta: dict[str, Any]) -> Optional[int]:
    latency_ms = _safe_int(meta.get("latency_ms"))
    if not isinstance(latency_ms, int):
        latency_ms = _safe_int(meta.get("duration_ms"))
    return latency_ms


def _result_from_run_object(
    run_obj: dict[str, Any],
    terminal_step_type: Any,
) -> tuple[Optional[str], Optional[str]]:
    if terminal_step_type == "win":
        return "win", None
    if terminal_step_type == "lose":
        return "lose", None

    legacy_result = run_obj.get("result")
    if legacy_result == "win":
        return "win", "legacy_result"
    if legacy_result in ("lose", "abandoned"):
        return "lose", "legacy_result"
    return None, None


def _sum_usage_from_steps(steps: list[dict[str, Any]]) -> TokenTotalsV1:
    prompt = 0
    completion = 0
    total = 0
    saw_prompt = False
    saw_completion = False
    saw_total = False

    for step in steps:
        meta = step.get("metadata")
        if not isinstance(meta, dict):
            continue

        p, c, t = _usage_from_meta(meta)

        if isinstance(p, int):
            prompt += p
            saw_prompt = True
        if isinstance(c, int):
            completion += c
            saw_completion = True

        if isinstance(t, int):
            total += t
            saw_total = True
        elif isinstance(p, int) or isinstance(c, int):
            total += (p or 0) + (c or 0)
            saw_total = True

    return TokenTotalsV1(
        prompt_tokens=prompt if saw_prompt else None,
        completion_tokens=completion if saw_completion else None,
        total_tokens=total if saw_total else None,
    )


def _sum_latency_ms_from_steps(steps: list[dict[str, Any]]) -> Optional[int]:
    total = 0
    saw = False
    for step in steps:
        meta = step.get("metadata")
        if not isinstance(meta, dict):
            continue
        latency = _latency_ms_from_meta(meta)
        if isinstance(latency, int):
            total += latency
            saw = True
    return total if saw else None


def _duration_ms_from_step_ats(steps: list[dict[str, Any]]) -> Optional[int]:
    ats: list[str] = []
    for step in steps:
        at = step.get("at")
        if isinstance(at, str) and at:
            ats.append(at)
    if len(ats) < 2:
        return None
    try:
        start = datetime.fromisoformat(ats[0].replace("Z", "+00:00"))
        end = datetime.fromisoformat(ats[-1].replace("Z", "+00:00"))
    except Exception:
        return None
    return max(0, int((end - start).total_seconds() * 1000))


def _load_dataset(dataset_path: Path) -> dict[tuple[str, str], MatchupV1]:
    mapping: dict[tuple[str, str], MatchupV1] = {}
    with open(dataset_path, "r", encoding="utf-8") as f:
        for raw in f:
            raw = raw.strip()
            if not raw:
                continue
            data = json.loads(raw)
            matchup = MatchupV1.model_validate(data)
            mapping[(matchup.start, matchup.target)] = matchup
    return mapping


def _run_label(run_obj: dict[str, Any], start: str, target: str) -> str:
    run_label = run_obj.get("id")
    if isinstance(run_label, str) and run_label.strip():
        return run_label
    return f"{start}->{target}"


def _normalize_viewer_steps(steps: list[Any], start: str) -> list[dict[str, Any]]:
    normalized: list[dict[str, Any]] = []
    for step in steps:
        if isinstance(step, dict):
            normalized.append(step)
            continue
        if isinstance(step, str) and step.strip():
            step_type = "start" if not normalized and titles_match(step, start) else "move"
            normalized.append({"type": step_type, "article": step})
    return normalized


def _paths_alias(a: Path, b: Path) -> bool:
    return a.expanduser().resolve(strict=False) == b.expanduser().resolve(strict=False)


def _prepare_output_write(*, source_path: Path, out_path: Path, overwrite: bool) -> Path:
    if _paths_alias(source_path, out_path):
        raise ValueError("Input and output paths must be different.")

    if out_path.exists() and not overwrite:
        raise FileExistsError(f"Output already exists: {out_path} (use --overwrite or pick a new path)")

    out_path.parent.mkdir(parents=True, exist_ok=True)
    fd, temp_name = tempfile.mkstemp(
        prefix=f".{out_path.name}.",
        suffix=".tmp",
        dir=out_path.parent,
        text=True,
    )
    os.close(fd)
    return Path(temp_name)


def import_viewer_json(
    *,
    viewer_json_path: Path,
    dataset_path: Optional[Path],
    dataset_id: Optional[str],
    out_path: Path,
    overwrite: bool,
) -> None:
    raw = json.loads(viewer_json_path.read_text("utf-8"))
    if not isinstance(raw, dict) or not isinstance(raw.get("runs"), list):
        raise ValueError("Viewer JSON must be an object with a top-level 'runs' array.")

    dataset = _load_dataset(dataset_path) if dataset_path else {}
    dataset_label = (
        dataset_id
        if isinstance(dataset_id, str) and dataset_id.strip()
        else benchmark_dataset_id(dataset_path, dataset.values()) if dataset_path else "viewer"
    )
    skipped_invalid_step_runs: list[str] = []
    skipped_nonterminal_runs: list[str] = []
    temp_out_path = _prepare_output_write(
        source_path=viewer_json_path,
        out_path=out_path,
        overwrite=overwrite,
    )

    try:
        temp_out_path.write_text("", "utf-8")

        for run_obj in raw["runs"]:
            if not isinstance(run_obj, dict):
                continue

            start = run_obj.get("start_article")
            target = run_obj.get("destination_article")
            if not isinstance(start, str) or not isinstance(target, str):
                continue

            matchup = dataset.get((start, target))
            matchup_id = matchup.id if matchup else f"viewer:{start}->{target}"
            tier = matchup.tier if matchup else "baseline"

            run_id = f"run_{uuid.uuid4().hex[:16]}"

            model = run_obj.get("model")
            if not isinstance(model, str) or not model.strip():
                model = "llm"

            api_base = run_obj.get("api_base")
            api_base = api_base if isinstance(api_base, str) and api_base.strip() else None

            openai_api_mode = run_obj.get("openai_api_mode")
            openai_api_mode = openai_api_mode if isinstance(openai_api_mode, str) and openai_api_mode.strip() else None

            openai_reasoning_effort = run_obj.get("openai_reasoning_effort")
            openai_reasoning_effort = (
                openai_reasoning_effort
                if isinstance(openai_reasoning_effort, str) and openai_reasoning_effort.strip()
                else None
            )

            openai_reasoning_summary = run_obj.get("openai_reasoning_summary")
            openai_reasoning_summary = (
                openai_reasoning_summary
                if isinstance(openai_reasoning_summary, str) and openai_reasoning_summary.strip()
                else None
            )

            anthropic_thinking_budget_tokens = run_obj.get("anthropic_thinking_budget_tokens")
            anthropic_thinking_budget_tokens = (
                anthropic_thinking_budget_tokens
                if isinstance(anthropic_thinking_budget_tokens, int) and anthropic_thinking_budget_tokens > 0
                else None
            )

            google_thinking_config = run_obj.get("google_thinking_config")
            google_thinking_config = google_thinking_config if isinstance(google_thinking_config, dict) else None

            # Budgets: best-effort from run fields, else dataset-level fields.
            max_hops = run_obj.get("max_steps")
            if not isinstance(max_hops, int) or max_hops <= 0:
                max_hops = raw.get("max_steps")
            if not isinstance(max_hops, int) or max_hops <= 0:
                max_hops = 20

            agent_settings = raw.get("agent_settings") if isinstance(raw.get("agent_settings"), dict) else {}

            max_links = (
                run_obj.get("max_links")
                if "max_links" in run_obj
                else agent_settings.get("max_links")
            )
            max_links = max_links if isinstance(max_links, int) and max_links > 0 else None

            max_tokens = (
                run_obj.get("max_tokens")
                if "max_tokens" in run_obj
                else agent_settings.get("max_tokens")
            )
            max_tokens = max_tokens if isinstance(max_tokens, int) and max_tokens > 0 else None

            max_tries = run_obj.get("max_tries")
            if not isinstance(max_tries, int) or max_tries <= 0:
                agent_settings = raw.get("agent_settings") if isinstance(raw.get("agent_settings"), dict) else {}
                max_tries = agent_settings.get("max_tries")
            max_tries = max_tries if isinstance(max_tries, int) and max_tries > 0 else 3

            steps = run_obj.get("steps")
            if not isinstance(steps, list) or not steps:
                continue
            step_dicts = _normalize_viewer_steps(steps, start)
            if not step_dicts:
                skipped_invalid_step_runs.append(_run_label(run_obj, start, target))
                continue

            # Outcome + hops.
            hop_rows, hops = hop_rows_from_steps(step_dicts, start)
            terminal_step_type = hop_rows[-1].step.get("type") if hop_rows else None
            result, result_source = _result_from_run_object(run_obj, terminal_step_type)
            if result is None:
                skipped_nonterminal_runs.append(_run_label(run_obj, start, target))
                continue

            totals = _sum_usage_from_steps(step_dicts)
            llm_latency_ms = _sum_latency_ms_from_steps(step_dicts)
            duration_ms = _duration_ms_from_step_ats(step_dicts)

            started_at = step_dicts[0].get("at") if isinstance(step_dicts[0].get("at"), str) else _now_iso()
            finished_at = step_dicts[-1].get("at") if isinstance(step_dicts[-1].get("at"), str) else _now_iso()

            score_inputs: dict[str, Any] = {
                "shortest_path_hops": matchup.shortest_path_hops if matchup else None,
                "hops_over_shortest": max(0, hops - matchup.shortest_path_hops)
                if matchup and isinstance(matchup.shortest_path_hops, int)
                else None,
            }
            if result_source is not None:
                score_inputs["result_source"] = result_source
            terminal_meta = (
                hop_rows[-1].step.get("metadata")
                if hop_rows and isinstance(hop_rows[-1].step.get("metadata"), dict)
                else {}
            )
            final_reason = terminal_meta.get("reason")
            if isinstance(final_reason, str) and final_reason:
                score_inputs["final_reason"] = final_reason
            elif run_obj.get("result") == "abandoned":
                score_inputs["final_reason"] = "abandoned"
            elif result == "win":
                score_inputs["final_reason"] = "win"

            run_record = BenchmarkRunRecordV1(
                run_id=run_id,
                dataset_id=dataset_label,
                matchup_id=matchup_id,
                tier=tier,
                suite_id=matchup.suite_id if matchup else None,
                slice_id=matchup.slice_id if matchup else None,
                setup_id=matchup.setup_id if matchup else None,
                prompt_version=matchup.prompt_version if matchup else None,
                semantics_version=matchup.semantics_version if matchup else None,
                start=start,
                target=target,
                started_at=started_at,
                finished_at=finished_at,
                result=result,
                hops=hops,
                duration_ms=duration_ms,
                llm_latency_ms=llm_latency_ms,
                model_settings=RunModelSettingsV1(
                    model=model,
                    run_kind="human" if model.startswith("human/") else "llm",
                    player_name=model.split("/", 1)[1] if model.startswith("human/") and "/" in model else None,
                    api_base=api_base,
                    openai_api_mode=openai_api_mode,
                    openai_reasoning_effort=openai_reasoning_effort,
                    openai_reasoning_summary=openai_reasoning_summary,
                    anthropic_thinking_budget_tokens=anthropic_thinking_budget_tokens,
                    google_thinking_config=google_thinking_config,
                ),
                budgets=RunBudgetsV1(max_hops=max_hops, max_links=max_links, max_tokens=max_tokens, max_tries=max_tries),
                totals=totals,
                score_inputs=score_inputs,
                provenance=RunProvenanceV1(seed=None, concurrency=None),
            )
            write_jsonl_line(temp_out_path, run_record)

            for hop_row in hop_rows:
                step = hop_row.step
                step_type = step.get("type")
                article = hop_row.article
                meta = step.get("metadata") if isinstance(step.get("metadata"), dict) else {}
                choice = {
                    "selected_index": _safe_int(meta.get("selected_index")),
                    "tries": _safe_int(meta.get("tries")) or 0,
                    "answer_errors": meta.get("answer_errors") if isinstance(meta.get("answer_errors"), list) else [],
                }
                attempt_count = normalized_attempt_count(
                    attempt_count=_safe_int(meta.get("attempt_count")),
                    tries=choice["tries"],
                    selected_index=choice["selected_index"],
                    reason=meta.get("reason"),
                    llm_output=meta.get("llm_output"),
                    llm_outputs=meta.get("llm_outputs"),
                    answer_errors=choice["answer_errors"],
                )
                choice["tries"] = retries_from_attempt_count(attempt_count)
                prompt_tokens, completion_tokens, total_tokens = _usage_from_meta(meta)
                usage = {
                    "prompt_tokens": prompt_tokens,
                    "completion_tokens": completion_tokens,
                    "total_tokens": total_tokens,
                }
                latency_ms = _latency_ms_from_meta(meta)

                step_meta: dict[str, Any] = dict(meta)

                step_record = BenchmarkStepRecordV1(
                    run_id=run_id,
                    hop=hop_row.hop,
                    at=step.get("at") if isinstance(step.get("at"), str) else _now_iso(),
                    step_type=step_type,
                    article=article,
                    current_article=hop_row.current_article,
                    selected_title=article if step_type in ("move", "win") else None,
                    attempt_count=attempt_count,
                    current_article_canonical=hop_row.current_article,
                    selected_title_canonical=article if step_type in ("move", "win") else None,
                    target_canonical=target,
                    choice=choice,
                    usage=usage,
                    latency_ms=latency_ms,
                    meta=step_meta,
                )
                write_jsonl_line(temp_out_path, step_record)

        temp_out_path.replace(out_path)

        if skipped_invalid_step_runs:
            warnings.warn(
                "Skipped "
                + str(len(skipped_invalid_step_runs))
                + " viewer run(s) with no valid step entries after filtering: "
                + ", ".join(skipped_invalid_step_runs),
                RuntimeWarning,
                stacklevel=2,
            )

        if skipped_nonterminal_runs:
            warnings.warn(
                "Skipped "
                + str(len(skipped_nonterminal_runs))
                + " viewer run(s) without a terminal win/lose step: "
                + ", ".join(skipped_nonterminal_runs),
                RuntimeWarning,
                stacklevel=2,
            )
    finally:
        temp_out_path.unlink(missing_ok=True)
