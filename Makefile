install:
	yarn install
	uv sync

build:
	yarn build

server:
	WIKISPEEDIA_DB_PATH=./parallel_eval/wikihop.db uv run uvicorn api:app --reload --port 8000

server-lan:
	WIKISPEEDIA_DB_PATH=./parallel_eval/wikihop.db uv run uvicorn api:app --reload --host 0.0.0.0 --port 8000

ui:
	yarn dev

ui-lan:
	yarn dev --host 0.0.0.0 --port 5173

multiplayer:
	yarn build
	WIKISPEEDIA_DB_PATH=./parallel_eval/wikihop.db uv run uvicorn api:app --host 0.0.0.0 --port 8000

test:
	yarn test

lint:
	yarn lint
	uv run ruff check . --fix

# One-shot Playwright UX audit (starts API + Vite, runs screenshots, then shuts down).
# Override defaults like:
#   make ux-audit UX_AUDIT_UI_PORT=5173 UX_AUDIT_API_PORT=8000 UX_AUDIT_OUT_DIR=docs/ux-audit
UX_AUDIT_UI_PORT ?= 5173
UX_AUDIT_API_PORT ?= 8000
UX_AUDIT_BASE_URL ?= http://localhost:$(UX_AUDIT_UI_PORT)
UX_AUDIT_OUT_DIR ?= docs/ux-audit

ux-audit:
	@bash -lc 'set -euo pipefail; \
		API_LOG=$$(mktemp -t wikirace-ux-audit-api.XXXXXX.log); \
		UI_LOG=$$(mktemp -t wikirace-ux-audit-ui.XXXXXX.log); \
		echo "Starting API server (logs: $$API_LOG)"; \
		WIKISPEEDIA_DB_PATH=./parallel_eval/wikihop.db uv run uvicorn api:app --port $(UX_AUDIT_API_PORT) >"$$API_LOG" 2>&1 & API_PID=$$!; \
		echo "Starting Vite dev server (logs: $$UI_LOG)"; \
		VITE_API_BASE=http://localhost:$(UX_AUDIT_API_PORT) yarn dev --port $(UX_AUDIT_UI_PORT) >"$$UI_LOG" 2>&1 & UI_PID=$$!; \
		cleanup() { \
			echo "Stopping servers..."; \
			kill $$UI_PID $$API_PID 2>/dev/null || true; \
		}; \
		trap cleanup EXIT; \
		echo "Waiting for API..."; \
		for i in $$(seq 1 60); do \
			curl -sf --max-time 1 http://localhost:$(UX_AUDIT_API_PORT)/health >/dev/null 2>&1 && break; \
			sleep 0.5; \
		done; \
		echo "Waiting for UI..."; \
		for i in $$(seq 1 60); do \
			curl -sf --max-time 1 http://localhost:$(UX_AUDIT_UI_PORT) >/dev/null 2>&1 && break; \
			sleep 0.5; \
		done; \
		echo "Running UX audit..."; \
		node scripts/generate-ux-audit.mjs --base-url "$(UX_AUDIT_BASE_URL)" --out-dir "$(UX_AUDIT_OUT_DIR)"'

ux-audit-headed:
	@bash -lc 'set -euo pipefail; \
		API_LOG=$$(mktemp -t wikirace-ux-audit-api.XXXXXX.log); \
		UI_LOG=$$(mktemp -t wikirace-ux-audit-ui.XXXXXX.log); \
		echo "Starting API server (logs: $$API_LOG)"; \
		WIKISPEEDIA_DB_PATH=./parallel_eval/wikihop.db uv run uvicorn api:app --port $(UX_AUDIT_API_PORT) >"$$API_LOG" 2>&1 & API_PID=$$!; \
		echo "Starting Vite dev server (logs: $$UI_LOG)"; \
		VITE_API_BASE=http://localhost:$(UX_AUDIT_API_PORT) yarn dev --port $(UX_AUDIT_UI_PORT) >"$$UI_LOG" 2>&1 & UI_PID=$$!; \
		cleanup() { \
			echo "Stopping servers..."; \
			kill $$UI_PID $$API_PID 2>/dev/null || true; \
		}; \
		trap cleanup EXIT; \
		echo "Waiting for API..."; \
		for i in $$(seq 1 60); do \
			curl -sf --max-time 1 http://localhost:$(UX_AUDIT_API_PORT)/health >/dev/null 2>&1 && break; \
			sleep 0.5; \
		done; \
		echo "Waiting for UI..."; \
		for i in $$(seq 1 60); do \
			curl -sf --max-time 1 http://localhost:$(UX_AUDIT_UI_PORT) >/dev/null 2>&1 && break; \
			sleep 0.5; \
		done; \
		echo "Running UX audit (headed)..."; \
		node scripts/generate-ux-audit.mjs --base-url "$(UX_AUDIT_BASE_URL)" --out-dir "$(UX_AUDIT_OUT_DIR)" --headed'
