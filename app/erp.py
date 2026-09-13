from __future__ import annotations

import hashlib
import json
from datetime import UTC, datetime
from threading import Lock
from uuid import uuid4

from pydantic import BaseModel, ConfigDict, Field, model_validator

from app.alerts import AlertEvent, AlertPublisher, create_alert_publisher
from app.repository import (
    ErpRepository,
    IdempotencyConflictError,
    create_repository,
)


class PurchaseOrderItem(BaseModel):
    material_id: str
    material_name: str
    ordered_quantity: int = Field(gt=0)
    received_quantity: int = Field(default=0, ge=0)
    unit: str = "pcs"

    @model_validator(mode="after")
    def validate_received_quantity(self) -> PurchaseOrderItem:
        if self.received_quantity > self.ordered_quantity:
            raise ValueError("已收數量不可超過訂購數量")
        return self


class CreatePurchaseOrderItem(BaseModel):
    model_config = ConfigDict(extra="forbid")

    material_id: str
    material_name: str
    ordered_quantity: int = Field(gt=0)
    unit: str = "pcs"


class PurchaseOrder(BaseModel):
    po_id: str
    supplier_name: str
    expected_date: str
    status: str
    items: list[PurchaseOrderItem]
    created_at: datetime
    exception_action: str | None = None
    exception_resolved_by: str | None = None
    exception_note: str | None = None
    exception_resolved_at: datetime | None = None
    approved_variances: dict[str, int] = Field(default_factory=dict)

    @model_validator(mode="after")
    def validate_unique_materials(self) -> PurchaseOrder:
        material_ids = [item.material_id for item in self.items]
        if len(material_ids) != len(set(material_ids)):
            raise ValueError("採購單不可包含重複料號")
        return self


class CreatePurchaseOrderRequest(BaseModel):
    po_id: str
    supplier_name: str
    expected_date: str
    items: list[CreatePurchaseOrderItem] = Field(min_length=1, max_length=48)

    @model_validator(mode="after")
    def validate_unique_materials(self) -> CreatePurchaseOrderRequest:
        material_ids = [item.material_id for item in self.items]
        if len(material_ids) != len(set(material_ids)):
            raise ValueError("採購單不可包含重複料號")
        return self


class ReceiptItem(BaseModel):
    material_id: str
    received_quantity: int = Field(ge=0)


class ReceiptRequest(BaseModel):
    po_id: str
    items: list[ReceiptItem] = Field(min_length=1, max_length=48)
    received_by: str = "warehouse-user"

    @model_validator(mode="after")
    def validate_nonzero_receipt(self) -> ReceiptRequest:
        if not any(item.received_quantity > 0 for item in self.items):
            raise ValueError("本次收料至少要有一個品項大於 0")
        return self


class ReceiptResult(BaseModel):
    receipt_id: str
    po_id: str
    status: str
    exceptions: list[str]
    received_by: str
    received_at: datetime


class ResolveExceptionRequest(BaseModel):
    action: str = Field(pattern="^(補貨|差異允收結案)$")
    resolved_by: str = Field(min_length=1)
    note: str = Field(min_length=1, max_length=500)


class InventoryTransaction(BaseModel):
    transaction_id: str
    material_id: str
    material_name: str
    quantity_change: int
    transaction_type: str = "收料"
    reference_id: str
    performed_by: str
    occurred_at: datetime


class InventoryItem(BaseModel):
    material_id: str
    material_name: str
    quantity: int
    unit: str = "pcs"
    reorder_point: int = 10
    updated_at: datetime


class DashboardSummary(BaseModel):
    total_purchase_orders: int
    pending_receipts: int
    completed_receipts: int
    exception_count: int
    inventory_item_count: int


class ErpStore:
    def __init__(
        self,
        alert_publisher: AlertPublisher | None = None,
        repository: ErpRepository | None = None,
    ) -> None:
        self._lock = Lock()
        self.repository = repository or create_repository()
        self.alert_publisher = alert_publisher or create_alert_publisher()
        self._seed()

    def _seed(self) -> None:
        now = datetime.now(UTC)
        demo_orders = [
            PurchaseOrder(
                po_id="PO-2026-001",
                supplier_name="台灣精密工業",
                expected_date="2026-09-15",
                status="待驗收",
                items=[
                    PurchaseOrderItem(
                        material_id="MAT-1001", material_name="軸承組件", ordered_quantity=100
                    ),
                    PurchaseOrderItem(
                        material_id="MAT-1002", material_name="鋁合金外殼", ordered_quantity=50
                    ),
                ],
                created_at=now,
            ),
            PurchaseOrder(
                po_id="PO-2026-002",
                supplier_name="東亞電子材料",
                expected_date="2026-09-12",
                status="待驗收",
                items=[
                    PurchaseOrderItem(
                        material_id="MAT-2001", material_name="控制晶片", ordered_quantity=200
                    ),
                ],
                created_at=now,
            ),
        ]
        for order in demo_orders:
            self.repository.seed_purchase_order(order)
        for material_id, name, quantity, reorder_point in [
            ("MAT-1001", "軸承組件", 420, 100),
            ("MAT-1002", "鋁合金外殼", 85, 30),
            ("MAT-2001", "控制晶片", 48, 80),
        ]:
            item = InventoryItem(
                material_id=material_id,
                material_name=name,
                quantity=quantity,
                reorder_point=reorder_point,
                updated_at=now,
            )
            self.repository.seed_inventory(item)

    def dashboard(self) -> DashboardSummary:
        with self._lock:
            completed = self.repository.completed_receipt_count()
            exceptions = self.repository.exception_count()
            pending = sum(
                order.status == "待驗收" for order in self.repository.list_purchase_orders()
            )
            return DashboardSummary(
                total_purchase_orders=len(self.repository.list_purchase_orders()),
                pending_receipts=pending,
                completed_receipts=completed,
                exception_count=exceptions,
                inventory_item_count=len(self.repository.list_inventory()),
            )

    def list_purchase_orders(self) -> list[PurchaseOrder]:
        return self.repository.list_purchase_orders()

    def list_inventory(self) -> list[InventoryItem]:
        return self.repository.list_inventory()

    def list_inventory_transactions(self) -> list[InventoryTransaction]:
        return sorted(
            self.repository.list_inventory_transactions(),
            key=lambda transaction: transaction.occurred_at,
            reverse=True,
        )

    def create_purchase_order(self, request: CreatePurchaseOrderRequest) -> PurchaseOrder:
        with self._lock:
            known_materials = {
                item.material_id: (item.material_name, item.unit)
                for order in self.repository.list_purchase_orders()
                for item in order.items
            }
            known_materials.update(
                {
                    item.material_id: (item.material_name, item.unit)
                    for item in self.repository.list_inventory()
                }
            )
            for item in request.items:
                known_material = known_materials.get(item.material_id)
                if known_material and known_material != (item.material_name, item.unit):
                    raise ValueError(
                        f"料號 {item.material_id} 已定義為 {known_material[0]}，"
                        "不可使用不同品名或單位"
                    )
            order = PurchaseOrder(
                po_id=request.po_id,
                supplier_name=request.supplier_name,
                expected_date=request.expected_date,
                items=[PurchaseOrderItem(**item.model_dump()) for item in request.items],
                status="待驗收",
                created_at=datetime.now(UTC),
            )
            return self.repository.create_purchase_order(order)

    def receive(self, request: ReceiptRequest, idempotency_key: str | None = None) -> ReceiptResult:
        request_hash = hashlib.sha256(
            json.dumps(request.model_dump(mode="json"), sort_keys=True).encode()
        ).hexdigest()
        if idempotency_key:
            existing = self.repository.receipt_for_key(idempotency_key)
            if existing:
                if existing[1] != request_hash:
                    raise IdempotencyConflictError("Idempotency-Key 已用於不同的收料請求")
                return existing[0]
        alerts: list[AlertEvent] = []
        with self._lock:
            order = self.repository.get_purchase_order(request.po_id)
            if not order:
                raise ValueError(f"找不到採購單 {request.po_id}")
            if order.status not in {"待驗收", "待補貨"}:
                raise IdempotencyConflictError(f"採購單 {request.po_id} 目前不可收料")
            ordered = {item.material_id: item for item in order.items}
            received = {item.material_id: item.received_quantity for item in request.items}
            if len(received) != len(request.items):
                raise ValueError("收料品項不可重複")
            if set(received) != set(ordered):
                raise ValueError("收料品項必須與採購單完全一致")
            previous_order = order.model_copy(deep=True)
            exceptions: list[str] = []
            inventory_updates: list[tuple[InventoryItem, InventoryItem | None]] = []
            inventory_transactions: list[InventoryTransaction] = []
            for material_id, item in ordered.items():
                quantity = received[material_id]
                remaining = item.ordered_quantity - item.received_quantity
                if quantity > remaining:
                    raise ValueError(
                        f"{item.material_name} 收料數量不可超過剩餘待收 {remaining} {item.unit}"
                    )
                item.received_quantity += quantity
                if item.received_quantity < item.ordered_quantity:
                    exceptions.append(
                        f"{item.material_name} 尚待補貨 "
                        f"{item.ordered_quantity - item.received_quantity} {item.unit}"
                    )
                previous_inventory = self.repository.get_inventory(material_id)
                if previous_inventory:
                    inventory = previous_inventory.model_copy(deep=True)
                    inventory.quantity += quantity
                    inventory.updated_at = datetime.now(UTC)
                else:
                    inventory = InventoryItem(
                        material_id=material_id,
                        material_name=item.material_name,
                        quantity=quantity,
                        unit=item.unit,
                        updated_at=datetime.now(UTC),
                    )
                inventory_updates.append((inventory, previous_inventory))
                inventory_transactions.append(
                    InventoryTransaction(
                        transaction_id=f"INV-{uuid4().hex[:12].upper()}",
                        material_id=material_id,
                        material_name=item.material_name,
                        quantity_change=quantity,
                        reference_id=request.po_id,
                        performed_by=request.received_by,
                        occurred_at=datetime.now(UTC),
                    )
                )
            status = "待處理異常" if exceptions else "已完成"
            order.status = status
            result = ReceiptResult(
                receipt_id=f"RCV-{uuid4().hex[:8].upper()}",
                po_id=request.po_id,
                status=status,
                exceptions=exceptions,
                received_by=request.received_by,
                received_at=datetime.now(UTC),
            )
            self.repository.save_receipt(
                result,
                idempotency_key,
                request_hash,
                order,
                previous_order,
                inventory_updates,
                inventory_transactions,
            )
            if exceptions:
                alerts.append(
                    AlertEvent(
                        alert_type="收料異常",
                        po_id=request.po_id,
                        receipt_id=result.receipt_id,
                        message="；".join(exceptions),
                        occurred_at=result.received_at,
                    )
                )
            for inventory, _ in inventory_updates:
                if inventory.quantity < inventory.reorder_point:
                    alerts.append(
                        AlertEvent(
                            alert_type="低庫存",
                            po_id=request.po_id,
                            receipt_id=result.receipt_id,
                            material_id=inventory.material_id,
                            material_name=inventory.material_name,
                            message=(
                                f"{inventory.material_name} 庫存 {inventory.quantity} "
                                f"低於安全庫存 {inventory.reorder_point} {inventory.unit}"
                            ),
                            current_quantity=inventory.quantity,
                            reorder_point=inventory.reorder_point,
                            occurred_at=result.received_at,
                        )
                    )
        for alert in alerts:
            self.alert_publisher.publish(alert)
        return result

    def resolve_exception(
        self, po_id: str, request: ResolveExceptionRequest
    ) -> PurchaseOrder:
        with self._lock:
            order = self.repository.get_purchase_order(po_id)
            if not order:
                raise ValueError(f"找不到採購單 {po_id}")
            if order.status != "待處理異常":
                raise IdempotencyConflictError(f"採購單 {po_id} 沒有待處理異常")
            previous_order = order.model_copy(deep=True)
            updated_order = order.model_copy(deep=True)
            updated_order.status = "待補貨" if request.action == "補貨" else "差異結案"
            updated_order.exception_action = request.action
            updated_order.exception_resolved_by = request.resolved_by
            updated_order.exception_note = request.note
            updated_order.exception_resolved_at = datetime.now(UTC)
            if request.action == "差異允收結案":
                updated_order.approved_variances = {
                    item.material_id: item.ordered_quantity - item.received_quantity
                    for item in updated_order.items
                    if item.received_quantity < item.ordered_quantity
                }
            self.repository.save_purchase_order(updated_order, previous_order)
            return updated_order


store = ErpStore()
