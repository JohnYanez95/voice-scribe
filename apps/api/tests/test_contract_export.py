"""Contract drift detection test.

Verifies that docs/contract/runtime-contract.schema.json reflects the current
Pydantic schemas in app/schemas.py. Fails with a clear message if the committed
file is out of sync.

To regenerate:
    cd apps/api && python scripts/export_contract.py
"""
import json
import sys
from pathlib import Path

import pytest

# Make the export script importable without adding it to the package.
_SCRIPTS_DIR = Path(__file__).parent.parent / "scripts"
if str(_SCRIPTS_DIR) not in sys.path:
    sys.path.insert(0, str(_SCRIPTS_DIR))

from export_contract import build_contract_schema  # noqa: E402

_COMMITTED_PATH = (
    Path(__file__).parents[3] / "docs" / "contract" / "runtime-contract.schema.json"
)


def test_contract_schema_file_exists():
    assert _COMMITTED_PATH.exists(), (
        f"Contract schema file not found at {_COMMITTED_PATH}. "
        "Run: cd apps/api && python scripts/export_contract.py"
    )


def test_contract_schema_is_current():
    """Committed schema must match what export_contract.py generates today.

    If this test fails, the schemas.py models have changed without a
    corresponding schema regeneration. Fix:
        cd apps/api && python scripts/export_contract.py
    Then commit the updated runtime-contract.schema.json.
    """
    committed = json.loads(_COMMITTED_PATH.read_text())
    generated = build_contract_schema()

    assert committed == generated, (
        "runtime-contract.schema.json is out of sync with schemas.py.\n"
        "Regenerate with: cd apps/api && python scripts/export_contract.py\n"
        "Then commit docs/contract/runtime-contract.schema.json."
    )


def test_every_ws_schema_is_registered():
    """Guard against code-vs-reality drift (protocol C11.2).

    The drift test above compares the committed file against CONTRACT_MODELS —
    but CONTRACT_MODELS is enumerated by hand, so a new Ws* model added to
    schemas.py without registration would ship outside the published contract
    while every test stays green. This closes that hole.
    """
    import inspect

    from pydantic import BaseModel

    from app import schemas
    from export_contract import CONTRACT_MODELS

    ws_models = {
        obj
        for name, obj in inspect.getmembers(schemas, inspect.isclass)
        if name.startswith("Ws") and issubclass(obj, BaseModel)
    }
    unregistered = ws_models - set(CONTRACT_MODELS)
    assert not unregistered, (
        f"WebSocket message models missing from CONTRACT_MODELS: "
        f"{sorted(m.__name__ for m in unregistered)}. "
        "Register them in scripts/export_contract.py and regenerate the schema."
    )
