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
