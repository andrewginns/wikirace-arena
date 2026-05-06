from __future__ import annotations

import asyncio
import json
import os
import random
import socket
import time
from dataclasses import dataclass
from http.client import IncompleteRead, RemoteDisconnected
from threading import Lock
from typing import Any, Optional
from urllib import error as urllib_error
from urllib import request as urllib_request
from urllib.parse import urlparse

from dotenv import dotenv_values, load_dotenv
from logfire_compat import logfire

try:
    from pydantic_ai import Agent
    from pydantic_ai.models.google import GoogleModel
    from pydantic_ai.models.openai import OpenAIChatModel, OpenAIResponsesModel
    from pydantic_ai.providers.google import GoogleProvider
    from pydantic_ai.providers.openai import OpenAIProvider
    from google.genai.client import Client as GoogleGenAIClient
    from google.genai.types import HttpOptions as GoogleHttpOptions
    from google.genai.types import HttpRetryOptions as GoogleHttpRetryOptions
    from openai import AsyncOpenAI
except ImportError:
    Agent = None  # type: ignore[assignment]
    GoogleModel = None  # type: ignore[assignment]
    OpenAIChatModel = None  # type: ignore[assignment]
    OpenAIResponsesModel = None  # type: ignore[assignment]
    GoogleProvider = None  # type: ignore[assignment]
    OpenAIProvider = None  # type: ignore[assignment]
    GoogleGenAIClient = None  # type: ignore[assignment]
    GoogleHttpOptions = None  # type: ignore[assignment]
    GoogleHttpRetryOptions = None  # type: ignore[assignment]
    AsyncOpenAI = None  # type: ignore[assignment]


_LOGFIRE_CONFIGURED = False
_LOGFIRE_LOCK = Lock()

_DOTENV_PATH = os.path.join(os.path.dirname(__file__), ".env")
_DEFAULT_HTTP_MAX_RETRIES = 5
_DEFAULT_HTTP_RETRY_INITIAL_DELAY = 1.0
_DEFAULT_HTTP_RETRY_MAX_DELAY = 60.0
_DEFAULT_HTTP_RETRY_EXP_BASE = 2.0
_DEFAULT_HTTP_RETRY_JITTER = 1.0
_CUSTOM_OPENAI_API_KEY_ENV = "WIKIRACE_CUSTOM_OPENAI_API_KEY"
_DIRECT_HTTP_TRANSIENT_ERRORS = (
    TimeoutError,
    socket.timeout,
    IncompleteRead,
    RemoteDisconnected,
    ConnectionResetError,
)


def _load_local_env() -> None:
    # Repo `.env` should win for local benchmark config so runs are reproducible
    # even when shell startup files export stale defaults.
    load_dotenv(dotenv_path=_DOTENV_PATH, override=True)

    override_keys = {"LOGFIRE_TOKEN"}
    for key, value in dotenv_values(dotenv_path=_DOTENV_PATH).items():
        if not isinstance(key, str):
            continue
        if not (key.endswith("_API_KEY") or key in override_keys):
            continue
        if not isinstance(value, str) or not value.strip():
            continue
        os.environ[key] = value.strip()


def _configure_logfire() -> None:
    global _LOGFIRE_CONFIGURED
    with _LOGFIRE_LOCK:
        if _LOGFIRE_CONFIGURED:
            return

        _load_local_env()

        # 'if-token-present' means the app works even without auth/token.
        logfire.configure(send_to_logfire="if-token-present")
        logfire.instrument_pydantic_ai()

        # Optional but useful: capture provider HTTP timing without exporting
        # request/response bodies or sensitive headers such as Authorization.
        try:
            logfire.instrument_httpx()
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
    provider_response_id: Optional[str] = None


def _should_use_direct_openai_responses(*, model: str, api_base: str | None) -> bool:
    raw = (model or "").strip()
    return not api_base and raw.startswith("openai-responses:")


def _should_use_direct_openrouter_chat(*, model: str, api_base: str | None) -> bool:
    raw = (model or "").strip()
    return not api_base and raw.startswith("openrouter:")


def _build_direct_openai_responses_payload(
    *,
    model: str,
    prompt: str,
    max_tokens: Optional[int],
    temperature: Optional[float],
    openai_reasoning_effort: Optional[str],
    openai_reasoning_summary: Optional[str],
) -> dict[str, Any]:
    payload: dict[str, Any] = {
        "model": model.split(":", 1)[-1],
        "input": prompt,
    }

    if isinstance(max_tokens, int) and max_tokens > 0:
        payload["max_output_tokens"] = max_tokens
    if isinstance(temperature, (int, float)):
        payload["temperature"] = float(temperature)

    reasoning: dict[str, Any] = {}
    if isinstance(openai_reasoning_effort, str) and openai_reasoning_effort.strip():
        reasoning["effort"] = openai_reasoning_effort.strip()
    if isinstance(openai_reasoning_summary, str) and openai_reasoning_summary.strip():
        reasoning["summary"] = openai_reasoning_summary.strip()
    if reasoning:
        payload["reasoning"] = reasoning

    return payload


def _extract_direct_openai_responses_text(payload: dict[str, Any]) -> str:
    output_text = payload.get("output_text")
    if isinstance(output_text, str) and output_text.strip():
        return output_text

    texts: list[str] = []
    output = payload.get("output")
    if isinstance(output, list):
        for item in output:
            if not isinstance(item, dict):
                continue
            content = item.get("content")
            if isinstance(content, list):
                for part in content:
                    if not isinstance(part, dict):
                        continue
                    text = part.get("text")
                    if isinstance(text, str) and text:
                        texts.append(text)
            text = item.get("text")
            if isinstance(text, str) and text:
                texts.append(text)

    if texts:
        return "\n".join(texts).strip()

    # Some higher-effort Responses calls can finish with reasoning-only output
    # when the output-token budget is too small to emit a final answer. That is
    # still a bad-answer case for the benchmark, but the model text is empty;
    # serializing the whole response envelope here pollutes parser behavior and
    # raw-output capture.
    return ""


def _extract_direct_openai_responses_usage(payload: dict[str, Any]) -> Optional[NormalizedUsage]:
    usage_payload = payload.get("usage")
    if not isinstance(usage_payload, dict):
        return None

    prompt_tokens = usage_payload.get("input_tokens")
    completion_tokens = usage_payload.get("output_tokens")
    total_tokens = usage_payload.get("total_tokens")

    if not isinstance(prompt_tokens, int):
        prompt_tokens = None
    if not isinstance(completion_tokens, int):
        completion_tokens = None
    if not isinstance(total_tokens, int):
        total_tokens = None

    if total_tokens is None and (prompt_tokens is not None or completion_tokens is not None):
        total_tokens = (prompt_tokens or 0) + (completion_tokens or 0)

    if prompt_tokens is None and completion_tokens is None and total_tokens is None:
        return None

    return NormalizedUsage(
        prompt_tokens=prompt_tokens,
        completion_tokens=completion_tokens,
        total_tokens=total_tokens,
    )


def _build_direct_openrouter_chat_payload(
    *,
    model: str,
    prompt: str,
    max_tokens: Optional[int],
    temperature: Optional[float],
) -> dict[str, Any]:
    payload: dict[str, Any] = {
        "model": model.split(":", 1)[-1],
        "messages": [{"role": "user", "content": prompt}],
        "usage": {"include": True},
    }

    if isinstance(max_tokens, int) and max_tokens > 0:
        payload["max_tokens"] = max_tokens
    if isinstance(temperature, (int, float)):
        payload["temperature"] = float(temperature)

    return payload


def _extract_direct_openrouter_chat_text(payload: dict[str, Any]) -> str:
    choices = payload.get("choices")
    if not isinstance(choices, list) or not choices:
        return ""

    first = choices[0]
    if not isinstance(first, dict):
        return ""

    message = first.get("message")
    if not isinstance(message, dict):
        return ""

    content = message.get("content")
    if isinstance(content, str):
        return content.strip()

    if not isinstance(content, list):
        return ""

    texts: list[str] = []
    for part in content:
        if not isinstance(part, dict):
            continue
        text = part.get("text")
        if isinstance(text, str) and text:
            texts.append(text)

    return "\n".join(texts).strip()


def _extract_direct_openrouter_chat_usage(payload: dict[str, Any]) -> Optional[NormalizedUsage]:
    usage_payload = payload.get("usage")
    if not isinstance(usage_payload, dict):
        return None

    prompt_tokens = usage_payload.get("prompt_tokens")
    completion_tokens = usage_payload.get("completion_tokens")
    total_tokens = usage_payload.get("total_tokens")

    if not isinstance(prompt_tokens, int):
        prompt_tokens = None
    if not isinstance(completion_tokens, int):
        completion_tokens = None
    if not isinstance(total_tokens, int):
        total_tokens = None

    if total_tokens is None and (prompt_tokens is not None or completion_tokens is not None):
        total_tokens = (prompt_tokens or 0) + (completion_tokens or 0)

    if prompt_tokens is None and completion_tokens is None and total_tokens is None:
        return None

    return NormalizedUsage(
        prompt_tokens=prompt_tokens,
        completion_tokens=completion_tokens,
        total_tokens=total_tokens,
    )


def _format_direct_openai_error(body: str) -> str:
    try:
        payload = json.loads(body)
    except json.JSONDecodeError:
        return body.strip() or "OpenAI Responses API request failed"

    if isinstance(payload, dict):
        error = payload.get("error")
        if isinstance(error, dict):
            code = error.get("code")
            message = error.get("message")
            pieces = []
            if isinstance(code, str) and code:
                pieces.append(code)
            if isinstance(message, str) and message:
                pieces.append(message)
            if pieces:
                return ": ".join(pieces) if len(pieces) == 2 else pieces[0]
    return body.strip() or "OpenAI Responses API request failed"


def _http_retry_env_int(name: str, default: int) -> int:
    _load_local_env()
    try:
        return int(os.getenv(name, str(default)))
    except (TypeError, ValueError):
        return default


def _http_retry_env_float(name: str, default: float) -> float:
    _load_local_env()
    try:
        return float(os.getenv(name, str(default)))
    except (TypeError, ValueError):
        return default


def _retry_delay_seconds(attempt: int) -> float:
    # Keep retries modest; the benchmark runner already serializes calls per run.
    initial_delay = _http_retry_env_float(
        "WIKIRACE_LLM_HTTP_RETRY_INITIAL_DELAY_SECONDS",
        _DEFAULT_HTTP_RETRY_INITIAL_DELAY,
    )
    max_delay = _http_retry_env_float(
        "WIKIRACE_LLM_HTTP_RETRY_MAX_DELAY_SECONDS",
        _DEFAULT_HTTP_RETRY_MAX_DELAY,
    )
    exp_base = _http_retry_env_float(
        "WIKIRACE_LLM_HTTP_RETRY_EXP_BASE",
        _DEFAULT_HTTP_RETRY_EXP_BASE,
    )
    delay = initial_delay * (
        exp_base ** max(0, attempt - 1)
    )
    delay = min(max_delay, max(0.0, delay))
    jitter = max(
        0.0,
        _http_retry_env_float("WIKIRACE_LLM_HTTP_RETRY_JITTER", _DEFAULT_HTTP_RETRY_JITTER),
    )
    if jitter > 0:
        delay += random.uniform(0.0, jitter)
    return delay


def _should_retry_direct_openai_http_error(exc: urllib_error.HTTPError, body: str) -> bool:
    if exc.code in {408, 409, 429, 500, 502, 503, 504}:
        return True
    formatted = _format_direct_openai_error(body).lower()
    return "rate limit" in formatted or "temporar" in formatted


def _post_direct_openai_responses(
    *,
    payload: dict[str, Any],
) -> dict[str, Any]:
    api_key = os.getenv("OPENAI_API_KEY")
    if not isinstance(api_key, str) or not api_key.strip():
        raise ValueError("OPENAI_API_KEY is required for direct OpenAI Responses API calls.")

    body = json.dumps(payload).encode("utf-8")
    request = urllib_request.Request(
        "https://api.openai.com/v1/responses",
        data=body,
        method="POST",
        headers={
            "Authorization": f"Bearer {api_key.strip()}",
            "Content-Type": "application/json",
        },
    )

    last_error: Exception | None = None
    max_attempts = _retry_attempts()
    for attempt in range(1, max_attempts + 1):
        try:
            with urllib_request.urlopen(request, timeout=600) as response:
                raw = response.read().decode("utf-8")
                parsed = json.loads(raw)
                if not isinstance(parsed, dict):
                    raise RuntimeError("OpenAI Responses API returned a non-object payload.")
                return parsed
        except urllib_error.HTTPError as exc:
            body_text = exc.read().decode("utf-8", "replace")
            if attempt < max_attempts and _should_retry_direct_openai_http_error(exc, body_text):
                time.sleep(_retry_delay_seconds(attempt))
                continue
            raise RuntimeError(_format_direct_openai_error(body_text)) from exc
        except urllib_error.URLError as exc:
            last_error = exc
            if attempt < max_attempts:
                time.sleep(_retry_delay_seconds(attempt))
                continue
            raise RuntimeError(f"OpenAI Responses API request failed: {exc}") from exc
        except _DIRECT_HTTP_TRANSIENT_ERRORS as exc:
            last_error = exc
            if attempt < max_attempts:
                time.sleep(_retry_delay_seconds(attempt))
                continue
            raise RuntimeError(f"OpenAI Responses API request failed: {exc}") from exc
        except json.JSONDecodeError as exc:
            last_error = exc
            if attempt < max_attempts:
                time.sleep(_retry_delay_seconds(attempt))
                continue
            raise RuntimeError("OpenAI Responses API returned invalid JSON.") from exc

    raise RuntimeError(f"OpenAI Responses API request failed: {last_error}")


def _post_direct_openrouter_chat(
    *,
    payload: dict[str, Any],
) -> dict[str, Any]:
    api_key = os.getenv("OPENROUTER_API_KEY")
    if not isinstance(api_key, str) or not api_key.strip():
        raise ValueError("OPENROUTER_API_KEY is required for direct OpenRouter chat calls.")

    body = json.dumps(payload).encode("utf-8")
    request = urllib_request.Request(
        "https://openrouter.ai/api/v1/chat/completions",
        data=body,
        method="POST",
        headers={
            "Authorization": f"Bearer {api_key.strip()}",
            "Content-Type": "application/json",
        },
    )

    last_error: Exception | None = None
    max_attempts = _retry_attempts()
    for attempt in range(1, max_attempts + 1):
        try:
            with urllib_request.urlopen(request, timeout=600) as response:
                raw = response.read().decode("utf-8")
                parsed = json.loads(raw)
                if not isinstance(parsed, dict):
                    raise RuntimeError("OpenRouter chat endpoint returned a non-object payload.")
                return parsed
        except urllib_error.HTTPError as exc:
            body_text = exc.read().decode("utf-8", "replace")
            if attempt < max_attempts and _should_retry_direct_openai_http_error(exc, body_text):
                time.sleep(_retry_delay_seconds(attempt))
                continue
            raise RuntimeError(_format_direct_openai_error(body_text)) from exc
        except urllib_error.URLError as exc:
            last_error = exc
            if attempt < max_attempts:
                time.sleep(_retry_delay_seconds(attempt))
                continue
            raise RuntimeError(f"OpenRouter chat request failed: {exc}") from exc
        except _DIRECT_HTTP_TRANSIENT_ERRORS as exc:
            last_error = exc
            if attempt < max_attempts:
                time.sleep(_retry_delay_seconds(attempt))
                continue
            raise RuntimeError(f"OpenRouter chat request failed: {exc}") from exc
        except json.JSONDecodeError as exc:
            last_error = exc
            if attempt < max_attempts:
                time.sleep(_retry_delay_seconds(attempt))
                continue
            raise RuntimeError("OpenRouter chat endpoint returned invalid JSON.") from exc

    raise RuntimeError(f"OpenRouter chat request failed: {last_error}")


async def _achat_direct_openai_responses(
    *,
    model: str,
    prompt: str,
    max_tokens: Optional[int],
    temperature: Optional[float],
    openai_reasoning_effort: Optional[str],
    openai_reasoning_summary: Optional[str],
) -> NormalizedChatResult:
    _configure_logfire()

    payload = _build_direct_openai_responses_payload(
        model=model,
        prompt=prompt,
        max_tokens=max_tokens,
        temperature=temperature,
        openai_reasoning_effort=openai_reasoning_effort,
        openai_reasoning_summary=openai_reasoning_summary,
    )
    response_payload = await asyncio.to_thread(_post_direct_openai_responses, payload=payload)

    content = _extract_direct_openai_responses_text(response_payload)
    provider_response_id = response_payload.get("id")
    if not isinstance(provider_response_id, str) or not provider_response_id.strip():
        provider_response_id = None

    return NormalizedChatResult(
        content=content,
        usage=_extract_direct_openai_responses_usage(response_payload),
        provider_response_id=provider_response_id,
    )


async def _achat_direct_openrouter_chat(
    *,
    model: str,
    prompt: str,
    max_tokens: Optional[int],
    temperature: Optional[float],
) -> NormalizedChatResult:
    _configure_logfire()

    payload = _build_direct_openrouter_chat_payload(
        model=model,
        prompt=prompt,
        max_tokens=max_tokens,
        temperature=temperature,
    )
    response_payload = await asyncio.to_thread(_post_direct_openrouter_chat, payload=payload)

    content = _extract_direct_openrouter_chat_text(response_payload)
    provider_response_id = response_payload.get("id")
    if not isinstance(provider_response_id, str) or not provider_response_id.strip():
        provider_response_id = None

    return NormalizedChatResult(
        content=content,
        usage=_extract_direct_openrouter_chat_usage(response_payload),
        provider_response_id=provider_response_id,
    )


def _retry_attempts() -> int:
    return max(
        1,
        _http_retry_env_int("WIKIRACE_LLM_HTTP_MAX_RETRIES", _DEFAULT_HTTP_MAX_RETRIES),
    )


def _openai_api_key_for_base(api_base: str | None) -> str | None:
    if not api_base:
        return os.getenv("OPENAI_API_KEY")

    try:
        hostname = (urlparse(api_base).hostname or "").strip().lower()
    except Exception:
        hostname = ""

    if hostname == "api.openai.com" or hostname.endswith(".openai.com"):
        return os.getenv("OPENAI_API_KEY")

    custom_key = os.getenv(_CUSTOM_OPENAI_API_KEY_ENV)
    if isinstance(custom_key, str) and custom_key.strip():
        return custom_key.strip()
    return "EMPTY"


def _build_openai_provider(*, api_base: str | None) -> OpenAIProvider:
    api_key = _openai_api_key_for_base(api_base)
    if api_base is not None and (api_key is None or not api_key.strip()):
        api_key = "EMPTY"
    client = AsyncOpenAI(
        base_url=api_base,
        api_key=api_key,
        max_retries=_retry_attempts(),
    )
    return OpenAIProvider(openai_client=client)


def _build_google_retry_options() -> GoogleHttpRetryOptions:
    return GoogleHttpRetryOptions(
        attempts=_retry_attempts(),
        initial_delay=_http_retry_env_float(
            "WIKIRACE_LLM_HTTP_RETRY_INITIAL_DELAY_SECONDS",
            _DEFAULT_HTTP_RETRY_INITIAL_DELAY,
        ),
        max_delay=_http_retry_env_float(
            "WIKIRACE_LLM_HTTP_RETRY_MAX_DELAY_SECONDS",
            _DEFAULT_HTTP_RETRY_MAX_DELAY,
        ),
        exp_base=_http_retry_env_float(
            "WIKIRACE_LLM_HTTP_RETRY_EXP_BASE",
            _DEFAULT_HTTP_RETRY_EXP_BASE,
        ),
        jitter=_http_retry_env_float(
            "WIKIRACE_LLM_HTTP_RETRY_JITTER",
            _DEFAULT_HTTP_RETRY_JITTER,
        ),
    )


def _build_google_model(model_name: str, *, vertexai: bool) -> GoogleModel:
    http_options = GoogleHttpOptions(retry_options=_build_google_retry_options())
    if vertexai:
        project = os.getenv("GOOGLE_CLOUD_PROJECT")
        location = os.getenv("GOOGLE_CLOUD_LOCATION")
        api_key = os.getenv("GOOGLE_API_KEY") or os.getenv("GEMINI_API_KEY")
        if project or location:
            api_key = None
        client = GoogleGenAIClient(
            vertexai=True,
            api_key=api_key,
            project=project,
            location=location,
            http_options=http_options,
        )
    else:
        api_key = os.getenv("GOOGLE_API_KEY") or os.getenv("GEMINI_API_KEY")
        client = GoogleGenAIClient(
            vertexai=False,
            api_key=api_key,
            http_options=http_options,
        )
    return GoogleModel(model_name, provider=GoogleProvider(client=client))


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

    if Agent is None or OpenAIProvider is None or OpenAIChatModel is None or OpenAIResponsesModel is None:
        raise ModuleNotFoundError("pydantic_ai is required to resolve models for llm_client.achat().")

    if not api_base:
        if raw.startswith("openai-responses:"):
            model_name = raw.split(":", 1)[-1]
            return OpenAIResponsesModel(model_name, provider=_build_openai_provider(api_base=None))
        if raw.startswith("openai:"):
            model_name = raw.split(":", 1)[-1]
            return OpenAIChatModel(model_name, provider=_build_openai_provider(api_base=None))
        if raw.startswith("google-gla:"):
            model_name = raw.split(":", 1)[-1]
            return _build_google_model(model_name, vertexai=False)
        if raw.startswith("google-vertex:"):
            model_name = raw.split(":", 1)[-1]
            return _build_google_model(model_name, vertexai=True)
        return raw

    if not raw.startswith(("openai:", "openai-responses:")):
        raise ValueError(
            "api_base is only supported for OpenAI/OpenAI-compatible models (openai:* or openai-responses:*)"
        )

    model_name = raw.split(":", 1)[-1]
    provider = _build_openai_provider(api_base=api_base)

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
    cleaned_api_base = api_base.strip() if isinstance(api_base, str) and api_base.strip() else None
    if _should_use_direct_openai_responses(model=model, api_base=cleaned_api_base):
        return await _achat_direct_openai_responses(
            model=model,
            prompt=prompt,
            max_tokens=max_tokens,
            temperature=temperature,
            openai_reasoning_effort=openai_reasoning_effort,
            openai_reasoning_summary=openai_reasoning_summary,
        )
    if _should_use_direct_openrouter_chat(model=model, api_base=cleaned_api_base):
        return await _achat_direct_openrouter_chat(
            model=model,
            prompt=prompt,
            max_tokens=max_tokens,
            temperature=temperature,
        )

    if Agent is None:
        raise ModuleNotFoundError("pydantic_ai is required to call llm_client.achat().")

    _configure_logfire()

    resolved_model = _resolve_model(
        model=model,
        api_base=cleaned_api_base,
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

    provider_response_id = getattr(result, "provider_response_id", None)
    if not isinstance(provider_response_id, str) or not provider_response_id.strip():
        provider_response_id = None

    return NormalizedChatResult(content=content, usage=usage, provider_response_id=provider_response_id)
