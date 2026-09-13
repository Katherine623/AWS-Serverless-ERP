from __future__ import annotations

import base64
import json
import time
from typing import Any, Protocol
from uuid import uuid4

import boto3
from boto3.dynamodb.conditions import Key
from botocore.exceptions import ClientError

from app.alerts import AlertEvent
from app.config import get_settings


class IdempotencyConflictError(ValueError):
    pass


def _encode_cursor(value: dict[str, Any]) -> str:
    payload = json.dumps(value, separators=(",", ":"), ensure_ascii=True).encode()
    return base64.urlsafe_b64encode(payload).decode().rstrip("=")


def _decode_cursor(cursor: str | None) -> dict[str, Any] | None:
    if not cursor:
        return None
    try:
        padded = cursor + "=" * (-len(cursor) % 4)
        value = json.loads(base64.urlsafe_b64decode(padded).decode())
    except (ValueError, UnicodeDecodeError, json.JSONDecodeError) as exc:
        raise ValueError("cursor 格式無效") from exc
    if not isinstance(value, dict):
        raise ValueError("cursor 格式無效")
    return value


class ReceiptRecord(Protocol):
    receipt_id: str


class ErpRepository(Protocol):
    def get_purchase_order(self, po_id: str) -> Any | None:
        ...

    def list_purchase_orders(self) -> list[Any]:
        ...

    def list_purchase_orders_page(
        self, limit: int, cursor: str | None
    ) -> tuple[list[Any], str | None]:
        ...

    def create_purchase_order(self, order: Any) -> Any:
        ...

    def seed_purchase_order(self, order: Any) -> None:
        ...

    def list_inventory(self) -> list[Any]:
        ...

    def list_inventory_page(
        self, limit: int, cursor: str | None
    ) -> tuple[list[Any], str | None]:
        ...

    def get_inventory(self, material_id: str) -> Any | None:
        ...

    def list_inventory_transactions(self) -> list[Any]:
        ...

    def list_inventory_transactions_page(
        self, limit: int, cursor: str | None
    ) -> tuple[list[Any], str | None]:
        ...

    def receipt_for_key(self, idempotency_key: str) -> tuple[Any, str] | None:
        ...

    def save_receipt(
        self,
        result: Any,
        idempotency_key: str | None,
        request_hash: str,
        order: Any,
        previous_order: Any,
        inventory: list[tuple[Any, Any | None]],
        inventory_transactions: list[Any],
        alerts: list[AlertEvent],
    ) -> None:
        ...

    def list_pending_alert_batches(self) -> list[tuple[str, list[AlertEvent]]]:
        ...

    def claim_alert_batch(self, batch_id: str, lease_seconds: int) -> str | None:
        ...

    def release_alert_batch(self, batch_id: str, lease_token: str) -> None:
        ...

    def mark_alert_batch_published(self, batch_id: str, lease_token: str) -> None:
        ...

    def save_exception_resolution(
        self,
        order: Any,
        previous_order: Any,
        inventory: list[tuple[Any, Any | None]],
        inventory_transactions: list[Any],
    ) -> None:
        ...

    def save_purchase_order(self, order: Any, previous_order: Any) -> None:
        ...

    def receipt_count(self) -> int:
        ...

    def completed_receipt_count(self) -> int:
        ...

    def exception_count(self) -> int:
        ...

    def seed_inventory(self, item: Any) -> None:
        ...


class InMemoryRepository:
    def __init__(self) -> None:
        self.purchase_orders: dict[str, Any] = {}
        self.inventory: dict[str, Any] = {}
        self.receipts: dict[str, Any] = {}
        self.idempotency: dict[str, tuple[Any, str]] = {}
        self.inventory_transactions: dict[str, Any] = {}
        self.alert_batches: dict[str, list[AlertEvent]] = {}
        self.alert_batch_status: dict[str, str] = {}
        self.alert_batch_leases: dict[str, float] = {}
        self.alert_batch_tokens: dict[str, str] = {}
        self.alert_batch_attempts: dict[str, int] = {}
        self.idempotency_expiry: dict[str, float] = {}

    def get_purchase_order(self, po_id: str) -> Any | None:
        return self.purchase_orders.get(po_id)

    def list_purchase_orders(self) -> list[Any]:
        return list(self.purchase_orders.values())

    def list_purchase_orders_page(
        self, limit: int, cursor: str | None
    ) -> tuple[list[Any], str | None]:
        return self._page(list(self.purchase_orders.values()), limit, cursor)

    def create_purchase_order(self, order: Any) -> Any:
        if order.po_id in self.purchase_orders:
            raise ValueError(f"採購單 {order.po_id} 已存在")
        self.purchase_orders[order.po_id] = order
        return order

    def seed_purchase_order(self, order: Any) -> None:
        self.purchase_orders.setdefault(order.po_id, order)

    def list_inventory(self) -> list[Any]:
        return list(self.inventory.values())

    def list_inventory_page(
        self, limit: int, cursor: str | None
    ) -> tuple[list[Any], str | None]:
        return self._page(list(self.inventory.values()), limit, cursor)

    def get_inventory(self, material_id: str) -> Any | None:
        return self.inventory.get(material_id)

    def list_inventory_transactions(self) -> list[Any]:
        return list(self.inventory_transactions.values())

    def list_inventory_transactions_page(
        self, limit: int, cursor: str | None
    ) -> tuple[list[Any], str | None]:
        return self._page(list(self.inventory_transactions.values()), limit, cursor)

    @staticmethod
    def _page(items: list[Any], limit: int, cursor: str | None) -> tuple[list[Any], str | None]:
        decoded = _decode_cursor(cursor)
        offset = int(decoded.get("offset", 0)) if decoded else 0
        if offset < 0:
            raise ValueError("cursor 格式無效")
        page = items[offset : offset + limit]
        next_cursor = (
            _encode_cursor({"offset": offset + limit})
            if offset + limit < len(items)
            else None
        )
        return page, next_cursor

    def receipt_for_key(self, idempotency_key: str) -> tuple[Any, str] | None:
        expiry = self.idempotency_expiry.get(idempotency_key)
        if expiry is not None and expiry <= time.time():
            self.idempotency.pop(idempotency_key, None)
            self.idempotency_expiry.pop(idempotency_key, None)
            return None
        return self.idempotency.get(idempotency_key)

    def save_receipt(
        self,
        result: Any,
        idempotency_key: str | None,
        request_hash: str,
        order: Any,
        previous_order: Any,
        inventory: list[tuple[Any, Any | None]],
        inventory_transactions: list[Any],
        alerts: list[AlertEvent],
    ) -> None:
        existing = idempotency_key and self.receipt_for_key(idempotency_key)
        if existing:
            existing, existing_hash = existing
            if existing_hash != request_hash:
                raise IdempotencyConflictError("Idempotency-Key 已用於不同的收料請求")
            return
        self.purchase_orders[order.po_id] = order
        for item, _ in inventory:
            self.inventory[item.material_id] = item
        for transaction in inventory_transactions:
            self.inventory_transactions[transaction.transaction_id] = transaction
        self.receipts[result.receipt_id] = result
        if alerts:
            self.alert_batches[result.receipt_id] = list(alerts)
            self.alert_batch_status[result.receipt_id] = "pending"
            self.alert_batch_leases[result.receipt_id] = 0
            self.alert_batch_attempts[result.receipt_id] = 0
        if idempotency_key:
            self.idempotency[idempotency_key] = (result, request_hash)
            self.idempotency_expiry[idempotency_key] = (
                time.time() + get_settings().idempotency_ttl_days * 86400
            )

    def list_pending_alert_batches(self) -> list[tuple[str, list[AlertEvent]]]:
        now = time.time()
        return [
            (batch_id, self.alert_batches[batch_id])
            for batch_id in self.alert_batches
            if self.alert_batch_status.get(batch_id) == "pending"
            or (
                self.alert_batch_status.get(batch_id) == "processing"
                and self.alert_batch_leases.get(batch_id, 0) <= now
            )
        ]

    def claim_alert_batch(self, batch_id: str, lease_seconds: int) -> str | None:
        now = time.time()
        status = self.alert_batch_status.get(batch_id)
        if status not in {"pending", "processing"}:
            return None
        if status == "processing" and self.alert_batch_leases.get(batch_id, 0) > now:
            return None
        token = uuid4().hex
        self.alert_batch_status[batch_id] = "processing"
        self.alert_batch_leases[batch_id] = now + lease_seconds
        self.alert_batch_tokens[batch_id] = token
        self.alert_batch_attempts[batch_id] = self.alert_batch_attempts.get(batch_id, 0) + 1
        return token

    def release_alert_batch(self, batch_id: str, lease_token: str) -> None:
        if self.alert_batch_tokens.get(batch_id) != lease_token:
            return
        self.alert_batch_status[batch_id] = "pending"
        self.alert_batch_leases[batch_id] = 0
        self.alert_batch_tokens.pop(batch_id, None)

    def mark_alert_batch_published(self, batch_id: str, lease_token: str) -> None:
        if self.alert_batch_tokens.get(batch_id) != lease_token:
            return
        self.alert_batches.pop(batch_id, None)
        self.alert_batch_status.pop(batch_id, None)
        self.alert_batch_leases.pop(batch_id, None)
        self.alert_batch_tokens.pop(batch_id, None)
        self.alert_batch_attempts.pop(batch_id, None)

    def save_purchase_order(self, order: Any, previous_order: Any) -> None:
        if self.purchase_orders.get(order.po_id) != previous_order:
            raise IdempotencyConflictError("採購單已由另一筆操作更新，請重新整理後再試")
        self.purchase_orders[order.po_id] = order

    def save_exception_resolution(
        self,
        order: Any,
        previous_order: Any,
        inventory: list[tuple[Any, Any | None]],
        inventory_transactions: list[Any],
    ) -> None:
        if self.purchase_orders.get(order.po_id) != previous_order:
            raise IdempotencyConflictError("採購單已由另一筆操作更新，請重新整理後再試")
        self.purchase_orders[order.po_id] = order
        for item, _ in inventory:
            self.inventory[item.material_id] = item
        for transaction in inventory_transactions:
            self.inventory_transactions[transaction.transaction_id] = transaction

    def receipt_count(self) -> int:
        return len(self.receipts)

    def completed_receipt_count(self) -> int:
        return sum(receipt.status == "已完成" for receipt in self.receipts.values())

    def exception_count(self) -> int:
        return sum(bool(receipt.exceptions) for receipt in self.receipts.values())

    def seed_inventory(self, item: Any) -> None:
        self.inventory[item.material_id] = item


class DynamoDbRepository:
    def __init__(self, table_name: str) -> None:
        self._table = boto3.resource("dynamodb").Table(table_name)

    @staticmethod
    def _item(entity: str, key: str, value: Any) -> dict[str, Any]:
        return {
            "PK": f"{entity}#{key}",
            "SK": "META",
            "entity": entity,
            "entity_key": key,
            "data": json.dumps(value.model_dump(mode="json"), ensure_ascii=False),
        }

    @staticmethod
    def _model(item: dict[str, Any], model_name: str) -> Any:
        from app import erp

        model = getattr(erp, model_name)
        return model.model_validate(json.loads(item["data"]))

    def _query_items(self, entity: str, **kwargs: Any) -> list[dict[str, Any]]:
        items: list[dict[str, Any]] = []
        response = self._table.query(
            IndexName="EntityIndex",
            KeyConditionExpression=Key("entity").eq(entity),
            **kwargs,
        )
        items.extend(response.get("Items", []))
        while "LastEvaluatedKey" in response:
            response = self._table.query(
                IndexName="EntityIndex",
                KeyConditionExpression=Key("entity").eq(entity),
                **kwargs,
                ExclusiveStartKey=response["LastEvaluatedKey"],
            )
            items.extend(response.get("Items", []))
        return items

    def _query_page(
        self, entity: str, limit: int, cursor: str | None
    ) -> tuple[list[dict[str, Any]], str | None]:
        kwargs: dict[str, Any] = {"Limit": limit}
        decoded = _decode_cursor(cursor)
        if decoded:
            exclusive_start_key = decoded.get("last_evaluated_key")
            if not isinstance(exclusive_start_key, dict):
                raise ValueError("cursor 格式無效")
            kwargs["ExclusiveStartKey"] = exclusive_start_key
        response = self._table.query(
            IndexName="EntityIndex",
            KeyConditionExpression=Key("entity").eq(entity),
            **kwargs,
        )
        last_key = response.get("LastEvaluatedKey")
        next_cursor = _encode_cursor({"last_evaluated_key": last_key}) if last_key else None
        return response.get("Items", []), next_cursor

    def _query_count(self, entity: str, **kwargs: Any) -> int:
        total = 0
        response = self._table.query(
            IndexName="EntityIndex",
            KeyConditionExpression=Key("entity").eq(entity),
            **kwargs,
            Select="COUNT",
        )
        total += int(response.get("Count", 0))
        while "LastEvaluatedKey" in response:
            response = self._table.query(
                IndexName="EntityIndex",
                KeyConditionExpression=Key("entity").eq(entity),
                **kwargs,
                Select="COUNT",
                ExclusiveStartKey=response["LastEvaluatedKey"],
            )
            total += int(response.get("Count", 0))
        return total

    def get_purchase_order(self, po_id: str) -> Any | None:
        response = self._table.get_item(Key={"PK": f"purchase_order#{po_id}", "SK": "META"})
        item = response.get("Item")
        return self._model(item, "PurchaseOrder") if item else None

    def list_purchase_orders(self) -> list[Any]:
        items = self._query_items("purchase_order")
        return [self._model(item, "PurchaseOrder") for item in items]

    def list_purchase_orders_page(
        self, limit: int, cursor: str | None
    ) -> tuple[list[Any], str | None]:
        items, next_cursor = self._query_page("purchase_order", limit, cursor)
        return [self._model(item, "PurchaseOrder") for item in items], next_cursor

    def create_purchase_order(self, order: Any) -> Any:
        try:
            self._table.put_item(
                Item=self._item("purchase_order", order.po_id, order),
                ConditionExpression="attribute_not_exists(PK)",
            )
        except ClientError as exc:
            if exc.response["Error"]["Code"] == "ConditionalCheckFailedException":
                raise ValueError(f"採購單 {order.po_id} 已存在") from exc
            raise
        return order

    def seed_purchase_order(self, order: Any) -> None:
        try:
            self._table.put_item(
                Item=self._item("purchase_order", order.po_id, order),
                ConditionExpression="attribute_not_exists(PK)",
            )
        except ClientError as exc:
            if exc.response["Error"]["Code"] != "ConditionalCheckFailedException":
                raise

    def list_inventory(self) -> list[Any]:
        items = self._query_items("inventory")
        return [self._model(item, "InventoryItem") for item in items]

    def list_inventory_page(
        self, limit: int, cursor: str | None
    ) -> tuple[list[Any], str | None]:
        items, next_cursor = self._query_page("inventory", limit, cursor)
        return [self._model(item, "InventoryItem") for item in items], next_cursor

    def get_inventory(self, material_id: str) -> Any | None:
        response = self._table.get_item(Key={"PK": f"inventory#{material_id}", "SK": "META"})
        item = response.get("Item")
        return self._model(item, "InventoryItem") if item else None

    def list_inventory_transactions(self) -> list[Any]:
        items = self._query_items("inventory_transaction")
        return [self._model(item, "InventoryTransaction") for item in items]

    def list_inventory_transactions_page(
        self, limit: int, cursor: str | None
    ) -> tuple[list[Any], str | None]:
        items, next_cursor = self._query_page("inventory_transaction", limit, cursor)
        return [self._model(item, "InventoryTransaction") for item in items], next_cursor

    def receipt_for_key(self, idempotency_key: str) -> tuple[Any, str] | None:
        response = self._table.get_item(Key={"PK": f"idempotency#{idempotency_key}", "SK": "META"})
        item = response.get("Item")
        if not item:
            return None
        if int(item.get("expires_at", 0)) <= int(time.time()):
            self._table.delete_item(Key={"PK": item["PK"], "SK": item["SK"]})
            return None
        receipt = self._table.get_item(
            Key={"PK": f"receipt#{item['receipt_id']}", "SK": "META"}
        ).get("Item")
        if not receipt:
            return None
        return self._model(receipt, "ReceiptResult"), item["request_hash"]

    def save_receipt(
        self,
        result: Any,
        idempotency_key: str | None,
        request_hash: str,
        order: Any,
        previous_order: Any,
        inventory: list[tuple[Any, Any | None]],
        inventory_transactions: list[Any],
        alerts: list[AlertEvent],
    ) -> None:
        receipt_item = self._item("receipt", result.receipt_id, result)
        receipt_item["has_exceptions"] = bool(result.exceptions)
        receipt_item["status"] = result.status
        actions: list[dict[str, Any]] = [
            {
                "Put": {
                    "TableName": self._table.name,
                    "Item": receipt_item,
                }
            },
            {
                "Put": {
                    "TableName": self._table.name,
                    "Item": self._item("purchase_order", order.po_id, order),
                    "ConditionExpression": "#data = :previous",
                    "ExpressionAttributeNames": {"#data": "data"},
                    "ExpressionAttributeValues": {
                        ":previous": json.dumps(
                            previous_order.model_dump(mode="json"), ensure_ascii=False
                        )
                    },
                }
            },
        ]
        if idempotency_key:
            actions.append(
                {
                    "Put": {
                        "TableName": self._table.name,
                        "Item": {
                            "PK": f"idempotency#{idempotency_key}",
                            "SK": "META",
                            "entity": "idempotency",
                            "receipt_id": result.receipt_id,
                            "request_hash": request_hash,
                            "expires_at": int(time.time())
                            + get_settings().idempotency_ttl_days * 86400,
                        },
                        "ConditionExpression": "attribute_not_exists(PK)",
                    }
                }
            )
        for item, previous in inventory:
            action: dict[str, Any] = {
                "Put": {
                    "TableName": self._table.name,
                    "Item": self._item("inventory", item.material_id, item),
                }
            }
            if previous:
                action["Put"]["ConditionExpression"] = "#data = :previous"
                action["Put"]["ExpressionAttributeNames"] = {"#data": "data"}
                action["Put"]["ExpressionAttributeValues"] = {
                    ":previous": json.dumps(
                        previous.model_dump(mode="json"), ensure_ascii=False
                    )
                }
            else:
                action["Put"]["ConditionExpression"] = "attribute_not_exists(PK)"
            actions.append(action)
        for transaction in inventory_transactions:
            actions.append(
                {
                    "Put": {
                        "TableName": self._table.name,
                        "Item": self._item(
                            "inventory_transaction", transaction.transaction_id, transaction
                        ),
                        "ConditionExpression": "attribute_not_exists(PK)",
                    }
                }
            )
        if alerts:
            actions.append(
                {
                    "Put": {
                        "TableName": self._table.name,
                        "Item": {
                            "PK": f"alert_batch#{result.receipt_id}",
                            "SK": "META",
                            "entity": "alert_batch",
                            "entity_key": result.receipt_id,
                            "status": "pending",
                            "attempts": 0,
                            "lease_until": 0,
                            "expires_at": int(time.time())
                            + get_settings().alert_outbox_ttl_days * 86400,
                            "data": json.dumps(
                                [event.model_dump(mode="json") for event in alerts],
                                ensure_ascii=False,
                            ),
                        },
                        "ConditionExpression": "attribute_not_exists(PK)",
                    }
                }
            )
        try:
            self._table.meta.client.transact_write_items(TransactItems=actions)
        except ClientError as exc:
            if exc.response["Error"]["Code"] == "TransactionCanceledException":
                existing = idempotency_key and self.receipt_for_key(idempotency_key)
                if existing:
                    if existing[1] != request_hash:
                        raise IdempotencyConflictError(
                            "Idempotency-Key 已用於不同的收料請求"
                        ) from exc
                    return
                raise IdempotencyConflictError(
                    "採購單或庫存已由另一筆收料更新，請重新整理後再試"
                ) from exc
            raise

    def save_purchase_order(self, order: Any, previous_order: Any) -> None:
        try:
            self._table.put_item(
                Item=self._item("purchase_order", order.po_id, order),
                ConditionExpression="#data = :previous",
                ExpressionAttributeNames={"#data": "data"},
                ExpressionAttributeValues={
                    ":previous": json.dumps(
                        previous_order.model_dump(mode="json"), ensure_ascii=False
                    )
                },
            )
        except ClientError as exc:
            if exc.response["Error"]["Code"] == "ConditionalCheckFailedException":
                raise IdempotencyConflictError(
                    "採購單已由另一筆操作更新，請重新整理後再試"
                ) from exc
            raise

    def save_exception_resolution(
        self,
        order: Any,
        previous_order: Any,
        inventory: list[tuple[Any, Any | None]],
        inventory_transactions: list[Any],
    ) -> None:
        actions: list[dict[str, Any]] = [
            {
                "Put": {
                    "TableName": self._table.name,
                    "Item": self._item("purchase_order", order.po_id, order),
                    "ConditionExpression": "#data = :previous",
                    "ExpressionAttributeNames": {"#data": "data"},
                    "ExpressionAttributeValues": {
                        ":previous": json.dumps(
                            previous_order.model_dump(mode="json"), ensure_ascii=False
                        )
                    },
                }
            }
        ]
        for item, previous in inventory:
            if not previous:
                raise IdempotencyConflictError("找不到要更新的庫存資料")
            actions.append(
                {
                    "Put": {
                        "TableName": self._table.name,
                        "Item": self._item("inventory", item.material_id, item),
                        "ConditionExpression": "#data = :previous",
                        "ExpressionAttributeNames": {"#data": "data"},
                        "ExpressionAttributeValues": {
                            ":previous": json.dumps(
                                previous.model_dump(mode="json"), ensure_ascii=False
                            )
                        },
                    }
                }
            )
        for transaction in inventory_transactions:
            actions.append(
                {
                    "Put": {
                        "TableName": self._table.name,
                        "Item": self._item(
                            "inventory_transaction", transaction.transaction_id, transaction
                        ),
                        "ConditionExpression": "attribute_not_exists(PK)",
                    }
                }
            )
        try:
            self._table.meta.client.transact_write_items(TransactItems=actions)
        except ClientError as exc:
            if exc.response["Error"]["Code"] == "TransactionCanceledException":
                raise IdempotencyConflictError(
                    "採購單或庫存已由另一筆操作更新，請重新整理後再試"
                ) from exc
            raise

    def receipt_count(self) -> int:
        return self._query_count("receipt")

    def exception_count(self) -> int:
        return self._query_count(
            "receipt",
            FilterExpression="#has_exceptions = :true",
            ExpressionAttributeNames={"#has_exceptions": "has_exceptions"},
            ExpressionAttributeValues={":true": True},
        )

    def completed_receipt_count(self) -> int:
        return self._query_count(
            "receipt",
            FilterExpression="#status = :status",
            ExpressionAttributeNames={"#status": "status"},
            ExpressionAttributeValues={":status": "已完成"},
        )

    def seed_inventory(self, item: Any) -> None:
        try:
            self._table.put_item(
                Item=self._item("inventory", item.material_id, item),
                ConditionExpression="attribute_not_exists(PK)",
            )
        except ClientError as exc:
            if exc.response["Error"]["Code"] != "ConditionalCheckFailedException":
                raise

    def list_pending_alert_batches(self) -> list[tuple[str, list[AlertEvent]]]:
        now = int(time.time())
        items = self._query_items(
            "alert_batch",
            FilterExpression=(
                "#status = :pending OR "
                "(#status = :processing AND "
                "(attribute_not_exists(#lease_until) OR #lease_until <= :now))"
            ),
            ExpressionAttributeNames={"#status": "status", "#lease_until": "lease_until"},
            ExpressionAttributeValues={
                ":pending": "pending",
                ":processing": "processing",
                ":now": now,
            },
        )
        return [
            (
                item["PK"].removeprefix("alert_batch#"),
                [AlertEvent.model_validate(event) for event in json.loads(item["data"])],
            )
            for item in items
        ]

    def claim_alert_batch(self, batch_id: str, lease_seconds: int) -> str | None:
        now = int(time.time())
        token = uuid4().hex
        try:
            self._table.update_item(
                Key={"PK": f"alert_batch#{batch_id}", "SK": "META"},
                UpdateExpression=(
                    "SET #status = :processing, #lease_until = :lease_until, "
                    "#lease_token = :lease_token ADD #attempts :one"
                ),
                ConditionExpression=(
                    "#status = :pending OR "
                    "(#status = :processing AND "
                    "(attribute_not_exists(#lease_until) OR #lease_until <= :now))"
                ),
                ExpressionAttributeNames={
                    "#status": "status",
                    "#lease_until": "lease_until",
                    "#lease_token": "lease_token",
                    "#attempts": "attempts",
                },
                ExpressionAttributeValues={
                    ":pending": "pending",
                    ":processing": "processing",
                    ":now": now,
                    ":lease_until": now + lease_seconds,
                    ":lease_token": token,
                    ":one": 1,
                },
            )
        except ClientError as exc:
            if exc.response["Error"]["Code"] == "ConditionalCheckFailedException":
                return None
            raise
        return token

    def release_alert_batch(self, batch_id: str, lease_token: str) -> None:
        try:
            self._table.update_item(
                Key={"PK": f"alert_batch#{batch_id}", "SK": "META"},
                UpdateExpression="SET #status = :pending REMOVE #lease_until, #lease_token",
                ConditionExpression="#status = :processing AND #lease_token = :lease_token",
                ExpressionAttributeNames={
                    "#status": "status",
                    "#lease_until": "lease_until",
                    "#lease_token": "lease_token",
                },
                ExpressionAttributeValues={
                    ":pending": "pending",
                    ":processing": "processing",
                    ":lease_token": lease_token,
                },
            )
        except ClientError as exc:
            if exc.response["Error"]["Code"] != "ConditionalCheckFailedException":
                raise

    def mark_alert_batch_published(self, batch_id: str, lease_token: str) -> None:
        try:
            self._table.delete_item(
                Key={"PK": f"alert_batch#{batch_id}", "SK": "META"},
                ConditionExpression="#status = :processing AND #lease_token = :lease_token",
                ExpressionAttributeNames={"#status": "status", "#lease_token": "lease_token"},
                ExpressionAttributeValues={
                    ":processing": "processing",
                    ":lease_token": lease_token,
                },
            )
        except ClientError as exc:
            if exc.response["Error"]["Code"] != "ConditionalCheckFailedException":
                raise


def create_repository() -> ErpRepository:
    settings = get_settings()
    table_name = settings.dynamodb_table_name
    if table_name:
        return DynamoDbRepository(table_name)
    if settings.environment in {"staging", "production"}:
        raise RuntimeError("DynamoDB repository is required in staging/production")
    return InMemoryRepository()
