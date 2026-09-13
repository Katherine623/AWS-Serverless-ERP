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


def _parse_int(value: str | None, *, default: int, minimum: int, maximum: int) -> int:
    if value is None:
        return default
    try:
        parsed = int(value.strip())
    except ValueError as exc:
        raise ConfigurationError(f"Invalid integer configuration value: {value!r}") from exc
    if not minimum <= parsed <= maximum:
        raise ConfigurationError(
            f"Configuration integer must be between {minimum} and {maximum}: {parsed}"
        )
    return parsed


@dataclass(frozen=True)
class Settings:
    environment: str
    dynamodb_table_name: str | None
    alert_topic_arn: str | None
    seed_demo: bool
    mcp_mutations_enabled: bool
    idempotency_ttl_days: int
    alert_outbox_ttl_days: int
    alert_lease_seconds: int

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
        if environment in {"staging", "production"} and seed_demo:
            raise ConfigurationError("ERP_SEED_DEMO must be false outside local/test")
        if environment in {"staging", "production"} and not table_name:
            raise ConfigurationError(
                "ERP_DYNAMODB_TABLE_NAME is required in staging/production"
            )
        return cls(
            environment=environment,
            dynamodb_table_name=table_name,
            alert_topic_arn=os.getenv("ERP_ALERT_TOPIC_ARN") or None,
            seed_demo=seed_demo,
            mcp_mutations_enabled=_parse_bool(
                os.getenv("ERP_MCP_MUTATIONS_ENABLED"), default=False
            ),
            idempotency_ttl_days=_parse_int(
                os.getenv("ERP_IDEMPOTENCY_TTL_DAYS"),
                default=90,
                minimum=1,
                maximum=3650,
            ),
            alert_outbox_ttl_days=_parse_int(
                os.getenv("ERP_ALERT_OUTBOX_TTL_DAYS"),
                default=30,
                minimum=1,
                maximum=3650,
            ),
            alert_lease_seconds=_parse_int(
                os.getenv("ERP_ALERT_LEASE_SECONDS"),
                default=300,
                minimum=30,
                maximum=86400,
            ),
        )


@lru_cache(maxsize=1)
def get_settings() -> Settings:
    return Settings.from_environment()
