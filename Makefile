.PHONY: dev dev-cpu build test gpu-check api web desktop

COMPOSE := docker compose -f ops/docker/compose.dev.yml
export PATH := $(HOME)/.cargo/bin:$(PATH)

COMPOSE_CPU := docker compose -f ops/docker/compose.dev.yml -f ops/docker/compose.cpu.yml

dev: gpu-check
	$(COMPOSE) up --build -d
	cd apps/web && npm run dev

dev-cpu:
	$(COMPOSE_CPU) up --build -d
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

desktop:
	@cleanup() { \
		for pidfile in /tmp/voice-scribe-vite.pid /tmp/voice-scribe-sidecar.pid; do \
			if [ -f "$$pidfile" ]; then \
				kill $$(cat "$$pidfile") 2>/dev/null; \
				rm -f "$$pidfile"; \
			fi; \
		done; \
	}; \
	trap cleanup EXIT INT TERM; \
	cleanup; sleep 1; \
	if ! command -v ss >/dev/null 2>&1; then \
		echo "WARNING: ss not found — cannot verify port 8000 is free. Proceeding."; \
	elif ss -tln sport = :8000 2>/dev/null | grep -q LISTEN; then \
		echo "ERROR: Port 8000 is already in use (Docker container or another process)."; \
		echo "  Run: docker compose -f ops/docker/compose.dev.yml down"; \
		exit 1; \
	fi; \
	cd apps/web && node_modules/.bin/vite & echo $$! > /tmp/voice-scribe-vite.pid; \
	cd apps/desktop && cargo tauri dev; \
	cleanup
