from __future__ import annotations

import asyncio
import unittest
from types import SimpleNamespace
from unittest.mock import AsyncMock, patch

from fastapi import HTTPException, Request
from fastapi.testclient import TestClient
from starlette.websockets import WebSocketDisconnect

import api


class ApiSecurityTests(unittest.TestCase):
    def tearDown(self):
        api.ROOMS.clear()
        api.ROOM_LOCKS.clear()
        api.ROOM_CONNECTIONS.clear()
        api.ROOM_CONNECTION_OWNERS.clear()
        api.ROOM_PLAYER_CONNECTION_COUNTS.clear()
        api.ROOM_PLAYER_TOKENS.clear()
        api.ROOM_WS_TICKETS.clear()
        api.ROOM_TASKS.clear()
        api.ROOM_TASK_GENERATIONS.clear()
        api._WIKI_PROXY_CACHE.clear()
        api._WIKI_PROXY_INFLIGHT.clear()
        api._wiki_proxy_csp_header.cache_clear()

    def test_llm_cors_allowlist_accepts_local_ui_and_rejects_unknown_origins(self):
        with TestClient(api.app) as client:
            allowed = client.options(
                "/llm/chat",
                headers={
                    "Origin": "http://localhost:5173",
                    "Access-Control-Request-Method": "POST",
                    "Access-Control-Request-Headers": "content-type",
                },
            )
            blocked = client.options(
                "/llm/chat",
                headers={
                    "Origin": "https://evil.example",
                    "Access-Control-Request-Method": "POST",
                    "Access-Control-Request-Headers": "content-type",
                },
            )

        self.assertEqual(allowed.status_code, 200)
        self.assertEqual(
            allowed.headers.get("access-control-allow-origin"),
            "http://localhost:5173",
        )
        self.assertNotEqual(blocked.headers.get("access-control-allow-origin"), "https://evil.example")

    def test_remote_llm_requests_are_rejected_by_default(self):
        request = Request(
            {
                "type": "http",
                "client": ("192.168.10.25", 55443),
                "headers": [],
            }
        )

        with patch.object(api, "WIKIRACE_ALLOW_REMOTE_LLM_API", False):
            with self.assertRaises(HTTPException) as ctx:
                api._require_local_llm_request(request)

        self.assertEqual(ctx.exception.status_code, 403)

    def test_proxied_remote_llm_requests_are_rejected_when_socket_peer_is_loopback(self):
        request = Request(
            {
                "type": "http",
                "client": ("127.0.0.1", 55443),
                "headers": [
                    (b"host", b"public.example"),
                    (b"x-forwarded-for", b"198.51.100.25"),
                ],
            }
        )

        with patch.object(api, "WIKIRACE_ALLOW_REMOTE_LLM_API", False):
            with self.assertRaises(HTTPException) as ctx:
                api._require_local_llm_request(request)

        self.assertEqual(ctx.exception.status_code, 403)

    def test_proxy_secret_can_authorize_proxied_llm_requests(self):
        request = Request(
            {
                "type": "http",
                "client": ("127.0.0.1", 55443),
                "headers": [
                    (b"host", b"public.example"),
                    (b"x-forwarded-for", b"198.51.100.25"),
                    (api.LLM_PROXY_SECRET_HEADER.encode("utf-8"), b"proxy-secret"),
                ],
            }
        )

        with (
            patch.object(api, "WIKIRACE_ALLOW_REMOTE_LLM_API", False),
            patch.object(api, "WIKIRACE_LLM_PROXY_SHARED_SECRET", "proxy-secret"),
        ):
            api._require_local_llm_request(request)

        with (
            patch.object(api, "WIKIRACE_LLM_PROXY_SHARED_SECRET", "proxy-secret"),
            patch.object(api, "WIKIRACE_ALLOWED_LLM_API_BASES", {"http://127.0.0.1:11434/v1"}),
        ):
            normalized = api._normalize_api_base("http://127.0.0.1:11434/v1", request=request)

        self.assertEqual(normalized, "http://127.0.0.1:11434/v1")

    def test_proxy_secret_cannot_bypass_api_base_allowlist_for_loopback_targets(self):
        request = Request(
            {
                "type": "http",
                "client": ("127.0.0.1", 55443),
                "headers": [
                    (b"host", b"public.example"),
                    (b"x-forwarded-for", b"198.51.100.25"),
                    (api.LLM_PROXY_SECRET_HEADER.encode("utf-8"), b"proxy-secret"),
                ],
            }
        )

        with (
            patch.object(api, "WIKIRACE_LLM_PROXY_SHARED_SECRET", "proxy-secret"),
            patch.object(api, "WIKIRACE_ALLOWED_LLM_API_BASES", set()),
        ):
            with self.assertRaises(HTTPException) as ctx:
                api._normalize_api_base("http://127.0.0.1:11434/v1", request=request)

        self.assertEqual(ctx.exception.status_code, 400)

    def test_proxy_secret_mode_rejects_bare_loopback_requests_without_secret(self):
        request = Request(
            {
                "type": "http",
                "client": ("127.0.0.1", 55443),
                "headers": [(b"host", b"localhost:8000")],
            }
        )

        with (
            patch.object(api, "WIKIRACE_ALLOW_REMOTE_LLM_API", False),
            patch.object(api, "WIKIRACE_LLM_PROXY_SHARED_SECRET", "proxy-secret"),
        ):
            with self.assertRaises(HTTPException) as ctx:
                api._require_local_llm_request(request)

        self.assertEqual(ctx.exception.status_code, 403)

    def test_public_host_requires_proxy_secret_for_llm_requests(self):
        request = Request(
            {
                "type": "http",
                "client": ("127.0.0.1", 55443),
                "headers": [(b"host", b"localhost:8000")],
            }
        )

        with (
            patch.dict("os.environ", {"WIKIRACE_PUBLIC_HOST": "https://public.example"}),
            patch.object(api, "WIKIRACE_ALLOW_REMOTE_LLM_API", False),
            patch.object(api, "WIKIRACE_LLM_PROXY_SHARED_SECRET", None),
        ):
            with self.assertRaises(HTTPException) as ctx:
                api._require_local_llm_request(request)

        self.assertEqual(ctx.exception.status_code, 403)

    def test_public_host_url_is_normalized_for_cors_origins(self):
        with patch.dict("os.environ", {"WIKIRACE_PUBLIC_HOST": "https://public.example"}):
            origins = api._default_cors_allowed_origins()

        self.assertIn("https://public.example", origins)
        self.assertNotIn("http://https://public.example:5173", origins)

    def test_public_host_host_only_value_preserves_dev_port_origins(self):
        with patch.dict("os.environ", {"WIKIRACE_PUBLIC_HOST": "public.example"}):
            origins = api._default_cors_allowed_origins()

        self.assertIn("http://public.example:5173", origins)
        self.assertIn("http://public.example:4173", origins)
        self.assertIn("http://public.example:8000", origins)

    def test_public_host_url_is_normalized_for_room_join_url(self):
        with (
            patch.dict("os.environ", {"WIKIRACE_PUBLIC_HOST": "https://public.example"}),
            TestClient(api.app, base_url="http://localhost:8000") as client,
        ):
            response = client.post(
                "/rooms",
                json={
                    "start_article": "Cat",
                    "destination_article": "Dog",
                    "owner_name": "Host",
                },
            )

        self.assertEqual(response.status_code, 200)
        self.assertRegex(response.json()["join_url"], r"^https://public\.example/\?room=room_")
        self.assertNotIn("http://https://public.example", response.json()["join_url"])

    def test_standard_forwarded_header_rejects_loopback_socket_without_proxy_secret(self):
        request = Request(
            {
                "type": "http",
                "client": ("127.0.0.1", 55443),
                "headers": [
                    (b"host", b"localhost:8000"),
                    (b"forwarded", b"for=198.51.100.25;host=public.example;proto=https"),
                ],
            }
        )

        with (
            patch.dict("os.environ", {"WIKIRACE_PUBLIC_HOST": ""}),
            patch.object(api, "WIKIRACE_ALLOW_REMOTE_LLM_API", False),
            patch.object(api, "WIKIRACE_LLM_PROXY_SHARED_SECRET", None),
        ):
            with self.assertRaises(HTTPException) as ctx:
                api._require_local_llm_request(request)

        self.assertEqual(ctx.exception.status_code, 403)

    def test_spoofed_loopback_forwarded_for_rejects_without_proxy_secret(self):
        request = Request(
            {
                "type": "http",
                "client": ("127.0.0.1", 55443),
                "headers": [
                    (b"host", b"localhost:8000"),
                    (b"x-forwarded-for", b"127.0.0.1"),
                ],
            }
        )

        with (
            patch.dict("os.environ", {"WIKIRACE_PUBLIC_HOST": ""}),
            patch.object(api, "WIKIRACE_ALLOW_REMOTE_LLM_API", False),
            patch.object(api, "WIKIRACE_LLM_PROXY_SHARED_SECRET", None),
        ):
            with self.assertRaises(HTTPException) as ctx:
                api._require_local_llm_request(request)

        self.assertEqual(ctx.exception.status_code, 403)

    def test_call_llm_cancellation_drains_before_releasing_semaphore(self):
        provider_started = asyncio.Event()
        provider_continue = asyncio.Event()

        async def never_returns(**_: object):
            provider_started.set()
            try:
                await provider_continue.wait()
            except asyncio.CancelledError:
                await provider_continue.wait()
                raise
            return SimpleNamespace(content="ignored", usage=None)

        async def run_test():
            call_task = asyncio.create_task(
                api._call_llm(
                    "prompt",
                    model="openai:gpt-5.2",
                    max_tokens=None,
                    api_base=None,
                    openai_api_mode=None,
                    openai_reasoning_effort=None,
                    openai_reasoning_summary=None,
                    anthropic_thinking_budget_tokens=None,
                    google_thinking_config=None,
                )
            )
            await asyncio.wait_for(provider_started.wait(), timeout=1.0)

            call_task.cancel()
            await asyncio.sleep(0)
            self.assertTrue(api.LLM_CALL_SEMAPHORE.locked())

            with self.assertRaises(asyncio.CancelledError):
                await asyncio.wait_for(call_task, timeout=1.0)

            with self.assertRaises(asyncio.TimeoutError):
                await asyncio.wait_for(api.LLM_CALL_SEMAPHORE.acquire(), timeout=0.05)

            provider_continue.set()
            await asyncio.wait_for(api.LLM_CALL_SEMAPHORE.acquire(), timeout=1.0)
            api.LLM_CALL_SEMAPHORE.release()

            await asyncio.sleep(0)

        with (
            patch.object(api, "achat", side_effect=never_returns),
            patch.object(api, "LLM_CALL_SEMAPHORE", asyncio.Semaphore(1)),
            patch.object(api, "LLM_CANCEL_DRAIN_TIMEOUT_SECONDS", 0.01),
        ):
            asyncio.run(run_test())

    def test_cancel_room_run_drains_cancelled_ai_task_after_releasing_room_lock(self):
        async def run_test():
            room_id = "room_CANCEL"
            owner_player_id = "player_OWNER"
            owner_player_token = api._issue_room_player_token(room_id, owner_player_id)
            api.ROOMS[room_id] = {
                "id": room_id,
                "owner_player_id": owner_player_id,
                "status": "running",
                "start_article": "Start",
                "destination_article": "Target",
                "rules": {
                    "max_hops": 20,
                    "max_links": None,
                    "max_tokens": None,
                    "include_image_links": False,
                    "disable_links_view": False,
                },
                "players": [{"id": owner_player_id, "connected": True}],
                "runs": [
                    {
                        "id": "run_AI",
                        "kind": "llm",
                        "status": "running",
                        "result": None,
                        "steps": [{"type": "start", "article": "Start", "at": "2026-03-08T12:00:00Z"}],
                    }
                ],
                "created_at": "2026-03-08T12:00:00Z",
                "updated_at": "2026-03-08T12:00:00Z",
            }
            api.ROOM_LOCKS[room_id] = asyncio.Lock()
            api.ROOM_CONNECTIONS[room_id] = set()

            request = Request(
                {
                    "type": "http",
                    "client": ("127.0.0.1", 12345),
                    "headers": [
                        (
                            api.ROOM_PLAYER_TOKEN_HEADER.encode("utf-8"),
                            owner_player_token.encode("utf-8"),
                        )
                    ],
                }
            )

            cancelled_task = asyncio.create_task(asyncio.sleep(0))
            with (
                patch.object(api, "_cancel_room_task", return_value=cancelled_task) as cancel_mock,
                patch.object(
                    api,
                    "_await_cancelled_room_tasks",
                    new_callable=AsyncMock,
                ) as drain_mock,
            ):
                room = await api.cancel_room_run(
                    room_id,
                    "run_AI",
                    api.RoomRunControlRequest(requested_by_player_id=owner_player_id),
                    request,
                )

            cancel_mock.assert_called_once_with(room_id, "run_AI")
            drain_mock.assert_awaited_once()
            self.assertEqual(room["runs"][0]["status"], "finished")
            self.assertEqual(room["runs"][0]["result"], "lose")
            self.assertEqual(room["runs"][0]["steps"][-1]["metadata"]["reason"], "cancelled")

            await cancelled_task

        asyncio.run(run_test())

    def test_await_cancelled_room_tasks_times_out_without_waiting_for_stubborn_tasks(self):
        task_started = asyncio.Event()
        task_can_finish = asyncio.Event()

        async def stubborn_task():
            task_started.set()
            try:
                await task_can_finish.wait()
            except asyncio.CancelledError:
                await task_can_finish.wait()
                raise

        async def run_test():
            task = asyncio.create_task(stubborn_task())
            await asyncio.wait_for(task_started.wait(), timeout=1.0)

            task.cancel()
            await asyncio.wait_for(api._await_cancelled_room_tasks([task]), timeout=1.0)
            self.assertFalse(task.done())

            task_can_finish.set()
            with self.assertRaises(asyncio.CancelledError):
                await asyncio.wait_for(task, timeout=1.0)
            await asyncio.sleep(0)

        with patch.object(api, "ROOM_TASK_CANCEL_DRAIN_TIMEOUT_SECONDS", 0.01):
            asyncio.run(run_test())

    def test_llm_chat_rejects_remote_requests_before_calling_provider(self):
        request = Request(
            {
                "type": "http",
                "client": ("192.168.10.25", 55443),
                "headers": [],
            }
        )
        body = api.LLMChatRequest(model="openai:gpt-5.2", prompt="hello")

        with patch.object(api, "WIKIRACE_ALLOW_REMOTE_LLM_API", False):
            with patch.object(api, "achat", new_callable=AsyncMock) as achat_mock:
                with self.assertRaises(HTTPException) as ctx:
                    asyncio.run(api.llm_chat(body, request))

        self.assertEqual(ctx.exception.status_code, 403)
        achat_mock.assert_not_called()

    def test_custom_api_base_must_be_localhost_or_allowlisted(self):
        self.assertEqual(
            api._normalize_api_base("http://localhost:8000/v1/"),
            "http://localhost:8000/v1",
        )

        with self.assertRaises(HTTPException) as ctx:
            api._normalize_api_base("https://evil.example/v1")

        self.assertEqual(ctx.exception.status_code, 400)

    def test_custom_api_base_must_not_include_userinfo(self):
        with self.assertRaises(HTTPException) as ctx:
            api._normalize_api_base("http://user:pass@localhost:8000/v1")

        self.assertEqual(ctx.exception.status_code, 400)

        with TestClient(api.app) as client:
            with patch.object(api, "achat", new_callable=AsyncMock) as achat_mock:
                response = client.post(
                    "/llm/chat",
                    json={
                        "model": "openai:gpt-5.2",
                        "prompt": "hello",
                        "api_base": "http://user:pass@localhost:8000/v1",
                    },
                )

        self.assertEqual(response.status_code, 400)
        self.assertEqual(
            response.json(),
            {"detail": "api_base must not include username or password"},
        )
        achat_mock.assert_not_called()

    def test_remote_llm_requests_cannot_proxy_to_loopback_api_base(self):
        request = Request(
            {
                "type": "http",
                "client": ("192.168.10.25", 55443),
                "headers": [],
            }
        )
        body = api.LLMChatRequest(
            model="openai:gpt-5.2",
            prompt="hello",
            api_base="http://127.0.0.1:11434/v1",
        )

        with patch.object(api, "WIKIRACE_ALLOW_REMOTE_LLM_API", True):
            with patch.object(api, "achat", new_callable=AsyncMock) as achat_mock:
                with self.assertRaises(HTTPException) as ctx:
                    asyncio.run(api.llm_chat(body, request))

        self.assertEqual(ctx.exception.status_code, 400)
        achat_mock.assert_not_called()

    def test_room_owner_actions_require_private_player_token(self):
        with TestClient(api.app) as client:
            create_response = client.post(
                "/rooms",
                json={
                    "start_article": "Cat",
                    "destination_article": "Dog",
                    "owner_name": "Host",
                },
            )
            self.assertEqual(create_response.status_code, 200)
            create_payload = create_response.json()
            room_id = create_payload["room_id"]
            owner_id = create_payload["owner_player_id"]
            owner_token = create_payload["owner_player_token"]

            self.assertNotIn("owner_player_token", create_payload["room"])

            join_response = client.post(
                f"/rooms/{room_id}/join",
                json={"name": "Guest"},
            )
            self.assertEqual(join_response.status_code, 200)
            join_payload = join_response.json()
            guest_token = join_payload["player_token"]

            missing_token = client.post(
                f"/rooms/{room_id}/start",
                json={"player_id": owner_id},
            )
            self.assertEqual(missing_token.status_code, 403)

            wrong_token = client.post(
                f"/rooms/{room_id}/start",
                json={"player_id": owner_id},
                headers={api.ROOM_PLAYER_TOKEN_HEADER: guest_token},
            )
            self.assertEqual(wrong_token.status_code, 403)

            allowed = client.post(
                f"/rooms/{room_id}/start",
                json={"player_id": owner_id},
                headers={api.ROOM_PLAYER_TOKEN_HEADER: owner_token},
            )
            self.assertEqual(allowed.status_code, 200)

    def test_get_room_requires_private_player_token(self):
        with TestClient(api.app) as client:
            create_response = client.post(
                "/rooms",
                json={
                    "start_article": "Cat",
                    "destination_article": "Dog",
                    "owner_name": "Host",
                },
            )
            self.assertEqual(create_response.status_code, 200)
            create_payload = create_response.json()
            room_id = create_payload["room_id"]
            owner_id = create_payload["owner_player_id"]
            owner_token = create_payload["owner_player_token"]

            missing = client.get(f"/rooms/{room_id}")
            self.assertEqual(missing.status_code, 403)

            wrong = client.get(
                f"/rooms/{room_id}?player_id={owner_id}",
                headers={api.ROOM_PLAYER_TOKEN_HEADER: "bad"},
            )
            self.assertEqual(wrong.status_code, 403)

            allowed = client.get(
                f"/rooms/{room_id}?player_id={owner_id}",
                headers={api.ROOM_PLAYER_TOKEN_HEADER: owner_token},
            )
            self.assertEqual(allowed.status_code, 200)
            self.assertEqual(allowed.json()["id"], room_id)

    def test_room_move_abandon_and_cancel_require_private_player_token(self):
        with TestClient(api.app) as client:
            create_response = client.post(
                "/rooms",
                json={
                    "start_article": "Cat",
                    "destination_article": "Dog",
                    "owner_name": "Host",
                },
            )
            self.assertEqual(create_response.status_code, 200)
            create_payload = create_response.json()
            room_id = create_payload["room_id"]
            owner_id = create_payload["owner_player_id"]
            owner_token = create_payload["owner_player_token"]

            join_response = client.post(
                f"/rooms/{room_id}/join",
                json={"name": "Guest"},
            )
            self.assertEqual(join_response.status_code, 200)
            guest_token = join_response.json()["player_token"]

            start_response = client.post(
                f"/rooms/{room_id}/start",
                json={"player_id": owner_id},
                headers={api.ROOM_PLAYER_TOKEN_HEADER: owner_token},
            )
            self.assertEqual(start_response.status_code, 200)
            owner_run_id = next(
                run["id"]
                for run in start_response.json()["runs"]
                if run["kind"] == "human" and run.get("player_id") == owner_id
            )

            missing_move_token = client.post(
                f"/rooms/{room_id}/move",
                json={"player_id": owner_id, "to_article": "Dog"},
            )
            wrong_move_token = client.post(
                f"/rooms/{room_id}/move",
                json={"player_id": owner_id, "to_article": "Dog"},
                headers={api.ROOM_PLAYER_TOKEN_HEADER: guest_token},
            )

            self.assertEqual(missing_move_token.status_code, 403)
            self.assertEqual(wrong_move_token.status_code, 403)
            owner_run = next(
                run
                for run in api.ROOMS[room_id]["runs"]
                if isinstance(run, dict) and run.get("id") == owner_run_id
            )
            self.assertEqual(owner_run["status"], "running")
            self.assertEqual(len(owner_run["steps"]), 1)

            missing_abandon_token = client.post(
                f"/rooms/{room_id}/runs/{owner_run_id}/abandon",
                json={"requested_by_player_id": owner_id},
            )
            wrong_abandon_token = client.post(
                f"/rooms/{room_id}/runs/{owner_run_id}/abandon",
                json={"requested_by_player_id": owner_id},
                headers={api.ROOM_PLAYER_TOKEN_HEADER: guest_token},
            )
            self.assertEqual(missing_abandon_token.status_code, 403)
            self.assertEqual(wrong_abandon_token.status_code, 403)
            self.assertEqual(owner_run["status"], "running")
            self.assertEqual(len(owner_run["steps"]), 1)

            allowed_abandon = client.post(
                f"/rooms/{room_id}/runs/{owner_run_id}/abandon",
                json={"requested_by_player_id": owner_id},
                headers={api.ROOM_PLAYER_TOKEN_HEADER: owner_token},
            )
            self.assertEqual(allowed_abandon.status_code, 200)

            with patch.object(api, "_start_llm_room_task") as start_task_mock:
                add_llm_response = client.post(
                    f"/rooms/{room_id}/add_llm",
                    json={
                        "requested_by_player_id": owner_id,
                        "model": "openai-responses:gpt-5.2",
                    },
                    headers={api.ROOM_PLAYER_TOKEN_HEADER: owner_token},
                )
            self.assertEqual(add_llm_response.status_code, 200)
            llm_run_id = next(
                run["id"]
                for run in add_llm_response.json()["runs"]
                if run["kind"] == "llm"
            )
            start_task_mock.assert_called_once_with(room_id, llm_run_id)

            missing_cancel_token = client.post(
                f"/rooms/{room_id}/runs/{llm_run_id}/cancel",
                json={"requested_by_player_id": owner_id},
            )
            wrong_cancel_token = client.post(
                f"/rooms/{room_id}/runs/{llm_run_id}/cancel",
                json={"requested_by_player_id": owner_id},
                headers={api.ROOM_PLAYER_TOKEN_HEADER: guest_token},
            )
            llm_run = next(
                run
                for run in api.ROOMS[room_id]["runs"]
                if isinstance(run, dict) and run.get("id") == llm_run_id
            )
            self.assertEqual(missing_cancel_token.status_code, 403)
            self.assertEqual(wrong_cancel_token.status_code, 403)
            self.assertEqual(llm_run["status"], "running")

            allowed_cancel = client.post(
                f"/rooms/{room_id}/runs/{llm_run_id}/cancel",
                json={"requested_by_player_id": owner_id},
                headers={api.ROOM_PLAYER_TOKEN_HEADER: owner_token},
            )
            self.assertEqual(allowed_cancel.status_code, 200)

    def test_add_llm_rejects_remote_requests_before_starting_room_tasks(self):
        with TestClient(api.app) as client:
            create_response = client.post(
                "/rooms",
                json={
                    "start_article": "Cat",
                    "destination_article": "Dog",
                    "owner_name": "Host",
                },
            )
            self.assertEqual(create_response.status_code, 200)
            create_payload = create_response.json()
            room_id = create_payload["room_id"]
            owner_id = create_payload["owner_player_id"]
            owner_token = create_payload["owner_player_token"]

        request = Request(
            {
                "type": "http",
                "client": ("192.168.10.25", 55443),
                "headers": [(api.ROOM_PLAYER_TOKEN_HEADER.lower().encode("utf-8"), owner_token.encode("utf-8"))],
            }
        )
        body = api.AddLlmRunRequest(
            model="openai-responses:gpt-5.2",
            requested_by_player_id=owner_id,
        )

        with patch.object(api, "WIKIRACE_ALLOW_REMOTE_LLM_API", False):
            with patch.object(api, "_start_llm_room_task") as start_task_mock:
                with self.assertRaises(HTTPException) as ctx:
                    asyncio.run(api.add_llm_run(room_id, body, request))

        self.assertEqual(ctx.exception.status_code, 403)
        start_task_mock.assert_not_called()

    def test_start_room_rejects_remote_requests_before_starting_queued_llm_runs(self):
        with TestClient(api.app) as client:
            create_response = client.post(
                "/rooms",
                json={
                    "start_article": "Cat",
                    "destination_article": "Dog",
                    "owner_name": "Host",
                },
            )
            self.assertEqual(create_response.status_code, 200)
            create_payload = create_response.json()
            room_id = create_payload["room_id"]
            owner_id = create_payload["owner_player_id"]
            owner_token = create_payload["owner_player_token"]

            add_response = client.post(
                f"/rooms/{room_id}/add_llm",
                json={
                    "model": "openai-responses:gpt-5.2",
                    "requested_by_player_id": owner_id,
                },
                headers={api.ROOM_PLAYER_TOKEN_HEADER: owner_token},
            )
            self.assertEqual(add_response.status_code, 200)

        request = Request(
            {
                "type": "http",
                "client": ("192.168.10.25", 55443),
                "headers": [
                    (
                        api.ROOM_PLAYER_TOKEN_HEADER.lower().encode("utf-8"),
                        owner_token.encode("utf-8"),
                    )
                ],
            }
        )
        body = api.StartRoomRequest(player_id=owner_id)

        with patch.object(api, "WIKIRACE_ALLOW_REMOTE_LLM_API", False):
            with patch.object(api, "_start_llm_room_task") as start_task_mock:
                with self.assertRaises(HTTPException) as ctx:
                    asyncio.run(api.start_room(room_id, body, request))

        self.assertEqual(ctx.exception.status_code, 403)
        start_task_mock.assert_not_called()
        self.assertEqual(api.ROOMS[room_id]["status"], "lobby")
        self.assertEqual(api.ROOMS[room_id]["runs"][1]["status"], "not_started")

    def test_restart_room_run_rejects_remote_requests_before_restarting_llm_runs(self):
        with TestClient(api.app) as client:
            create_response = client.post(
                "/rooms",
                json={
                    "start_article": "Cat",
                    "destination_article": "Dog",
                    "owner_name": "Host",
                },
            )
            self.assertEqual(create_response.status_code, 200)
            create_payload = create_response.json()
            room_id = create_payload["room_id"]
            owner_id = create_payload["owner_player_id"]
            owner_token = create_payload["owner_player_token"]

            add_response = client.post(
                f"/rooms/{room_id}/add_llm",
                json={
                    "model": "openai-responses:gpt-5.2",
                    "requested_by_player_id": owner_id,
                },
                headers={api.ROOM_PLAYER_TOKEN_HEADER: owner_token},
            )
            self.assertEqual(add_response.status_code, 200)
            run_id = add_response.json()["runs"][1]["id"]

        api.ROOMS[room_id]["status"] = "running"
        api.ROOMS[room_id]["runs"][1]["status"] = "finished"
        api.ROOMS[room_id]["runs"][1]["result"] = "lose"

        request = Request(
            {
                "type": "http",
                "client": ("192.168.10.25", 55443),
                "headers": [
                    (
                        api.ROOM_PLAYER_TOKEN_HEADER.lower().encode("utf-8"),
                        owner_token.encode("utf-8"),
                    )
                ],
            }
        )
        body = api.RoomRunControlRequest(requested_by_player_id=owner_id)

        with patch.object(api, "WIKIRACE_ALLOW_REMOTE_LLM_API", False):
            with patch.object(api, "_start_llm_room_task") as start_task_mock:
                with self.assertRaises(HTTPException) as ctx:
                    asyncio.run(api.restart_room_run(room_id, run_id, body, request))

        self.assertEqual(ctx.exception.status_code, 403)
        start_task_mock.assert_not_called()
        self.assertEqual(api.ROOMS[room_id]["runs"][1]["status"], "finished")

    def test_wiki_html_sanitizer_strips_active_content_before_bridge_injection(self):
        rewritten = api._rewrite_wiki_html(
            """
            <html>
              <head>
                <base href="https://evil.example/" />
                <link rel="modulepreload" href="https://evil.example/mod.js" />
                <script>window.evilScript = true</script>
              </head>
              <body onload="window.evilBody = true">
                <a href="javascript:alert(1)" onclick="window.evilClick = true">Bad</a>
                <img src="https://upload.wikimedia.org/example.png"
                     srcset="javascript:alert(1) 1x, https://upload.wikimedia.org/example@2x.png 2x"
                     onerror="window.evilImage = true" />
                <svg><a onload="window.evilSvg = true">svg</a></svg>
                <p style="background: url(javascript:alert(1))" data-mw="safe">Content</p>
              </body>
            </html>
            """
        )
        lowered = rewritten.lower()

        self.assertIn('<base href="https://simple.wikipedia.org/" />', rewritten)
        self.assertIn("wikirace:navigate_request", rewritten)
        self.assertIn('data-mw="safe"', rewritten)
        self.assertIn("Content", rewritten)
        self.assertNotIn("window.evilscript", lowered)
        self.assertNotIn("modulepreload", lowered)
        self.assertNotIn("javascript:", lowered)
        self.assertNotIn(" onclick", lowered)
        self.assertNotIn(" onload", lowered)
        self.assertNotIn(" onerror", lowered)
        self.assertNotIn("<svg", lowered)
        self.assertNotIn(" style=", lowered)
        self.assertNotIn("srcset=", lowered)

    def test_wiki_proxy_response_includes_csp_for_injected_bridge(self):
        async def fake_fetch(_: object) -> str:
            return api._rewrite_wiki_html("<html><body><p>Wiki content</p></body></html>")

        with TestClient(api.app) as client:
            with patch.object(api, "_fetch_rewritten_wiki_html", side_effect=fake_fetch):
                response = client.get("/wiki/Playwright_CSP_Test")

        self.assertEqual(response.status_code, 200)
        csp = response.headers.get("content-security-policy")
        self.assertIsNotNone(csp)
        self.assertIn("script-src 'sha256-", csp)
        script_src = csp.split("script-src ", 1)[1].split(";", 1)[0]
        self.assertNotIn("'unsafe-inline'", script_src)
        self.assertIn("script-src-attr 'none'", csp)
        self.assertIn("object-src 'none'", csp)
        self.assertIn("frame-src 'none'", csp)
        self.assertIn("frame-ancestors 'self'", csp)
        self.assertIn("http://localhost:5173", csp)
        self.assertIn("base-uri https://simple.wikipedia.org", csp)
        self.assertEqual(response.headers.get("x-content-type-options"), "nosniff")
        self.assertIn("wikirace:navigate_request", response.text)

    def test_wiki_proxy_csp_header_is_cached_for_hot_path(self):
        api._wiki_proxy_csp_header.cache_clear()
        call_count = 0

        def fake_allowed_origins() -> list[str]:
            nonlocal call_count
            call_count += 1
            return ["http://localhost:5173"]

        with patch.object(api, "_default_cors_allowed_origins", side_effect=fake_allowed_origins):
            first = api._wiki_proxy_headers("MISS")["Content-Security-Policy"]
            second = api._wiki_proxy_headers("HIT")["Content-Security-Policy"]

        self.assertEqual(call_count, 1)
        self.assertEqual(first, second)

    def test_cancelled_wiki_proxy_request_does_not_cancel_or_poison_shared_inflight(self):
        fetch_started = asyncio.Event()
        fetch_continue = asyncio.Event()

        async def fake_fetch(_: object) -> str:
            fetch_started.set()
            await fetch_continue.wait()
            return api._rewrite_wiki_html("<html><body><p>Wiki content</p></body></html>")

        async def run_test():
            with patch.object(api, "_fetch_rewritten_wiki_html", side_effect=fake_fetch):
                request_task = asyncio.create_task(api.wiki_proxy("Cancellation_Test"))
                await asyncio.wait_for(fetch_started.wait(), timeout=1.0)

                inflight = api._WIKI_PROXY_INFLIGHT.get("Cancellation_Test")
                self.assertIsNotNone(inflight)
                assert inflight is not None

                request_task.cancel()
                with self.assertRaises(asyncio.CancelledError):
                    await asyncio.wait_for(request_task, timeout=1.0)

                self.assertFalse(inflight.cancelled())

                fetch_continue.set()
                await asyncio.wait_for(inflight, timeout=1.0)

                for _ in range(10):
                    if "Cancellation_Test" not in api._WIKI_PROXY_INFLIGHT:
                        break
                    await asyncio.sleep(0)

                self.assertNotIn("Cancellation_Test", api._WIKI_PROXY_INFLIGHT)

        asyncio.run(run_test())

    def test_room_websocket_requires_player_credentials(self):
        with TestClient(api.app) as client:
            create_response = client.post(
                "/rooms",
                json={
                    "start_article": "Cat",
                    "destination_article": "Dog",
                    "owner_name": "Host",
                },
            )
            self.assertEqual(create_response.status_code, 200)
            payload = create_response.json()
            room_id = payload["room_id"]
            owner_id = payload["owner_player_id"]
            owner_token = payload["owner_player_token"]

            with client.websocket_connect(f"/rooms/{room_id}/ws") as websocket:
                self.assertEqual(
                    websocket.receive_json(),
                    {
                        "type": "room_error",
                        "detail": "Room credentials are invalid or expired. Please join the room again.",
                    },
                )
                with self.assertRaises(WebSocketDisconnect) as missing_ctx:
                    websocket.receive_json()
            self.assertEqual(missing_ctx.exception.code, 1008)

            with client.websocket_connect(
                f"/rooms/{room_id}/ws?player_id={owner_id}&ws_ticket=bad"
            ) as websocket:
                self.assertEqual(
                    websocket.receive_json(),
                    {
                        "type": "room_error",
                        "detail": "Room credentials are invalid or expired. Please join the room again.",
                    },
                )
                with self.assertRaises(WebSocketDisconnect) as wrong_ctx:
                    websocket.receive_json()
            self.assertEqual(wrong_ctx.exception.code, 1008)

            ticket_response = client.post(
                f"/rooms/{room_id}/ws_ticket",
                json={"player_id": owner_id},
                headers={api.ROOM_PLAYER_TOKEN_HEADER: owner_token},
            )
            self.assertEqual(ticket_response.status_code, 200)
            ws_ticket = ticket_response.json()["ws_ticket"]

            with client.websocket_connect(
                f"/rooms/{room_id}/ws?player_id={owner_id}&ws_ticket=bad"
            ) as websocket:
                self.assertEqual(
                    websocket.receive_json(),
                    {
                        "type": "room_error",
                        "detail": "Room credentials are invalid or expired. Please join the room again.",
                    },
                )
                with self.assertRaises(WebSocketDisconnect) as consumed_ctx:
                    websocket.receive_json()
            self.assertEqual(consumed_ctx.exception.code, 1008)

            with client.websocket_connect(
                f"/rooms/{room_id}/ws?player_id={owner_id}&ws_ticket={ws_ticket}"
            ) as websocket:
                message = websocket.receive_json()
                self.assertEqual(message["type"], "room_state")
                self.assertEqual(message["room"]["id"], room_id)

            with client.websocket_connect(
                f"/rooms/{room_id}/ws?player_id={owner_id}&ws_ticket={ws_ticket}"
            ) as websocket:
                self.assertEqual(
                    websocket.receive_json(),
                    {
                        "type": "room_error",
                        "detail": "Room credentials are invalid or expired. Please join the room again.",
                    },
                )
                with self.assertRaises(WebSocketDisconnect) as reused_ctx:
                    websocket.receive_json()
            self.assertEqual(reused_ctx.exception.code, 1008)

    def test_multiple_websocket_tickets_for_same_player_remain_valid(self):
        room_id = "room_TEST"
        player_id = "player_TEST"
        first_ticket = api._issue_room_ws_ticket(room_id, player_id)
        second_ticket = api._issue_room_ws_ticket(room_id, player_id)

        self.assertNotEqual(first_ticket, second_ticket)
        self.assertTrue(api._consume_room_ws_ticket(room_id, player_id, first_ticket))
        self.assertTrue(api._consume_room_ws_ticket(room_id, player_id, second_ticket))
        self.assertNotIn(room_id, api.ROOM_WS_TICKETS)

    def test_websocket_ticket_wrong_player_reuse_and_expiry_are_rejected(self):
        room_id = "room_TEST"
        player_id = "player_TEST"
        other_player_id = "player_OTHER"
        with patch("api.time.time", return_value=100.0):
            ticket = api._issue_room_ws_ticket(room_id, player_id)
            expiring_ticket = api._issue_room_ws_ticket(room_id, player_id)

        with patch("api.time.time", return_value=101.0):
            self.assertFalse(api._consume_room_ws_ticket(room_id, other_player_id, ticket))
            self.assertTrue(api._consume_room_ws_ticket(room_id, player_id, ticket))
            self.assertFalse(api._consume_room_ws_ticket(room_id, player_id, ticket))

        with patch("api.time.time", return_value=100.0 + api.WIKIRACE_ROOM_WS_TICKET_TTL_SECONDS + 1):
            self.assertFalse(api._consume_room_ws_ticket(room_id, player_id, expiring_ticket))
        self.assertNotIn(room_id, api.ROOM_WS_TICKETS)

    def test_fragment_only_human_moves_are_noops(self):
        with TestClient(api.app) as client:
            local_response = client.post(
                "/local/validate_move",
                json={
                    "current_article": "Cat",
                    "to_article": "#History",
                    "destination_article": "Dog",
                    "current_hops": 0,
                    "max_hops": 5,
                },
            )
            self.assertEqual(local_response.status_code, 200)
            self.assertEqual(local_response.json(), {"noop": True, "step": None})

            create_response = client.post(
                "/rooms",
                json={
                    "start_article": "Cat",
                    "destination_article": "Dog",
                    "owner_name": "Host",
                },
            )
            self.assertEqual(create_response.status_code, 200)
            payload = create_response.json()
            room_id = payload["room_id"]
            owner_id = payload["owner_player_id"]
            owner_token = payload["owner_player_token"]

            start_response = client.post(
                f"/rooms/{room_id}/start",
                json={"player_id": owner_id},
                headers={api.ROOM_PLAYER_TOKEN_HEADER: owner_token},
            )
            self.assertEqual(start_response.status_code, 200)
            start_steps = start_response.json()["runs"][0]["steps"]

            move_response = client.post(
                f"/rooms/{room_id}/move",
                json={"player_id": owner_id, "to_article": "#History"},
                headers={api.ROOM_PLAYER_TOKEN_HEADER: owner_token},
            )
            self.assertEqual(move_response.status_code, 200)
            room = move_response.json()
            self.assertEqual(room["runs"][0]["steps"], start_steps)

    def test_llm_chat_rejects_untrusted_api_base_before_calling_provider(self):
        with TestClient(api.app) as client:
            with patch.object(api, "achat", new_callable=AsyncMock) as achat_mock:
                response = client.post(
                    "/llm/chat",
                    json={
                        "model": "openai:gpt-5.2",
                        "prompt": "hello",
                        "api_base": "https://evil.example/v1",
                    },
                )

        self.assertEqual(response.status_code, 400)
        achat_mock.assert_not_called()

    def test_backend_hop_count_ignores_duplicate_same_article_steps(self):
        self.assertEqual(
            api._hop_count_from_steps(
                "Start",
                [
                    {"type": "start", "article": "Start"},
                    {"type": "move", "article": "Middle"},
                    {"type": "move", "article": "Middle"},
                    {"type": "lose", "article": "Middle"},
                ],
            ),
            1,
        )

    def test_backend_hop_count_ignores_fragment_only_same_article_steps(self):
        self.assertEqual(
            api._hop_count_from_steps(
                "Start",
                [
                    {"type": "start", "article": "Start"},
                    {"type": "move", "article": "Middle"},
                    {"type": "move", "article": "Middle#History"},
                    {"type": "lose", "article": "Middle#References"},
                ],
            ),
            1,
        )

    def test_env_nonnegative_float_falls_back_for_invalid_values(self):
        with patch.dict(
            api.os.environ,
            {"WIKIRACE_LLM_CANCEL_DRAIN_TIMEOUT_SECONDS": "not-a-number"},
        ):
            self.assertEqual(
                api._env_nonnegative_float(
                    "WIKIRACE_LLM_CANCEL_DRAIN_TIMEOUT_SECONDS",
                    0.25,
                ),
                0.25,
            )

    def test_backend_hop_count_treats_anchor_only_steps_as_noops(self):
        self.assertEqual(
            api._hop_count_from_steps(
                "Start",
                [
                    {"type": "start", "article": "Start"},
                    {"type": "move", "article": "#Section"},
                    {"type": "lose", "article": "#References"},
                ],
            ),
            0,
        )

    def test_local_llm_step_uses_transition_hops_for_duplicate_article_steps(self):
        request = Request(
            {
                "type": "http",
                "client": ("testclient", 55443),
                "headers": [(b"host", b"testserver")],
            }
        )
        body = api.LocalLlmStepRequest(
            start_article="Cat",
            destination_article="Dog",
            model="openai-responses:gpt-5.2",
            max_steps=3,
            steps=[
                {"type": "start", "article": "Cat", "at": api._now_iso()},
                {"type": "move", "article": "Canidae", "at": api._now_iso()},
                {"type": "move", "article": "Canidae", "at": api._now_iso()},
            ],
        )

        with patch.object(
            api,
            "_compute_llm_next_step",
            new_callable=AsyncMock,
            return_value=("move", "Canidae", None),
        ) as next_step_mock:
            asyncio.run(api.llm_local_run_step(body, request))

        self.assertEqual(next_step_mock.call_args.kwargs["next_hops"], 2)


class ApiRoomCleanupTests(unittest.IsolatedAsyncioTestCase):
    def tearDown(self):
        api.ROOMS.clear()
        api.ROOM_LOCKS.clear()
        api.ROOM_CONNECTIONS.clear()
        api.ROOM_CONNECTION_OWNERS.clear()
        api.ROOM_PLAYER_CONNECTION_COUNTS.clear()

    async def test_close_room_connections_closes_active_websockets(self):
        class DummyWebSocket:
            def __init__(self) -> None:
                self.closed_code: int | None = None

            async def close(self, code: int = 1000) -> None:
                self.closed_code = code

        ws = DummyWebSocket()
        api.ROOM_CONNECTIONS["room_TEST"] = {ws}
        api.ROOM_CONNECTION_OWNERS[ws] = ("room_TEST", "player_TEST")

        await api._close_room_connections("room_TEST")

        self.assertEqual(ws.closed_code, 1001)
        self.assertNotIn("room_TEST", api.ROOM_CONNECTIONS)
        self.assertNotIn(ws, api.ROOM_CONNECTION_OWNERS)

    async def test_player_stays_connected_until_all_websockets_close(self):
        room_id = "room_TEST"
        player_id = "player_TEST"
        api.ROOMS[room_id] = {
            "id": room_id,
            "updated_at": api._now_iso(),
            "players": [{"id": player_id, "name": "Host", "connected": False}],
            "runs": [],
        }
        api.ROOM_LOCKS[room_id] = asyncio.Lock()

        await api._set_player_connected(room_id, player_id, True)
        await api._set_player_connected(room_id, player_id, True)

        self.assertTrue(api.ROOMS[room_id]["players"][0]["connected"])
        self.assertEqual(api.ROOM_PLAYER_CONNECTION_COUNTS[room_id][player_id], 2)

        await api._set_player_connected(room_id, player_id, False)

        self.assertTrue(api.ROOMS[room_id]["players"][0]["connected"])
        self.assertEqual(api.ROOM_PLAYER_CONNECTION_COUNTS[room_id][player_id], 1)

        await api._set_player_connected(room_id, player_id, False)

        self.assertFalse(api.ROOMS[room_id]["players"][0]["connected"])
        self.assertNotIn(room_id, api.ROOM_PLAYER_CONNECTION_COUNTS)

    async def test_broadcast_send_failure_cleans_up_player_presence(self):
        room_id = "room_TEST"
        player_id = "player_TEST"

        class FailingWebSocket:
            async def send_text(self, _: str) -> None:
                raise RuntimeError("send failed")

        ws = FailingWebSocket()
        api.ROOMS[room_id] = {
            "id": room_id,
            "updated_at": api._now_iso(),
            "players": [{"id": player_id, "name": "Host", "connected": True}],
            "runs": [],
        }
        api.ROOM_LOCKS[room_id] = asyncio.Lock()
        api.ROOM_CONNECTIONS[room_id] = {ws}
        api.ROOM_CONNECTION_OWNERS[ws] = (room_id, player_id)
        api.ROOM_PLAYER_CONNECTION_COUNTS[room_id] = {player_id: 1}

        await api._broadcast_room(room_id)

        self.assertNotIn(ws, api.ROOM_CONNECTIONS.get(room_id, set()))
        self.assertNotIn(ws, api.ROOM_CONNECTION_OWNERS)
        self.assertNotIn(room_id, api.ROOM_PLAYER_CONNECTION_COUNTS)
        self.assertFalse(api.ROOMS[room_id]["players"][0]["connected"])

    async def test_room_ws_cleans_up_when_initial_send_fails(self):
        room_id = "room_TEST"
        player_id = "player_TEST"

        class FailingInitialSendWebSocket:
            def __init__(self) -> None:
                self.accepted = False
                self.sent_payloads: list[str] = []

            async def accept(self) -> None:
                self.accepted = True

            async def send_text(self, payload: str) -> None:
                self.sent_payloads.append(payload)
                if len(self.sent_payloads) >= 2:
                    raise RuntimeError("initial send failed")

            async def receive_text(self) -> str:
                raise AssertionError("receive loop should not start after send failure")

        ws = FailingInitialSendWebSocket()
        api.ROOMS[room_id] = {
            "id": room_id,
            "updated_at": api._now_iso(),
            "players": [{"id": player_id, "name": "Host", "connected": False}],
            "runs": [],
        }
        api.ROOM_LOCKS[room_id] = asyncio.Lock()
        api.ROOM_CONNECTIONS[room_id] = set()
        api.ROOM_PLAYER_CONNECTION_COUNTS[room_id] = {}
        ticket = api._issue_room_ws_ticket(room_id, player_id)

        await api.room_ws(ws, room_id, player_id=player_id, ws_ticket=ticket)

        self.assertTrue(ws.accepted)
        self.assertNotIn(ws, api.ROOM_CONNECTIONS.get(room_id, set()))
        self.assertNotIn(ws, api.ROOM_CONNECTION_OWNERS)
        self.assertNotIn(room_id, api.ROOM_PLAYER_CONNECTION_COUNTS)
        self.assertFalse(api.ROOMS[room_id]["players"][0]["connected"])


class ApiLlmCancellationTests(unittest.IsolatedAsyncioTestCase):
    def tearDown(self):
        api.ROOMS.clear()
        api.ROOM_LOCKS.clear()
        api.ROOM_CONNECTIONS.clear()
        api.ROOM_CONNECTION_OWNERS.clear()
        api.ROOM_PLAYER_CONNECTION_COUNTS.clear()
        api.ROOM_PLAYER_TOKENS.clear()
        api.ROOM_WS_TICKETS.clear()
        api.ROOM_TASKS.clear()
        api.ROOM_TASK_GENERATIONS.clear()

    async def test_cancelled_call_drains_before_releasing_semaphore(self):
        original_semaphore = api.LLM_CALL_SEMAPHORE
        original_drain_timeout = api.LLM_CANCEL_DRAIN_TIMEOUT_SECONDS
        api.LLM_CALL_SEMAPHORE = asyncio.Semaphore(1)
        api.LLM_CANCEL_DRAIN_TIMEOUT_SECONDS = 0.05

        started = asyncio.Event()
        release = asyncio.Event()

        async def fake_achat(**_: object):
            started.set()
            try:
                await release.wait()
            except asyncio.CancelledError:
                await release.wait()
                raise
            return type("Result", (), {"content": "ok", "usage": None})()

        try:
            with patch.object(api, "achat", side_effect=fake_achat):
                call_task = asyncio.create_task(
                    api._call_llm(
                        "prompt",
                        model="openai-responses:gpt-5.2",
                        max_tokens=None,
                        api_base=None,
                        openai_api_mode=None,
                        openai_reasoning_effort=None,
                        openai_reasoning_summary=None,
                        anthropic_thinking_budget_tokens=None,
                        google_thinking_config=None,
                    )
                )
                await asyncio.wait_for(started.wait(), timeout=1)

                call_task.cancel()
                await asyncio.sleep(0)
                self.assertTrue(api.LLM_CALL_SEMAPHORE.locked())

                with self.assertRaises(asyncio.CancelledError):
                    await asyncio.wait_for(call_task, timeout=1)

                self.assertTrue(api.LLM_CALL_SEMAPHORE.locked())
                with self.assertRaises(asyncio.TimeoutError):
                    await asyncio.wait_for(api.LLM_CALL_SEMAPHORE.acquire(), timeout=0.05)

                release.set()
                await asyncio.wait_for(api.LLM_CALL_SEMAPHORE.acquire(), timeout=1)
                api.LLM_CALL_SEMAPHORE.release()
                await asyncio.sleep(0)
        finally:
            api.LLM_CALL_SEMAPHORE = original_semaphore
            api.LLM_CANCEL_DRAIN_TIMEOUT_SECONDS = original_drain_timeout

    async def test_restart_room_run_waits_for_cancelled_old_task_before_starting_new_one(self):
        room_id = "room_TEST"
        run_id = "run_LLM"
        owner_id = "player_HOST"
        owner_token = "token_HOST"

        api.ROOMS[room_id] = {
            "id": room_id,
            "status": "running",
            "start_article": "Cat",
            "destination_article": "Dog",
            "updated_at": api._now_iso(),
            "owner_player_id": owner_id,
            "players": [{"id": owner_id, "name": "Host", "connected": True}],
            "runs": [
                {
                    "id": run_id,
                    "kind": "llm",
                    "status": "running",
                    "model": "openai-responses:gpt-5.2",
                    "started_at": api._now_iso(),
                    "finished_at": None,
                    "result": None,
                    "steps": [{"type": "start", "article": "Cat", "at": api._now_iso()}],
                }
            ],
        }
        api.ROOM_LOCKS[room_id] = asyncio.Lock()
        api.ROOM_PLAYER_TOKENS[room_id] = {owner_id: owner_token}

        old_task_ready = asyncio.Event()
        old_task_release = asyncio.Event()
        new_task_started = asyncio.Event()

        async def old_room_task():
            old_task_ready.set()
            try:
                await asyncio.sleep(3600)
            except asyncio.CancelledError:
                await old_task_release.wait()
                raise

        async def new_room_task(_: str, __: str, ___: int):
            self.assertTrue(old_task.done())
            new_task_started.set()

        old_task = asyncio.create_task(old_room_task())
        api.ROOM_TASKS[room_id] = {run_id: old_task}
        await asyncio.wait_for(old_task_ready.wait(), timeout=1)

        request = Request(
            {
                "type": "http",
                "client": ("testclient", 55443),
                "headers": [
                    (b"host", b"testserver"),
                    (api.ROOM_PLAYER_TOKEN_HEADER.encode("utf-8"), owner_token.encode("utf-8")),
                ],
            }
        )
        body = api.RoomRunControlRequest(requested_by_player_id=owner_id)

        with patch.object(api, "_run_llm_room_task", side_effect=new_room_task):
            restart_task = asyncio.create_task(api.restart_room_run(room_id, run_id, body, request))
            await asyncio.sleep(0)
            self.assertFalse(restart_task.done())
            self.assertFalse(new_task_started.is_set())

            old_task_release.set()
            await asyncio.wait_for(restart_task, timeout=1)
            await asyncio.wait_for(new_task_started.wait(), timeout=1)

    async def test_new_round_waits_for_cancelled_room_tasks_before_returning(self):
        room_id = "room_TEST"
        run_id = "run_LLM"
        owner_id = "player_HOST"
        owner_token = "token_HOST"

        api.ROOMS[room_id] = {
            "id": room_id,
            "created_at": api._now_iso(),
            "updated_at": api._now_iso(),
            "owner_player_id": owner_id,
            "title": "Test room",
            "start_article": "Cat",
            "destination_article": "Dog",
            "rules": {
                "max_hops": 20,
                "max_links": None,
                "max_tokens": None,
                "include_image_links": False,
                "disable_links_view": False,
            },
            "status": "running",
            "started_at": api._now_iso(),
            "finished_at": None,
            "players": [{"id": owner_id, "name": "Host", "connected": True}],
            "runs": [
                {
                    "id": run_id,
                    "kind": "llm",
                    "status": "running",
                    "model": "openai-responses:gpt-5.2",
                    "started_at": api._now_iso(),
                    "finished_at": None,
                    "result": None,
                    "steps": [
                        {"type": "start", "article": "Cat", "at": api._now_iso()},
                        {"type": "move", "article": "Canidae", "at": api._now_iso()},
                    ],
                }
            ],
        }
        api.ROOM_LOCKS[room_id] = asyncio.Lock()
        api.ROOM_PLAYER_TOKENS[room_id] = {owner_id: owner_token}

        old_task_ready = asyncio.Event()
        old_task_release = asyncio.Event()

        async def old_room_task():
            old_task_ready.set()
            try:
                await asyncio.sleep(3600)
            except asyncio.CancelledError:
                await old_task_release.wait()
                raise

        old_task = asyncio.create_task(old_room_task())
        api.ROOM_TASKS[room_id] = {run_id: old_task}
        await asyncio.wait_for(old_task_ready.wait(), timeout=1)

        request = Request(
            {
                "type": "http",
                "client": ("testclient", 55443),
                "headers": [
                    (b"host", b"testserver"),
                    (api.ROOM_PLAYER_TOKEN_HEADER.encode("utf-8"), owner_token.encode("utf-8")),
                ],
            }
        )
        body = api.NewRoundRequest(
            player_id=owner_id,
            start_article="Cat",
            destination_article="Dog",
        )

        try:
            new_round_task = asyncio.create_task(api.new_round(room_id, body, request))
            await asyncio.sleep(0)
            self.assertFalse(new_round_task.done())

            old_task_release.set()
            room = await asyncio.wait_for(new_round_task, timeout=1)
        finally:
            old_task_release.set()
            await asyncio.gather(old_task, return_exceptions=True)

        self.assertEqual(room["status"], "lobby")
        self.assertEqual(api.ROOMS[room_id]["runs"][0]["status"], "not_started")

    async def test_restart_room_run_starts_replacement_after_cancel_drain_timeout(self):
        room_id = "room_TEST"
        run_id = "run_LLM"
        owner_id = "player_HOST"
        owner_token = "token_HOST"

        api.ROOMS[room_id] = {
            "id": room_id,
            "status": "running",
            "start_article": "Cat",
            "destination_article": "Dog",
            "updated_at": api._now_iso(),
            "owner_player_id": owner_id,
            "players": [{"id": owner_id, "name": "Host", "connected": True}],
            "runs": [
                {
                    "id": run_id,
                    "kind": "llm",
                    "status": "running",
                    "model": "openai-responses:gpt-5.2",
                    "started_at": api._now_iso(),
                    "finished_at": None,
                    "result": None,
                    "steps": [{"type": "start", "article": "Cat", "at": api._now_iso()}],
                }
            ],
        }
        api.ROOM_LOCKS[room_id] = asyncio.Lock()
        api.ROOM_PLAYER_TOKENS[room_id] = {owner_id: owner_token}

        old_task_ready = asyncio.Event()
        old_task_release = asyncio.Event()
        new_task_started = asyncio.Event()
        new_task_generation: int | None = None

        async def old_room_task():
            old_task_ready.set()
            try:
                await asyncio.sleep(3600)
            except asyncio.CancelledError:
                await old_task_release.wait()
                raise

        async def new_room_task(_: str, __: str, task_generation: int):
            nonlocal new_task_generation
            new_task_generation = task_generation
            new_task_started.set()

        old_task = asyncio.create_task(old_room_task())
        api.ROOM_TASKS[room_id] = {run_id: old_task}
        api.ROOM_TASK_GENERATIONS[room_id] = {run_id: 7}
        await asyncio.wait_for(old_task_ready.wait(), timeout=1)

        request = Request(
            {
                "type": "http",
                "client": ("testclient", 55443),
                "headers": [
                    (b"host", b"testserver"),
                    (api.ROOM_PLAYER_TOKEN_HEADER.encode("utf-8"), owner_token.encode("utf-8")),
                ],
            }
        )
        body = api.RoomRunControlRequest(requested_by_player_id=owner_id)

        try:
            with (
                patch.object(api, "ROOM_TASK_CANCEL_DRAIN_TIMEOUT_SECONDS", 0.01),
                patch.object(api, "_run_llm_room_task", side_effect=new_room_task),
            ):
                room = await asyncio.wait_for(
                    api.restart_room_run(room_id, run_id, body, request),
                    timeout=1,
                )
                await asyncio.wait_for(new_task_started.wait(), timeout=1)
        finally:
            old_task_release.set()
            await asyncio.gather(old_task, return_exceptions=True)
            replacement_task = api.ROOM_TASKS.get(room_id, {}).get(run_id)
            if replacement_task is not None:
                await asyncio.gather(replacement_task, return_exceptions=True)

        self.assertEqual(room["runs"][0]["status"], "running")
        self.assertEqual(len(room["runs"][0]["steps"]), 1)
        self.assertEqual(room["runs"][0]["steps"][0]["article"], "Cat")
        self.assertEqual(new_task_generation, 9)

    def test_completed_room_task_cleanup_clears_generation(self):
        async def run_test():
            room_id = "room_DONE"
            run_id = "run_LLM"

            async def complete_room_task(task_room_id: str, task_run_id: str, task_generation: int):
                self.assertEqual(task_room_id, room_id)
                self.assertEqual(task_run_id, run_id)
                self.assertEqual(task_generation, 1)

            with patch.object(api, "_run_llm_room_task", new=complete_room_task):
                api._start_llm_room_task(room_id, run_id)
                task = api.ROOM_TASKS[room_id][run_id]
                self.assertEqual(api.ROOM_TASK_GENERATIONS[room_id][run_id], 1)
                await asyncio.wait_for(task, timeout=1)
                await asyncio.sleep(0)

            self.assertNotIn(room_id, api.ROOM_TASKS)
            self.assertNotIn(room_id, api.ROOM_TASK_GENERATIONS)

        asyncio.run(run_test())

    def test_replaced_room_task_cleanup_preserves_new_generation(self):
        async def run_test():
            room_id = "room_REPLACE"
            run_id = "run_LLM"
            old_started = asyncio.Event()
            old_cancelled = asyncio.Event()
            new_started = asyncio.Event()
            new_release = asyncio.Event()

            async def room_task(_: str, __: str, task_generation: int):
                if task_generation == 1:
                    old_started.set()
                    try:
                        await asyncio.Event().wait()
                    except asyncio.CancelledError:
                        old_cancelled.set()
                        raise
                elif task_generation == 2:
                    new_started.set()
                    await new_release.wait()
                else:
                    self.fail(f"Unexpected task generation: {task_generation}")

            with patch.object(api, "_run_llm_room_task", new=room_task):
                api._start_llm_room_task(room_id, run_id)
                old_task = api.ROOM_TASKS[room_id][run_id]
                await asyncio.wait_for(old_started.wait(), timeout=1)

                api._start_llm_room_task(room_id, run_id, replace_existing=True)
                new_task = api.ROOM_TASKS[room_id][run_id]
                self.assertIsNot(new_task, old_task)
                await asyncio.wait_for(new_started.wait(), timeout=1)
                await asyncio.wait_for(old_cancelled.wait(), timeout=1)
                await asyncio.gather(old_task, return_exceptions=True)
                await asyncio.sleep(0)

                self.assertIs(api.ROOM_TASKS[room_id][run_id], new_task)
                self.assertEqual(api.ROOM_TASK_GENERATIONS[room_id][run_id], 2)

                new_release.set()
                await asyncio.wait_for(new_task, timeout=1)
                await asyncio.sleep(0)

            self.assertNotIn(room_id, api.ROOM_TASKS)
            self.assertNotIn(room_id, api.ROOM_TASK_GENERATIONS)

        asyncio.run(run_test())

    def test_done_room_task_cancel_helpers_clear_generation(self):
        async def run_test():
            room_id = "room_CANCEL_DONE"
            run_id = "run_LLM"
            task = asyncio.create_task(asyncio.sleep(0))
            await task

            api.ROOM_TASKS[room_id] = {run_id: task}
            api.ROOM_TASK_GENERATIONS[room_id] = {run_id: 3}
            self.assertIs(api._cancel_room_task(room_id, run_id), task)
            self.assertNotIn(room_id, api.ROOM_TASKS)
            self.assertNotIn(room_id, api.ROOM_TASK_GENERATIONS)

            task = asyncio.create_task(asyncio.sleep(0))
            await task
            api.ROOM_TASKS[room_id] = {run_id: task}
            api.ROOM_TASK_GENERATIONS[room_id] = {run_id: 4}
            self.assertEqual(api._cancel_room_tasks(room_id), [task])
            self.assertNotIn(room_id, api.ROOM_TASKS)
            self.assertNotIn(room_id, api.ROOM_TASK_GENERATIONS)

        asyncio.run(run_test())

    async def test_stale_room_task_generation_cannot_mutate_restarted_run(self):
        room_id = "room_TEST"
        run_id = "run_LLM"
        api.ROOMS[room_id] = {
            "id": room_id,
            "status": "running",
            "start_article": "Cat",
            "destination_article": "Dog",
            "updated_at": api._now_iso(),
            "owner_player_id": "player_HOST",
            "players": [{"id": "player_HOST", "name": "Host", "connected": True}],
            "runs": [
                {
                    "id": run_id,
                    "kind": "llm",
                    "status": "running",
                    "model": "openai-responses:gpt-5.2",
                    "started_at": api._now_iso(),
                    "finished_at": None,
                    "result": None,
                    "steps": [{"type": "start", "article": "Cat", "at": api._now_iso()}],
                }
            ],
        }
        api.ROOM_LOCKS[room_id] = asyncio.Lock()
        api.ROOM_TASK_GENERATIONS[room_id] = {run_id: 4}

        await api._finish_llm_run(
            room_id,
            run_id,
            "Dog",
            step_type="win",
            forced_article="Dog",
            expected_current="Cat",
            expected_task_generation=3,
        )
        await api._fail_llm_run(
            room_id,
            run_id,
            "Cat",
            expected_task_generation=3,
            reason="llm_error",
            error="stale",
        )

        run = api.ROOMS[room_id]["runs"][0]
        self.assertEqual(run["status"], "running")
        self.assertEqual(run["result"], None)
        self.assertEqual(len(run["steps"]), 1)
        self.assertEqual(run["steps"][0]["type"], "start")


if __name__ == "__main__":
    unittest.main()
