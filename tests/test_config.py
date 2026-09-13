import pytest

from app.config import ConfigurationError, Settings


def test_local_defaults_to_demo_seed_and_in_memory() -> None:
    settings = Settings.from_environment()

    assert settings.environment == "local"
    assert settings.seed_demo is True
    assert settings.dynamodb_table_name is None


def test_production_requires_dynamodb_and_disables_demo_seed(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setenv("ERP_ENVIRONMENT", "production")
    monkeypatch.setenv("ERP_SEED_DEMO", "false")

    with pytest.raises(ConfigurationError, match="DYNAMODB_TABLE_NAME"):
        Settings.from_environment()


def test_production_rejects_demo_seed(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("ERP_ENVIRONMENT", "production")
    monkeypatch.setenv("ERP_DYNAMODB_TABLE_NAME", "erp-data")
    monkeypatch.setenv("ERP_SEED_DEMO", "true")

    with pytest.raises(ConfigurationError, match="ERP_SEED_DEMO"):
        Settings.from_environment()


def test_staging_requires_persistent_storage(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("ERP_ENVIRONMENT", "staging")
    monkeypatch.delenv("ERP_DYNAMODB_TABLE_NAME", raising=False)

    with pytest.raises(ConfigurationError, match="DYNAMODB_TABLE_NAME"):
        Settings.from_environment()


def test_outbox_retention_configuration_is_bounded(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("ERP_ALERT_LEASE_SECONDS", "5")

    with pytest.raises(ConfigurationError, match="between 30 and 86400"):
        Settings.from_environment()
