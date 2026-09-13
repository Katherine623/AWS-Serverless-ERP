from __future__ import annotations

import os
from dataclasses import dataclass
from functools import lru_cache


class ConfigurationError(RuntimeError):
    """Raised when an unsafe deployment configuration is detected."""


def _parse_bool(value: str | None, *, default: bool) -> bool:
    if value is None:
        return default
    normalized = value.strip().lower()
    if normalized in {"1", "true", "yes", "on"}:
        return True
    if normalized in {"0", "false", "no", "off"}:
        return False
    raise ConfigurationError(f"Invalid boolean configuration value: {value!r}")


@dataclass(frozen=True)
class Settings:
    environment: str
    dynamodb_table_name: str | None
    alert_topic_arn: str | None
    seed_demo: bool

    @classmethod
    def from_environment(cls) -> Settings:
        environment = os.getenv("ERP_ENVIRONMENT", "local").strip().lower()
        if environment not in {"local", "test", "staging", "production"}:
            raise ConfigurationError(
                "ERP_ENVIRONMENT must be one of local, test, staging or production"
            )
        seed_demo = _parse_bool(
            os.getenv("ERP_SEED_DEMO"), default=environment in {"local", "test"}
        )
        table_name = os.getenv("ERP_DYNAMODB_TABLE_NAME") or None
        if environment == "production" and seed_demo:
            raise ConfigurationError("ERP_SEED_DEMO must be false in production")
        if environment == "production" and not table_name:
            raise ConfigurationError(
                "ERP_DYNAMODB_TABLE_NAME is required in production"
            )
        return cls(
            environment=environment,
            dynamodb_table_name=table_name,
            alert_topic_arn=os.getenv("ERP_ALERT_TOPIC_ARN") or None,
            seed_demo=seed_demo,
        )


@lru_cache(maxsize=1)
def get_settings() -> Settings:
    return Settings.from_environment()
