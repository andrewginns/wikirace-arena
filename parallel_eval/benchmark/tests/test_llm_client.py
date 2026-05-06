from __future__ import annotations

from http.client import IncompleteRead
import unittest
from unittest import mock

from llm_client import (
    _build_direct_openrouter_chat_payload,
    _extract_direct_openai_responses_text,
    _extract_direct_openrouter_chat_text,
    _extract_direct_openrouter_chat_usage,
    _post_direct_openrouter_chat,
)
import llm_client


class DirectOpenAIResponsesTextTests(unittest.TestCase):
    def test_reasoning_only_response_returns_empty_text(self):
        payload = {
            "output": [
                {
                    "type": "reasoning",
                    "content": [],
                    "summary": [],
                }
            ]
        }

        self.assertEqual(_extract_direct_openai_responses_text(payload), "")

    def test_message_output_text_part_is_extracted(self):
        payload = {
            "output": [
                {
                    "type": "message",
                    "content": [
                        {
                            "type": "output_text",
                            "text": "<answer>1</answer>",
                        }
                    ],
                }
            ]
        }

        self.assertEqual(_extract_direct_openai_responses_text(payload), "<answer>1</answer>")


class ObservabilityTests(unittest.TestCase):
    def test_httpx_instrumentation_does_not_capture_headers_or_bodies(self):
        previous_configured = llm_client._LOGFIRE_CONFIGURED
        llm_client._LOGFIRE_CONFIGURED = False
        try:
            with (
                mock.patch.object(llm_client, "_load_local_env", return_value=None),
                mock.patch.object(llm_client.logfire, "configure"),
                mock.patch.object(llm_client.logfire, "instrument_pydantic_ai"),
                mock.patch.object(llm_client.logfire, "instrument_httpx") as httpx_mock,
            ):
                llm_client.configure_observability()
        finally:
            llm_client._LOGFIRE_CONFIGURED = previous_configured

        httpx_mock.assert_called_once_with()


class DirectOpenRouterChatTests(unittest.TestCase):
    def test_build_payload_requests_usage(self):
        payload = _build_direct_openrouter_chat_payload(
            model="openrouter:google/gemini-3-flash-preview",
            prompt="Hello",
            max_tokens=32,
            temperature=0.2,
        )

        self.assertEqual(payload["model"], "google/gemini-3-flash-preview")
        self.assertEqual(payload["messages"], [{"role": "user", "content": "Hello"}])
        self.assertEqual(payload["usage"], {"include": True})
        self.assertEqual(payload["max_tokens"], 32)
        self.assertEqual(payload["temperature"], 0.2)

    def test_extract_text_from_string_content(self):
        payload = {
            "choices": [
                {
                    "message": {
                        "content": "<answer>2</answer>",
                    }
                }
            ]
        }

        self.assertEqual(_extract_direct_openrouter_chat_text(payload), "<answer>2</answer>")

    def test_extract_usage_ignores_non_token_cost_fields(self):
        payload = {
            "usage": {
                "prompt_tokens": 11,
                "completion_tokens": 7,
                "total_tokens": 18,
                "cost_details": {
                    "upstream_inference_cost": 0.0000055,
                },
            }
        }

        usage = _extract_direct_openrouter_chat_usage(payload)
        self.assertIsNotNone(usage)
        assert usage is not None
        self.assertEqual(usage.prompt_tokens, 11)
        self.assertEqual(usage.completion_tokens, 7)
        self.assertEqual(usage.total_tokens, 18)

    def test_post_direct_openrouter_chat_retries_incomplete_read(self):
        payload = {"model": "google/gemini-3.1-pro-preview", "messages": []}
        response_mock = mock.MagicMock()
        response_mock.__enter__.return_value.read.return_value = b'{"id":"resp_123","choices":[]}'
        response_mock.__exit__.return_value = False

        with (
            mock.patch.dict("os.environ", {"OPENROUTER_API_KEY": "test-key"}, clear=False),
            mock.patch("llm_client.time.sleep", return_value=None),
            mock.patch(
                "llm_client.urllib_request.urlopen",
                side_effect=[
                    IncompleteRead(b"partial", 10),
                    response_mock,
                ],
            ) as urlopen_mock,
        ):
            response = _post_direct_openrouter_chat(payload=payload)

        self.assertEqual(response["id"], "resp_123")
        self.assertEqual(urlopen_mock.call_count, 2)


if __name__ == "__main__":
    unittest.main()
