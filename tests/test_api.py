from fastapi.testclient import TestClient

from app.main import app

client = TestClient(app)


def test_health() -> None:
    response = client.get("/health")

    assert response.status_code == 200
    assert response.json()["status"] == "ok"


def test_demo_scan() -> None:
    response = client.post("/api/scans", json={"mode": "demo", "region": "ap-northeast-1"})

    assert response.status_code == 200
    payload = response.json()
    assert payload["mode"] == "demo"
    assert payload["summary"]["total_findings"] == 6
    assert payload["summary"]["governance_score"] == 24


def test_real_aws_scan_is_disabled_by_default() -> None:
    response = client.post("/api/scans", json={"mode": "aws", "region": "ap-northeast-1"})

    assert response.status_code == 403
    assert "ALLOW_AWS_SCAN" in response.json()["detail"]
