from __future__ import annotations

import os
from dataclasses import dataclass
from threading import Lock
from typing import Any, Optional

from dotenv import load_dotenv
import logfire

from pydantic_ai import Agent
from pydantic_ai.models.openai import OpenAIChatModel, OpenAIResponsesModel
from pydantic_ai.providers.openai import OpenAIProvider


_LOGFIRE_CONFIGURED = False
_LOGFIRE_LOCK = Lock()


def _configure_logfire() -> None:
    global _LOGFIRE_CONFIGURED
    with _LOGFIRE_LOCK:
        if _LOGFIRE_CONFIGURED:
            return

        # Load LOGFIRE_TOKEN and provider keys from a local `.env`.
        #
        # `override=True` makes `.env` take precedence over the parent process
        # environment (e.g. keys exported in your shell rc files). This keeps
        # local/dev behavior consistent when people prefer editing `.env`.
        #
        # This is intentionally best-effort: the repo should run without a token.
        load_dotenv(override=True)

        # 'if-token-present' means the app works even without auth/token.
        logfire.configure(send_to_logfire="if-token-present")
        logfire.instrument_pydantic_ai()

        # Optional but useful: capture provider HTTP traffic.
        try:
            logfire.instrument_httpx(capture_all=True)
        except Exception:
            pass

        _LOGFIRE_CONFIGURED = True


def configure_observability() -> None:
    """Best-effort Logfire config.

    This is safe to call multiple times and is intentionally tolerant of missing
    credentials.
    """

    _configure_logfire()


def run_span_name(*, model: str, openai_reasoning_effort: Optional[str] = None) -> str:
    """Compute a stable parent span name for a run.

    Examples:
    - model='openai-responses:gpt-5.2', openai_reasoning_effort='medium' -> 'gpt-5.2-medium'
    - model='openai-responses:gpt-5.2', openai_reasoning_effort=None -> 'gpt-5.2'
    """

    raw = (model or "").strip()
    if not raw:
        return "unknown"

    # Drop provider prefix.
    model_name = raw.split(":", 1)[-1]

    effort = (openai_reasoning_effort or "").strip().lower()
    if effort:
        return f"{model_name}-{effort}"
    return model_name


@dataclass
class NormalizedUsage:
    prompt_tokens: Optional[int] = None
    completion_tokens: Optional[int] = None
    total_tokens: Optional[int] = None


@dataclass
class NormalizedChatResult:
    content: str
    usage: Optional[NormalizedUsage] = None


def _resolve_model(*, model: str, api_base: str | None, openai_api_mode: str | None):
    """Resolve user input into a PydanticAI model string or model instance.

    Behavior:
    - If `api_base` is NOT set: treat `model` as a PydanticAI model identifier.
      (e.g. `openai-responses:gpt-5.2`, `anthropic:...`, `google-gla:...`, etc.)

    - If `api_base` IS set: treat `model` as an OpenAI-compatible model.
      Most OpenAI-compatible servers implement Chat Completions, not Responses,
      so we default to Chat Completions unless `openai_api_mode='responses'`.
    """

    raw = (model or "").strip()
    if not raw:
        raise ValueError("Missing model")

    if not api_base:
        return raw

    if not raw.startswith(("openai:", "openai-responses:")):
        raise ValueError(
            "api_base is only supported for OpenAI/OpenAI-compatible models (openai:* or openai-responses:*)"
        )

    model_name = raw.split(":", 1)[-1]
    provider = OpenAIProvider(
        base_url=api_base,
        api_key=os.getenv("OPENAI_API_KEY") or "EMPTY",
    )

    mode = (openai_api_mode or "").strip().lower()
    if not mode:
        mode = "chat"

    if mode == "responses":
        return OpenAIResponsesModel(model_name, provider=provider)
    return OpenAIChatModel(model_name, provider=provider)


async def achat(
    *,
    model: str,
    prompt: str,
    max_tokens: Optional[int] = None,
    temperature: Optional[float] = None,
    api_base: Optional[str] = None,
    openai_api_mode: Optional[str] = None,
    openai_reasoning_effort: Optional[str] = None,
    openai_reasoning_summary: Optional[str] = None,
    anthropic_thinking_budget_tokens: Optional[int] = None,
    google_thinking_config: Optional[dict[str, object]] = None,
) -> NormalizedChatResult:
    _configure_logfire()

    resolved_model = _resolve_model(
        model=model,
        api_base=(api_base.strip() if isinstance(api_base, str) and api_base.strip() else None),
        openai_api_mode=openai_api_mode,
    )

    model_settings: dict[str, Any] = {}
    if isinstance(max_tokens, int) and max_tokens > 0:
        model_settings["max_tokens"] = max_tokens
    if isinstance(temperature, (int, float)):
        model_settings["temperature"] = float(temperature)

    if isinstance(openai_reasoning_effort, str) and openai_reasoning_effort.strip():
        model_settings["openai_reasoning_effort"] = openai_reasoning_effort.strip()
    if isinstance(openai_reasoning_summary, str) and openai_reasoning_summary.strip():
        model_settings["openai_reasoning_summary"] = openai_reasoning_summary.strip()

    if (
        isinstance(anthropic_thinking_budget_tokens, int)
        and anthropic_thinking_budget_tokens > 0
    ):
        model_settings["anthropic_thinking"] = {
            "type": "enabled",
            "budget_tokens": anthropic_thinking_budget_tokens,
        }

    if isinstance(google_thinking_config, dict) and google_thinking_config:
        model_settings["google_thinking_config"] = google_thinking_config

    # OpenRouter token usage is often opt-in.
    if (model or "").strip().startswith("openrouter:"):
        model_settings["openrouter_usage"] = {"include": True}

    agent = Agent(resolved_model)
    result = await agent.run(prompt, model_settings=model_settings)

    usage_obj = result.usage()
    prompt_tokens = usage_obj.input_tokens
    completion_tokens = usage_obj.output_tokens
    total_tokens = None
    if isinstance(prompt_tokens, int) or isinstance(completion_tokens, int):
        total_tokens = (prompt_tokens or 0) + (completion_tokens or 0)

    usage = None
    if prompt_tokens is not None or completion_tokens is not None or total_tokens is not None:
        usage = NormalizedUsage(
            prompt_tokens=prompt_tokens,
            completion_tokens=completion_tokens,
            total_tokens=total_tokens,
        )

    content = result.output
    if not isinstance(content, str):
        content = str(content)

    return NormalizedChatResult(content=content, usage=usage)
