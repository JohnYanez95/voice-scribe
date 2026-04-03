.PHONY: dev build test gpu-check api web

COMPOSE := docker compose -f ops/docker/compose.dev.yml

dev: gpu-check
	$(COMPOSE) up --build -d
	cd apps/web && npm run dev

build:
	$(COMPOSE) build

test:
	cd apps/api && python -m pytest tests/ -v
	cd apps/web && npm test -- --run

gpu-check:
	@bash ops/scripts/bootstrap_gpu_check.sh

api:
	$(COMPOSE) up --build

web:
	cd apps/web && npm run dev
