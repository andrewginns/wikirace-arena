from __future__ import annotations

import json
import os
import tempfile
import warnings
import uuid
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Optional

from parallel_eval.benchmark.graph import SQLiteGraph
from parallel_eval.benchmark.schema import (
    BenchmarkChoiceV1,
    BenchmarkRunRecordV1,
    BenchmarkStepRecordV1,
    MatchupV1,
    RunBudgetsV1,
    RunModelSettingsV1,
    RunProvenanceV1,
    TokenTotalsV1,
    write_jsonl_line,
)
from parallel_eval.benchmark.semantics import hop_rows_from_steps
from parallel_eval.benchmark.utils import benchmark_dataset_id, normalized_attempt_count, retries_from_attempt_count, sha256_file


def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")


def _safe_int(value: Any) -> Optional[int]:
    if isinstance(value, bool):
        return None
    if isinstance(value, int):
        return value
    return None


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
    with open(dataset_path, "r", encoding="utf-8") as handle:
        for raw in handle:
            raw = raw.strip()
            if not raw:
                continue
            data = json.loads(raw)
            matchup = MatchupV1.model_validate(data)
            mapping[(matchup.start, matchup.target)] = matchup
    return mapping


def _extract_session(raw: dict[str, Any]) -> dict[str, Any]:
    if isinstance(raw.get("session"), dict):
        return raw["session"]
    if isinstance(raw.get("race"), dict):
        return raw["race"]
    if isinstance(raw.get("runs"), list) and isinstance(raw.get("start_article"), str):
        return raw
    raise ValueError("Session export must contain a top-level `session` or `race` object.")


def _attempt_count(meta: dict[str, Any]) -> int:
    return normalized_attempt_count(
        attempt_count=_safe_int(meta.get("attempt_count")),
        tries=_safe_int(meta.get("tries")),
        selected_index=_safe_int(meta.get("selected_index")),
        reason=meta.get("reason"),
        llm_output=meta.get("llm_output"),
        llm_outputs=meta.get("llm_outputs"),
        answer_errors=_answer_errors_from_meta(meta),
    )


def _answer_errors_from_meta(meta: dict[str, Any]) -> list[str]:
    answer_errors = meta.get("answer_errors")
    if not isinstance(answer_errors, list):
        return []
    return [value for value in answer_errors if isinstance(value, str)]


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


def _token_totals_from_steps(steps: list[dict[str, Any]]) -> TokenTotalsV1:
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
        prompt_tokens, completion_tokens, total_tokens = _usage_from_meta(meta)

        if isinstance(prompt_tokens, int):
            prompt += prompt_tokens
            saw_prompt = True
        if isinstance(completion_tokens, int):
            completion += completion_tokens
            saw_completion = True
        if isinstance(total_tokens, int):
            total += total_tokens
            saw_total = True
        elif isinstance(prompt_tokens, int) or isinstance(completion_tokens, int):
            total += (prompt_tokens or 0) + (completion_tokens or 0)
            saw_total = True

    return TokenTotalsV1(
        prompt_tokens=prompt if saw_prompt else None,
        completion_tokens=completion if saw_completion else None,
        total_tokens=total if saw_total else None,
    )


def _llm_latency_ms_from_steps(steps: list[dict[str, Any]]) -> Optional[int]:
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


def import_session_json(
    *,
    session_json_path: Path,
    dataset_path: Optional[Path],
    dataset_id: Optional[str],
    db_path: Optional[Path],
    out_path: Path,
    overwrite: bool,
) -> None:
    raw = json.loads(session_json_path.read_text("utf-8"))
    if not isinstance(raw, dict):
        raise ValueError("Session export must be a JSON object.")

    session = _extract_session(raw)
    runs = session.get("runs")
    if not isinstance(runs, list):
        raise ValueError("Session export is missing `runs`.")

    start_article = session.get("start_article")
    destination_article = session.get("destination_article")
    if not isinstance(start_article, str) or not isinstance(destination_article, str):
        raise ValueError("Session export is missing start_article/destination_article.")

    dataset = _load_dataset(dataset_path) if dataset_path else {}
    dataset_label = (
        dataset_id.strip()
        if isinstance(dataset_id, str) and dataset_id.strip()
        else benchmark_dataset_id(dataset_path, dataset.values()) if dataset_path else f"observed_app_races/{session_json_path.stem}"
    )

    temp_out_path = _prepare_output_write(
        source_path=session_json_path,
        out_path=out_path,
        overwrite=overwrite,
    )

    graph: Optional[SQLiteGraph] = None
    db_sha256: Optional[str] = None
    if db_path is not None:
        graph = SQLiteGraph(db_path)
        db_sha256 = sha256_file(db_path)

    try:
        temp_out_path.write_text("", "utf-8")
        skipped_invalid_step_runs: list[str] = []
        skipped_nonterminal_runs: list[str] = []

        for run_index, run_obj in enumerate(runs):
            if not isinstance(run_obj, dict):
                continue

            raw_run_id = run_obj.get("id")
            run_label = (
                raw_run_id
                if isinstance(raw_run_id, str) and raw_run_id.strip()
                else f"index:{run_index}"
            )

            run_kind = run_obj.get("kind")
            if run_kind not in ("human", "llm"):
                continue

            run_steps = run_obj.get("steps")
            if not isinstance(run_steps, list) or not run_steps:
                skipped_invalid_step_runs.append(run_label)
                continue
            step_dicts = [step for step in run_steps if isinstance(step, dict)]
            if not step_dicts:
                skipped_invalid_step_runs.append(run_label)
                continue

            hop_rows, hops = hop_rows_from_steps(step_dicts, start_article)

            terminal_step_type = hop_rows[-1].step.get("type") if hop_rows else None
            result, result_source = _result_from_run_object(run_obj, terminal_step_type)
            if result is None:
                skipped_nonterminal_runs.append(run_label)
                continue

            matchup = dataset.get((start_article, destination_article))
            matchup_id = matchup.id if matchup else f"session:{session.get('id') or uuid.uuid4().hex}:{run_obj.get('id') or uuid.uuid4().hex}"
            tier = matchup.tier if matchup else "observed"

            legacy_reported_hops = _safe_int(run_obj.get("hops"))

            totals = _token_totals_from_steps(step_dicts)
            llm_latency_ms = _llm_latency_ms_from_steps(step_dicts) if run_kind == "llm" else None
            duration_ms = _safe_int(run_obj.get("duration_ms"))
            if not isinstance(duration_ms, int):
                duration_ms = _duration_ms_from_step_ats(step_dicts)

            started_at = run_obj.get("started_at") if isinstance(run_obj.get("started_at"), str) else None
            if not started_at:
                started_at = step_dicts[0].get("at") if isinstance(step_dicts[0].get("at"), str) else _now_iso()
            finished_at = run_obj.get("finished_at") if isinstance(run_obj.get("finished_at"), str) else None
            if not finished_at:
                finished_at = step_dicts[-1].get("at") if isinstance(step_dicts[-1].get("at"), str) else _now_iso()

            player_name = run_obj.get("player_name")
            if not isinstance(player_name, str) or not player_name.strip():
                player_name = None

            model = run_obj.get("model")
            if not isinstance(model, str) or not model.strip():
                model = "human" if run_kind == "human" else "llm"

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
            anthropic_thinking_budget_tokens = _safe_int(run_obj.get("anthropic_thinking_budget_tokens"))
            if anthropic_thinking_budget_tokens is not None and anthropic_thinking_budget_tokens <= 0:
                anthropic_thinking_budget_tokens = None
            google_thinking_config = run_obj.get("google_thinking_config")
            google_thinking_config = google_thinking_config if isinstance(google_thinking_config, dict) else None

            session_rules = session.get("rules") if isinstance(session.get("rules"), dict) else {}
            max_hops = _safe_int(run_obj.get("max_steps"))
            if not isinstance(max_hops, int):
                max_hops = _safe_int(session_rules.get("max_hops")) or 20

            max_links = (
                run_obj.get("max_links")
                if "max_links" in run_obj
                else session_rules.get("max_links")
            )
            max_links = max_links if isinstance(max_links, int) and max_links > 0 else None

            max_tokens = (
                run_obj.get("max_tokens")
                if "max_tokens" in run_obj
                else session_rules.get("max_tokens")
            )
            max_tokens = max_tokens if isinstance(max_tokens, int) and max_tokens > 0 else None

            score_inputs: dict[str, Any] = {}
            if result_source is not None:
                score_inputs["result_source"] = result_source
            if isinstance(legacy_reported_hops, int) and legacy_reported_hops != hops:
                score_inputs["legacy_reported_hops"] = legacy_reported_hops
                score_inputs["legacy_hops_mismatch"] = True
            if matchup and isinstance(matchup.shortest_path_hops, int):
                score_inputs["shortest_path_hops"] = matchup.shortest_path_hops
                score_inputs["hops_over_shortest"] = max(0, hops - matchup.shortest_path_hops)
                if matchup.path_bucket:
                    score_inputs["path_bucket"] = matchup.path_bucket

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

            run_id = f"run_{uuid.uuid4().hex[:16]}"
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
                start=start_article,
                target=destination_article,
                started_at=started_at,
                finished_at=finished_at,
                result=result,
                hops=hops,
                duration_ms=duration_ms,
                llm_latency_ms=llm_latency_ms,
                model_settings=RunModelSettingsV1(
                    model=model,
                    run_kind=run_kind,
                    player_name=player_name,
                    api_base=api_base,
                    openai_api_mode=openai_api_mode,
                    openai_reasoning_effort=openai_reasoning_effort,
                    openai_reasoning_summary=openai_reasoning_summary,
                    anthropic_thinking_budget_tokens=anthropic_thinking_budget_tokens,
                    google_thinking_config=google_thinking_config,
                ),
                budgets=RunBudgetsV1(max_hops=max_hops, max_links=max_links, max_tokens=max_tokens, max_tries=3),
                totals=totals,
                score_inputs=score_inputs,
                provenance=RunProvenanceV1(
                    db_path=str(db_path) if db_path is not None else None,
                    db_sha256=db_sha256,
                    runner="parallel_eval.benchmark.import_session",
                ),
            )
            write_jsonl_line(temp_out_path, run_record)

            for hop_row in hop_rows:
                step = hop_row.step
                step_type = step.get("type")
                article = hop_row.article

                step_meta = step.get("metadata") if isinstance(step.get("metadata"), dict) else {}
                selected_title = step_meta.get("selected_title")
                if not isinstance(selected_title, str) or not selected_title.strip():
                    selected_title = article if step_type in ("move", "win") else None

                prompt_tokens, completion_tokens, total_tokens = _usage_from_meta(step_meta)
                latency_ms = _latency_ms_from_meta(step_meta)
                attempt_count = _attempt_count(step_meta) if run_kind == "llm" else 1
                answer_errors = _answer_errors_from_meta(step_meta)

                current_canonical = (
                    graph.canonical_title(hop_row.current_article) if graph is not None else None
                )
                selected_canonical = graph.canonical_title(selected_title) if graph is not None and selected_title else None
                target_canonical = graph.canonical_title(destination_article) if graph is not None else None

                write_jsonl_line(
                    temp_out_path,
                    BenchmarkStepRecordV1(
                        run_id=run_id,
                        hop=hop_row.hop,
                        at=step.get("at") if isinstance(step.get("at"), str) else _now_iso(),
                        step_type=step_type,
                        article=article,
                        current_article=hop_row.current_article,
                        selected_title=selected_title,
                        attempt_count=attempt_count,
                        links_presented_count=None,
                        links_presented_ref=None,
                        current_article_canonical=current_canonical,
                        selected_title_canonical=selected_canonical,
                        target_canonical=target_canonical,
                        choice=BenchmarkChoiceV1(
                            selected_index=_safe_int(step_meta.get("selected_index")),
                            tries=retries_from_attempt_count(attempt_count),
                            answer_errors=answer_errors,
                        ),
                        usage={
                            "prompt_tokens": prompt_tokens,
                            "completion_tokens": completion_tokens,
                            "total_tokens": total_tokens,
                        },
                        latency_ms=latency_ms,
                        meta=step_meta,
                    ),
                )

        temp_out_path.replace(out_path)

        if skipped_invalid_step_runs:
            warnings.warn(
                "Skipped "
                + str(len(skipped_invalid_step_runs))
                + " session run(s) with no valid step objects after filtering: "
                + ", ".join(skipped_invalid_step_runs),
                RuntimeWarning,
                stacklevel=2,
            )

        if skipped_nonterminal_runs:
            warnings.warn(
                "Skipped "
                + str(len(skipped_nonterminal_runs))
                + " session run(s) without a terminal win/lose step: "
                + ", ".join(skipped_nonterminal_runs),
                RuntimeWarning,
                stacklevel=2,
            )
    finally:
        temp_out_path.unlink(missing_ok=True)
        if graph is not None:
            graph.close()
