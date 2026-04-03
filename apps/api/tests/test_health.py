from unittest.mock import patch

from fastapi.testclient import TestClient

from app.main import app

client = TestClient(app, raise_server_exceptions=False)


@patch("app.routes.health.is_model_loaded", return_value=True)
def test_health_returns_ok(mock_loaded):
    response = client.get("/health")
    assert response.status_code == 200
    data = response.json()
    assert data["status"] == "ok"
    assert data["model_loaded"] is True
    assert "device" in data
    assert "model_name" in data


@patch("app.routes.health.is_model_loaded", return_value=False)
def test_health_model_not_loaded(mock_loaded):
    response = client.get("/health")
    assert response.status_code == 200
    data = response.json()
    assert data["model_loaded"] is False
