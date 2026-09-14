#!/usr/bin/env python3
"""Preview and optionally remove legacy DEMO-* records from the ERP table."""

from __future__ import annotations

import argparse
import json
import os
import re
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

import boto3

DEMO_VALUE = re.compile(r"^DEMO-", re.IGNORECASE)
DEMO_FIELD = re.compile(
    r'"(?:po_id|material_id|reference_id|receipt_id|adjustment_id)"\s*:\s*"DEMO-',
    re.IGNORECASE,
)
TARGET_ENTITIES = {"receipt", "inventory_transaction", "inventory_adjustment", "alert_batch"}


def _has_demo_value(value: object) -> bool:
    return isinstance(value, str) and bool(DEMO_VALUE.match(value))


def is_demo_record(item: dict[str, Any]) -> bool:
    """Match only ERP records tied to a DEMO-* PO or material."""
    pk = str(item.get("PK", ""))
    if pk.startswith(("purchase_order#", "inventory#")):
        return _has_demo_value(pk.split("#", 1)[1])
    if str(item.get("entity", "")) not in TARGET_ENTITIES:
        return False
    data = item.get("data", "")
    return bool(DEMO_FIELD.search(data)) if isinstance(data, str) else False


def scan_demo_records(table: Any) -> list[dict[str, Any]]:
    records: list[dict[str, Any]] = []
    scan_kwargs: dict[str, Any] = {}
    while True:
        response = table.scan(**scan_kwargs)
        records.extend(item for item in response.get("Items", []) if is_demo_record(item))
        last_key = response.get("LastEvaluatedKey")
        if not last_key:
            return records
        scan_kwargs["ExclusiveStartKey"] = last_key


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--table",
        default=os.getenv("ERP_DYNAMODB_TABLE_NAME", "erp-receiving-platform-data"),
        help="DynamoDB table name.",
    )
    parser.add_argument("--region", default=os.getenv("AWS_REGION", "ap-northeast-1"))
    parser.add_argument("--profile", default=os.getenv("AWS_PROFILE"))
    parser.add_argument(
        "--backup-file",
        type=Path,
        default=None,
        help="Where to save matched records before deletion (default: /tmp).",
    )
    parser.add_argument("--apply", action="store_true", help="Delete the matched records.")
    parser.add_argument(
        "--confirm",
        default="",
        help="Must be DELETE-DEMO-DATA together with --apply.",
    )
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    session = boto3.Session(profile_name=args.profile, region_name=args.region)
    table = session.resource("dynamodb").Table(args.table)
    records = scan_demo_records(table)
    print(f"table={args.table} region={args.region} matched={len(records)}")
    for item in records:
        print(f"- {item.get('PK')} / {item.get('SK')} [{item.get('entity', '')}]")
    if not records:
        print("沒有找到符合 DEMO-* 的資料，不執行任何刪除。")
        return 0

    timestamp = datetime.now(UTC).strftime("%Y%m%dT%H%M%SZ")
    backup_file = args.backup_file or Path(f"/tmp/erp-demo-records-{timestamp}.json")
    backup_file.write_text(json.dumps(records, ensure_ascii=False, indent=2), encoding="utf-8")
    print(f"已備份命中資料：{backup_file}")

    if not args.apply:
        print("預覽模式：沒有刪除。確認清單後再加 --apply --confirm DELETE-DEMO-DATA。")
        return 0
    if args.confirm != "DELETE-DEMO-DATA":
        raise SystemExit("刪除前必須指定 --confirm DELETE-DEMO-DATA")

    with table.batch_writer(overwrite_by_pkeys=["PK", "SK"]) as batch:
        for item in records:
            batch.delete_item(Key={"PK": item["PK"], "SK": item["SK"]})
    print(f"已刪除 {len(records)} 筆 DEMO-* 資料。備份保留於：{backup_file}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
