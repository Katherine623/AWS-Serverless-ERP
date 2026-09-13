from __future__ import annotations

import json
from typing import Any, Protocol

import boto3
from botocore.exceptions import ClientError

from app.config import get_settings


class IdempotencyConflictError(ValueError):
    pass


class ReceiptRecord(Protocol):
    receipt_id: str


class ErpRepository(Protocol):
    def get_purchase_order(self, po_id: str) -> Any | None:
        ...

    def list_purchase_orders(self) -> list[Any]:
        ...

    def create_purchase_order(self, order: Any) -> Any:
        ...

    def seed_purchase_order(self, order: Any) -> None:
        ...

    def list_inventory(self) -> list[Any]:
        ...

    def get_inventory(self, material_id: str) -> Any | None:
        ...

    def list_inventory_transactions(self) -> list[Any]:
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

    def get_purchase_order(self, po_id: str) -> Any | None:
        return self.purchase_orders.get(po_id)

    def list_purchase_orders(self) -> list[Any]:
        return list(self.purchase_orders.values())

    def create_purchase_order(self, order: Any) -> Any:
        if order.po_id in self.purchase_orders:
            raise ValueError(f"採購單 {order.po_id} 已存在")
        self.purchase_orders[order.po_id] = order
        return order

    def seed_purchase_order(self, order: Any) -> None:
        self.purchase_orders.setdefault(order.po_id, order)

    def list_inventory(self) -> list[Any]:
        return list(self.inventory.values())

    def get_inventory(self, material_id: str) -> Any | None:
        return self.inventory.get(material_id)

    def list_inventory_transactions(self) -> list[Any]:
        return list(self.inventory_transactions.values())

    def receipt_for_key(self, idempotency_key: str) -> tuple[Any, str] | None:
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
    ) -> None:
        if idempotency_key and idempotency_key in self.idempotency:
            existing, existing_hash = self.idempotency[idempotency_key]
            if existing_hash != request_hash:
                raise IdempotencyConflictError("Idempotency-Key 已用於不同的收料請求")
            return
        self.purchase_orders[order.po_id] = order
        for item, _ in inventory:
            self.inventory[item.material_id] = item
        for transaction in inventory_transactions:
            self.inventory_transactions[transaction.transaction_id] = transaction
        self.receipts[result.receipt_id] = result
        if idempotency_key:
            self.idempotency[idempotency_key] = (result, request_hash)

    def save_purchase_order(self, order: Any, previous_order: Any) -> None:
        if self.purchase_orders.get(order.po_id) != previous_order:
            raise IdempotencyConflictError("採購單已由另一筆操作更新，請重新整理後再試")
        self.purchase_orders[order.po_id] = order

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

    def _scan_items(self, **kwargs: Any) -> list[dict[str, Any]]:
        items: list[dict[str, Any]] = []
        response = self._table.scan(**kwargs)
        items.extend(response.get("Items", []))
        while "LastEvaluatedKey" in response:
            response = self._table.scan(
                **kwargs, ExclusiveStartKey=response["LastEvaluatedKey"]
            )
            items.extend(response.get("Items", []))
        return items

    def _scan_count(self, **kwargs: Any) -> int:
        total = 0
        response = self._table.scan(**kwargs, Select="COUNT")
        total += int(response.get("Count", 0))
        while "LastEvaluatedKey" in response:
            response = self._table.scan(
                **kwargs, Select="COUNT", ExclusiveStartKey=response["LastEvaluatedKey"]
            )
            total += int(response.get("Count", 0))
        return total

    def get_purchase_order(self, po_id: str) -> Any | None:
        response = self._table.get_item(Key={"PK": f"purchase_order#{po_id}", "SK": "META"})
        item = response.get("Item")
        return self._model(item, "PurchaseOrder") if item else None

    def list_purchase_orders(self) -> list[Any]:
        items = self._scan_items(
            FilterExpression="#entity = :entity",
            ExpressionAttributeNames={"#entity": "entity"},
            ExpressionAttributeValues={":entity": "purchase_order"},
        )
        return [self._model(item, "PurchaseOrder") for item in items]

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
        items = self._scan_items(
            FilterExpression="#entity = :entity",
            ExpressionAttributeNames={"#entity": "entity"},
            ExpressionAttributeValues={":entity": "inventory"},
        )
        return [self._model(item, "InventoryItem") for item in items]

    def get_inventory(self, material_id: str) -> Any | None:
        response = self._table.get_item(Key={"PK": f"inventory#{material_id}", "SK": "META"})
        item = response.get("Item")
        return self._model(item, "InventoryItem") if item else None

    def list_inventory_transactions(self) -> list[Any]:
        items = self._scan_items(
            FilterExpression="#entity = :entity",
            ExpressionAttributeNames={"#entity": "entity"},
            ExpressionAttributeValues={":entity": "inventory_transaction"},
        )
        return [self._model(item, "InventoryTransaction") for item in items]

    def receipt_for_key(self, idempotency_key: str) -> tuple[Any, str] | None:
        response = self._table.get_item(Key={"PK": f"idempotency#{idempotency_key}", "SK": "META"})
        item = response.get("Item")
        if not item:
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

    def receipt_count(self) -> int:
        return self._scan_count(
            FilterExpression="#entity = :entity",
            ExpressionAttributeNames={"#entity": "entity"},
            ExpressionAttributeValues={":entity": "receipt"},
        )

    def exception_count(self) -> int:
        return self._scan_count(
            FilterExpression="#entity = :entity AND #has_exceptions = :true",
            ExpressionAttributeNames={"#entity": "entity", "#has_exceptions": "has_exceptions"},
            ExpressionAttributeValues={":entity": "receipt", ":true": True},
        )

    def completed_receipt_count(self) -> int:
        return self._scan_count(
            FilterExpression="#entity = :entity AND #status = :status",
            ExpressionAttributeNames={"#entity": "entity", "#status": "status"},
            ExpressionAttributeValues={":entity": "receipt", ":status": "已完成"},
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


def create_repository() -> ErpRepository:
    settings = get_settings()
    table_name = settings.dynamodb_table_name
    if table_name:
        return DynamoDbRepository(table_name)
    if settings.environment == "production":
        raise RuntimeError("DynamoDB repository is required in production")
    return InMemoryRepository()
