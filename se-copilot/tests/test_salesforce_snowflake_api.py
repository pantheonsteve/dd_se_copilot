"""API smoke tests for Snowflake tab Salesforce endpoints."""

import sys
from pathlib import Path
from unittest.mock import AsyncMock

import pytest
from fastapi.testclient import TestClient

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))


@pytest.fixture
def client():
    from main import app

    return TestClient(app)


def test_salesforce_context_endpoint_ok(client, monkeypatch):
    monkeypatch.setattr(
        "main._resolve_company_meta_for_detail_key",
        lambda k: {
            "id": "co1",
            "name": "Acme",
            "domain": "",
            "notes": "",
            "is_defined": True,
            "created_at": "",
        },
    )
    monkeypatch.setattr(
        "main.list_company_resources",
        lambda cid: [{"resource_type": "homerun_opportunity", "resource_id": "opp-uuid-1"}],
    )
    monkeypatch.setattr(
        "main.fetch_homerun_dim_dict",
        AsyncMock(
            return_value={
                "SALESFORCE_OPPORTUNITY_ID": "006XX00000001AA",
                "OPPORTUNITY_NAME": "Test Opp",
            }
        ),
    )
    monkeypatch.setattr(
        "main.fetch_salesforce_context_rows",
        AsyncMock(
            return_value={
                "configured": True,
                "snowflake_enabled": True,
                "salesforce_opportunity_id": "006XX00000001AA",
                "columns": ["AMOUNT"],
                "rows": [{"AMOUNT": 100}],
                "message": None,
            }
        ),
    )

    r = client.get(
        "/api/companies/acme/snowflake/salesforce-context",
        params={"opportunity_uuid": "opp-uuid-1"},
    )
    assert r.status_code == 200
    data = r.json()
    assert data["rows"][0]["AMOUNT"] == 100
    assert data["opportunity_uuid"] == "opp-uuid-1"


def test_salesforce_summary_endpoint_ok(client, monkeypatch):
    monkeypatch.setattr(
        "main._resolve_company_meta_for_detail_key",
        lambda k: {
            "id": "co1",
            "name": "Acme",
            "domain": "",
            "notes": "",
            "is_defined": True,
            "created_at": "",
        },
    )
    monkeypatch.setattr(
        "main.list_company_resources",
        lambda cid: [{"resource_type": "homerun_opportunity", "resource_id": "opp-uuid-1"}],
    )
    monkeypatch.setattr(
        "main.fetch_homerun_dim_dict",
        AsyncMock(
            return_value={
                "SALESFORCE_OPPORTUNITY_ID": "006XX00000001AA",
                "OPPORTUNITY_NAME": "Test Opp",
            }
        ),
    )
    monkeypatch.setattr(
        "main.fetch_salesforce_context_rows",
        AsyncMock(
            return_value={
                "configured": True,
                "snowflake_enabled": True,
                "salesforce_opportunity_id": "006XX00000001AA",
                "columns": ["AMOUNT"],
                "rows": [{"AMOUNT": 100}],
                "message": None,
            }
        ),
    )
    monkeypatch.setattr(
        "main.summarize_salesforce_context_markdown",
        AsyncMock(return_value="## OK\n- row"),
    )

    r = client.post(
        "/api/companies/acme/snowflake/salesforce-summary",
        json={"opportunity_uuid": "opp-uuid-1"},
    )
    assert r.status_code == 200
    assert "OK" in r.json()["markdown"]
