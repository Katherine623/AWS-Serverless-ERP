from __future__ import annotations

import json
from pathlib import Path
from typing import Any
from urllib.parse import unquote

import boto3
from botocore.exceptions import BotoCoreError, ClientError

from app.models import InventorySnapshot


def load_demo_inventory(path: Path | None = None) -> InventorySnapshot:
    fixture_path = path or Path(__file__).resolve().parents[1] / "fixtures" / "demo_inventory.json"
    return InventorySnapshot.model_validate_json(fixture_path.read_text(encoding="utf-8"))


class AwsInventoryCollector:
    """Collects only metadata required by the current read-only governance rules."""

    def __init__(self, region: str) -> None:
        self.region = region
        self.session = boto3.Session(region_name=region)
        self.errors: list[str] = []

    def _record_error(self, service: str, exc: Exception) -> None:
        if isinstance(exc, ClientError):
            code = exc.response.get("Error", {}).get("Code", "ClientError")
            message = exc.response.get("Error", {}).get("Message", str(exc))
            self.errors.append(f"{service}: {code}: {message}")
        else:
            self.errors.append(f"{service}: {exc}")

    def _paginated_items(
        self, client: Any, operation: str, result_key: str, **kwargs: Any
    ) -> list[dict[str, Any]]:
        paginator = client.get_paginator(operation)
        return [item for page in paginator.paginate(**kwargs) for item in page.get(result_key, [])]

    def _identity(self) -> str:
        try:
            return self.session.client("sts").get_caller_identity()["Account"]
        except (BotoCoreError, ClientError) as exc:
            self._record_error("sts", exc)
            return "unknown"

    def _ec2(self) -> tuple[list[dict[str, Any]], list[dict[str, Any]], list[dict[str, Any]]]:
        try:
            client = self.session.client("ec2")
            groups = self._paginated_items(client, "describe_security_groups", "SecurityGroups")
            addresses = client.describe_addresses().get("Addresses", [])
            volumes = self._paginated_items(client, "describe_volumes", "Volumes")
            return groups, addresses, volumes
        except (BotoCoreError, ClientError) as exc:
            self._record_error("ec2", exc)
            return [], [], []

    def _logs(self) -> list[dict[str, Any]]:
        try:
            client = self.session.client("logs")
            return self._paginated_items(client, "describe_log_groups", "logGroups")
        except (BotoCoreError, ClientError) as exc:
            self._record_error("logs", exc)
            return []

    def _s3(self) -> list[dict[str, Any]]:
        try:
            client = self.session.client("s3")
            buckets: list[dict[str, Any]] = []
            for item in client.list_buckets().get("Buckets", []):
                name = item["Name"]
                location = client.get_bucket_location(Bucket=name).get("LocationConstraint")
                bucket_region = location or "us-east-1"
                try:
                    config = client.get_public_access_block(Bucket=name)[
                        "PublicAccessBlockConfiguration"
                    ]
                except ClientError as exc:
                    error_code = exc.response.get("Error", {}).get("Code")
                    if error_code == "NoSuchPublicAccessBlockConfiguration":
                        config = {}
                    else:
                        self._record_error(f"s3:{name}:public-access-block", exc)
                        config = {}
                buckets.append({**item, "Region": bucket_region, "PublicAccessBlock": config})
            return buckets
        except (BotoCoreError, ClientError) as exc:
            self._record_error("s3", exc)
            return []

    @staticmethod
    def _decode_policy(document: Any) -> dict[str, Any]:
        if isinstance(document, dict):
            return document
        if isinstance(document, str):
            return json.loads(unquote(document))
        return {}

    def _iam(self) -> list[dict[str, Any]]:
        try:
            client = self.session.client("iam")
            policies = self._paginated_items(client, "list_policies", "Policies", Scope="Local")
            enriched: list[dict[str, Any]] = []
            for policy in policies:
                version = client.get_policy_version(
                    PolicyArn=policy["Arn"], VersionId=policy["DefaultVersionId"]
                )["PolicyVersion"]
                enriched.append({**policy, "Document": self._decode_policy(version["Document"])})
            return enriched
        except (BotoCoreError, ClientError) as exc:
            self._record_error("iam", exc)
            return []

    def collect(self) -> InventorySnapshot:
        account_id = self._identity()
        security_groups, addresses, volumes = self._ec2()
        return InventorySnapshot(
            account_id=account_id,
            region=self.region,
            security_groups=security_groups,
            addresses=addresses,
            volumes=volumes,
            log_groups=self._logs(),
            buckets=self._s3(),
            iam_policies=self._iam(),
            collection_errors=self.errors,
        )
