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
