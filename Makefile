.PHONY: dev dev-cpu build test gpu-check api web desktop desktop-cpu

# Prefer the project venv (apps/api/.venv) — the same interpreter the Tauri
# sidecar picks up (main.rs) and the same version the Docker image runs (3.12).
# Falls back to whatever `python` is on PATH if the venv has not been built.
API_PY := $(shell [ -x $(CURDIR)/apps/api/.venv/bin/python ] && echo $(CURDIR)/apps/api/.venv/bin/python || echo python)

.PHONY: venv
venv:  ## Build apps/api/.venv from the pinned lock (matches CI exactly)
	cd apps/api && uv venv --python 3.12 .venv && \
		uv pip install -r requirements-dev.lock && \
		uv pip install -e . --no-deps && \
		uv pip install -e '.[gpu]' --no-deps
	@echo "venv ready — bare-host GPU runs need:"
	@echo "  export LD_LIBRARY_PATH=$$(pwd)/apps/api/.venv/lib/python3.12/site-packages/nvidia/cublas/lib:$$(pwd)/apps/api/.venv/lib/python3.12/site-packages/nvidia/cuda_nvrtc/lib"

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
	cd apps/api && $(API_PY) -m pytest tests/ -v
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
