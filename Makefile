.PHONY: dev dev-cpu build test gpu-check api web desktop desktop-cpu

COMPOSE := docker compose -f ops/docker/compose.dev.yml
export PATH := $(HOME)/.cargo/bin:$(PATH)

COMPOSE_CPU := docker compose -f ops/docker/compose.cpu.yml

# Configurable ports (defaults: API=8084, Web=5174)
export API_PORT ?= 8084
export WEB_PORT ?= 5174

dev: gpu-check
	$(COMPOSE) up --build -d
	cd apps/web && VITE_API_PORT=$(API_PORT) VITE_PORT=$(WEB_PORT) npm run dev

dev-cpu:
	$(COMPOSE_CPU) up --build -d
	cd apps/web && VITE_API_PORT=$(API_PORT) VITE_PORT=$(WEB_PORT) npm run dev

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
	cd apps/web && VITE_API_PORT=$(API_PORT) VITE_PORT=$(WEB_PORT) npm run dev

desktop: SIDECAR_ENV = WHISPER_MODEL=small WHISPER_AVAILABLE_MODELS=small,large-v3
desktop-cpu: SIDECAR_ENV = DEVICE=cpu WHISPER_MODEL=small WHISPER_AVAILABLE_MODELS=small

desktop desktop-cpu:
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
		echo "WARNING: ss not found — cannot verify port 8084 is free. Proceeding."; \
	elif ss -tln sport = :8084 2>/dev/null | grep -q LISTEN; then \
		echo "ERROR: Port 8084 is already in use (Docker container or another process)."; \
		echo "  Run: docker compose -f ops/docker/compose.dev.yml down"; \
		exit 1; \
	fi; \
	cd apps/web && node_modules/.bin/vite & echo $$! > /tmp/voice-scribe-vite.pid; \
	cd apps/desktop && $(SIDECAR_ENV) cargo tauri dev; \
	cleanup
