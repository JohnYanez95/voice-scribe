#!/usr/bin/env python3
"""Export Voice Scribe API schemas as a combined JSON Schema file.

Writes docs/contract/runtime-contract.schema.json relative to the repo root.
Safe to run in CI. Re-running produces a byte-identical file (sort_keys=True,
fixed indentation, newline-terminated).

Usage:
    cd apps/api && python scripts/export_contract.py
"""
import json
import sys
from pathlib import Path

# Ensure the app package is importable when invoked from apps/api/
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from app.schemas import (  # noqa: E402
    ErrorResponse,
    HealthResponse,
    ModelInfo,
    ModelListResponse,
    ModelSwapRequest,
    ModelSwapResponse,
    TranscribeResponse,
    WsCompleteMessage,
    WsErrorMessage,
    WsSegmentMessage,
    WsStreamAckMessage,
    WsStreamCommittedMessage,
    WsStreamErrorMessage,
    WsStreamFinalMessage,
    WsStreamPartialMessage,
    WsStreamReadyMessage,
    WsStreamStartMessage,
)

# Stable ordering — determines the order of $defs keys before sort_keys
# alphabetises them. Listed here for readability; sort_keys ensures idempotency.
# Every Ws* class in app.schemas MUST appear here — enforced by
# test_contract_export.py::test_every_ws_schema_is_registered (the drift test
# alone only detects file-vs-code drift, not an unregistered model).
CONTRACT_MODELS = [
    HealthResponse,
    TranscribeResponse,
    ErrorResponse,
    ModelInfo,
    ModelListResponse,
    ModelSwapRequest,
    ModelSwapResponse,
    WsSegmentMessage,
    WsCompleteMessage,
    WsErrorMessage,
    WsStreamStartMessage,
    WsStreamReadyMessage,
    WsStreamPartialMessage,
    WsStreamCommittedMessage,
    WsStreamFinalMessage,
    WsStreamErrorMessage,
    WsStreamAckMessage,
]

OUTPUT_PATH = (
    Path(__file__).resolve().parents[3] / "docs" / "contract" / "runtime-contract.schema.json"
)


def build_contract_schema() -> dict:
    """Return the combined contract schema as a Python dict.

    Each key under $defs is a model name; the value is the full
    model_json_schema() output for that model. Self-contained per entry:
    nested $defs (e.g. ModelInfo inside ModelListResponse) are embedded
    within the entry that references them.
    """
    return {
        "$schema": "https://json-schema.org/draft/2020-12/schema",
        "title": "Voice Scribe Runtime Contract",
        "description": (
            "Machine-readable JSON Schema for all Voice Scribe API request and response bodies. "
            "Each entry under $defs is the standalone schema for one message type. "
            "Contract version equals the Voice Scribe git tag of the release that ships this file."
        ),
        "$defs": {
            model.__name__: model.model_json_schema()
            for model in CONTRACT_MODELS
        },
    }


def main() -> None:
    OUTPUT_PATH.parent.mkdir(parents=True, exist_ok=True)
    schema = build_contract_schema()
    OUTPUT_PATH.write_text(json.dumps(schema, indent=2, sort_keys=True) + "\n")
    print(f"Written: {OUTPUT_PATH}")


if __name__ == "__main__":
    main()
