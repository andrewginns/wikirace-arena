from __future__ import annotations

import io
import os
import tempfile
import unittest
from pathlib import Path
from unittest.mock import MagicMock, call, patch
from http.client import IncompleteRead
from urllib import error as urllib_error

from pydantic_ai.models.google import GoogleModel
from pydantic_ai.models.openai import OpenAIChatModel, OpenAIResponsesModel

import llm_client


class LlmClientRetryConfigTests(unittest.TestCase):
    def setUp(self):
        self._temp_dir = tempfile.TemporaryDirectory()
        self.addCleanup(self._temp_dir.cleanup)

        self.dotenv_path = Path(self._temp_dir.name) / ".env"
        dotenv_patch = patch.object(llm_client, "_DOTENV_PATH", str(self.dotenv_path))
        dotenv_patch.start()
        self.addCleanup(dotenv_patch.stop)

    def test_retry_settings_are_loaded_from_dotenv_before_use(self):
        self.dotenv_path.write_text(
            "\n".join(
                [
                    "WIKIRACE_LLM_HTTP_MAX_RETRIES=9",
                    "WIKIRACE_LLM_HTTP_RETRY_INITIAL_DELAY_SECONDS=2.5",
                    "WIKIRACE_LLM_HTTP_RETRY_MAX_DELAY_SECONDS=30.0",
                    "WIKIRACE_LLM_HTTP_RETRY_EXP_BASE=4.0",
                    "WIKIRACE_LLM_HTTP_RETRY_JITTER=0.0",
                ]
            )
            + "\n",
            "utf-8",
        )

        with patch.dict(os.environ, {}, clear=True):
            self.assertEqual(llm_client._retry_attempts(), 9)
            self.assertEqual(llm_client._retry_delay_seconds(2), 10.0)

            retry_options = llm_client._build_google_retry_options()

        self.assertEqual(retry_options.attempts, 9)
        self.assertEqual(retry_options.initial_delay, 2.5)
        self.assertEqual(retry_options.max_delay, 30.0)
        self.assertEqual(retry_options.exp_base, 4.0)
        self.assertEqual(retry_options.jitter, 0.0)

    def test_dotenv_retry_settings_override_shell_exports(self):
        self.dotenv_path.write_text("WIKIRACE_LLM_HTTP_MAX_RETRIES=7\n", "utf-8")

        with patch.dict(os.environ, {"WIKIRACE_LLM_HTTP_MAX_RETRIES": "2"}, clear=True):
            self.assertEqual(llm_client._retry_attempts(), 7)

    def test_direct_openai_responses_uses_configured_retry_count_and_backoff(self):
        response = MagicMock()
        response.__enter__.return_value.read.return_value = b'{"id":"resp_1"}'

        with (
            patch.dict(os.environ, {"OPENAI_API_KEY": "EMPTY"}, clear=False),
            patch.object(llm_client, "_DEFAULT_HTTP_MAX_RETRIES", 3),
            patch.object(llm_client, "_DEFAULT_HTTP_RETRY_INITIAL_DELAY", 2.0),
            patch.object(llm_client, "_DEFAULT_HTTP_RETRY_MAX_DELAY", 10.0),
            patch.object(llm_client, "_DEFAULT_HTTP_RETRY_EXP_BASE", 3.0),
            patch.object(llm_client, "_DEFAULT_HTTP_RETRY_JITTER", 0.5),
            patch.object(llm_client.random, "uniform", return_value=0.25),
            patch.object(
                llm_client.urllib_request,
                "urlopen",
                side_effect=[urllib_error.URLError("boom"), urllib_error.URLError("boom"), response],
            ) as urlopen_mock,
            patch.object(llm_client.time, "sleep") as sleep_mock,
        ):
            payload = llm_client._post_direct_openai_responses(payload={"model": "gpt-5.2"})

        self.assertEqual(payload, {"id": "resp_1"})
        self.assertEqual(urlopen_mock.call_count, 3)
        self.assertEqual(sleep_mock.call_args_list, [call(2.25), call(6.25)])

    def test_direct_openai_responses_retries_transient_socket_disconnects(self):
        response = MagicMock()
        response.__enter__.return_value.read.return_value = b'{"id":"resp_1"}'

        with (
            patch.dict(os.environ, {"OPENAI_API_KEY": "EMPTY"}, clear=False),
            patch.object(llm_client, "_DEFAULT_HTTP_MAX_RETRIES", 2),
            patch.object(llm_client, "_DEFAULT_HTTP_RETRY_JITTER", 0.0),
            patch.object(
                llm_client.urllib_request,
                "urlopen",
                side_effect=[IncompleteRead(b"{", 1), response],
            ) as urlopen_mock,
            patch.object(llm_client.time, "sleep") as sleep_mock,
        ):
            payload = llm_client._post_direct_openai_responses(payload={"model": "gpt-5.2"})

        self.assertEqual(payload, {"id": "resp_1"})
        self.assertEqual(urlopen_mock.call_count, 2)
        self.assertEqual(sleep_mock.call_count, 1)

    def test_malformed_retry_env_falls_back_to_defaults(self):
        self.dotenv_path.write_text(
            "\n".join(
                [
                    "WIKIRACE_LLM_HTTP_MAX_RETRIES=abc",
                    "WIKIRACE_LLM_HTTP_RETRY_INITIAL_DELAY_SECONDS=oops",
                ]
            )
            + "\n",
            "utf-8",
        )

        with patch.dict(os.environ, {}, clear=True):
            self.assertEqual(
                llm_client._retry_attempts(),
                llm_client._DEFAULT_HTTP_MAX_RETRIES,
            )
            self.assertGreaterEqual(llm_client._retry_delay_seconds(1), 0.0)

    def test_direct_openrouter_chat_uses_configured_retry_count(self):
        response = MagicMock()
        response.__enter__.return_value.read.return_value = b'{"id":"chat_1"}'
        http_error = urllib_error.HTTPError(
            url="https://openrouter.ai/api/v1/chat/completions",
            code=429,
            msg="Too Many Requests",
            hdrs=None,
            fp=io.BytesIO(b'{"error":{"message":"rate limit"}}'),
        )

        with (
            patch.dict(os.environ, {"OPENROUTER_API_KEY": "EMPTY"}, clear=False),
            patch.object(llm_client, "_DEFAULT_HTTP_MAX_RETRIES", 2),
            patch.object(llm_client, "_DEFAULT_HTTP_RETRY_INITIAL_DELAY", 1.0),
            patch.object(llm_client, "_DEFAULT_HTTP_RETRY_MAX_DELAY", 60.0),
            patch.object(llm_client, "_DEFAULT_HTTP_RETRY_EXP_BASE", 2.0),
            patch.object(llm_client, "_DEFAULT_HTTP_RETRY_JITTER", 0.0),
            patch.object(
                llm_client.urllib_request,
                "urlopen",
                side_effect=[http_error, response],
            ) as urlopen_mock,
            patch.object(llm_client.time, "sleep") as sleep_mock,
        ):
            payload = llm_client._post_direct_openrouter_chat(payload={"model": "openai/gpt-5.2"})

        self.assertEqual(payload, {"id": "chat_1"})
        self.assertEqual(urlopen_mock.call_count, 2)
        self.assertEqual(sleep_mock.call_args_list, [call(1.0)])

    def test_openai_responses_model_has_configured_http_retries(self):
        with patch.dict(os.environ, {"OPENAI_API_KEY": "EMPTY"}, clear=False):
            resolved = llm_client._resolve_model(
                model="openai-responses:gpt-5.2",
                api_base=None,
                openai_api_mode=None,
            )
        self.assertIsInstance(resolved, OpenAIResponsesModel)
        provider = resolved._provider
        self.assertEqual(provider.client.max_retries, llm_client._retry_attempts())

    def test_openai_chat_model_with_api_base_has_configured_http_retries(self):
        with patch.dict(os.environ, {"OPENAI_API_KEY": "EMPTY"}, clear=False):
            resolved = llm_client._resolve_model(
                model="openai:gpt-5.2",
                api_base="http://localhost:8000/v1",
                openai_api_mode="chat",
            )
        self.assertIsInstance(resolved, OpenAIChatModel)
        provider = resolved._provider
        self.assertEqual(provider.client.max_retries, llm_client._retry_attempts())
        self.assertEqual(provider.client.api_key, "EMPTY")

    def test_custom_api_base_uses_separate_custom_endpoint_key(self):
        with patch.dict(
            os.environ,
            {
                "OPENAI_API_KEY": "server-secret",
                "WIKIRACE_CUSTOM_OPENAI_API_KEY": "custom-secret",
            },
            clear=False,
        ):
            provider = llm_client._build_openai_provider(api_base="http://localhost:8000/v1")

        self.assertEqual(provider.client.api_key, "custom-secret")

    def test_google_gla_model_has_configured_http_retry_options(self):
        with patch.dict(
            os.environ,
            {
                "GEMINI_API_KEY": "EMPTY",
                "GOOGLE_API_KEY": "",
                "GOOGLE_CLOUD_PROJECT": "",
                "GOOGLE_CLOUD_LOCATION": "",
            },
            clear=False,
        ):
            resolved = llm_client._resolve_model(
                model="google-gla:gemini-3-flash-preview",
                api_base=None,
                openai_api_mode=None,
            )
        self.assertIsInstance(resolved, GoogleModel)
        provider = resolved._provider
        retry_options = provider.client._api_client._http_options.retry_options
        self.assertEqual(retry_options.attempts, llm_client._retry_attempts())
        self.assertEqual(retry_options.initial_delay, llm_client._DEFAULT_HTTP_RETRY_INITIAL_DELAY)
        self.assertEqual(retry_options.max_delay, llm_client._DEFAULT_HTTP_RETRY_MAX_DELAY)
        self.assertEqual(retry_options.exp_base, llm_client._DEFAULT_HTTP_RETRY_EXP_BASE)
        self.assertEqual(retry_options.jitter, llm_client._DEFAULT_HTTP_RETRY_JITTER)


if __name__ == "__main__":
    unittest.main()
