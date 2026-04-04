from unittest.mock import patch

from fastapi.testclient import TestClient

from app.main import app

client = TestClient(app, raise_server_exceptions=False)


@patch("app.routes.models.AVAILABLE_MODELS", ["small", "large-v3"])
@patch("app.routes.models.get_current_model_name", return_value="large-v3")
def test_list_models_returns_all_available(mock_current):
    response = client.get("/models")
    assert response.status_code == 200
    data = response.json()
    assert len(data["models"]) == 2
    names = [m["name"] for m in data["models"]]
    assert "small" in names
    assert "large-v3" in names


@patch("app.routes.models.AVAILABLE_MODELS", ["small", "large-v3"])
@patch("app.routes.models.get_current_model_name", return_value="large-v3")
def test_list_models_shows_current(mock_current):
    response = client.get("/models")
    data = response.json()
    assert data["current_model"] == "large-v3"
    for m in data["models"]:
        if m["name"] == "large-v3":
            assert m["is_current"] is True
        else:
            assert m["is_current"] is False


@patch("app.routes.models.AVAILABLE_MODELS", ["small", "large-v3"])
@patch("app.routes.models.get_current_model_name", return_value="large-v3")
@patch("app.routes.models.swap_model")
def test_swap_model_success(mock_swap, mock_current):
    mock_swap.return_value = {
        "previous_model": "large-v3",
        "current_model": "small",
        "duration": 2.5,
    }
    response = client.post("/models/swap", json={"model_name": "small"})
    assert response.status_code == 200
    data = response.json()
    assert data["previous_model"] == "large-v3"
    assert data["current_model"] == "small"
    assert data["swap_duration"] == 2.5


@patch("app.routes.models.AVAILABLE_MODELS", ["small", "large-v3"])
def test_swap_model_invalid_name():
    response = client.post("/models/swap", json={"model_name": "nonexistent"})
    assert response.status_code == 400
    assert "not available" in response.json()["detail"]


@patch("app.routes.models.AVAILABLE_MODELS", ["small", "large-v3"])
@patch("app.routes.models.get_current_model_name", return_value="large-v3")
def test_swap_model_same_model_noop(mock_current):
    response = client.post("/models/swap", json={"model_name": "large-v3"})
    assert response.status_code == 200
    data = response.json()
    assert data["previous_model"] == "large-v3"
    assert data["current_model"] == "large-v3"
    assert data["swap_duration"] == 0.0


@patch("app.routes.models.AVAILABLE_MODELS", ["small", "large-v3"])
@patch("app.routes.models.get_current_model_name", return_value="large-v3")
@patch("app.routes.models.swap_model", side_effect=RuntimeError("Load failed"))
def test_swap_model_failure(mock_swap, mock_current):
    response = client.post("/models/swap", json={"model_name": "small"})
    assert response.status_code == 500
    assert "failed" in response.json()["detail"].lower()
