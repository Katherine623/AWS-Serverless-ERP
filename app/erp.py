from __future__ import annotations

from datetime import UTC, datetime
from threading import Lock
from uuid import uuid4

from pydantic import BaseModel, Field


class PurchaseOrderItem(BaseModel):
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


class ReceiptItem(BaseModel):
    material_id: str
    received_quantity: int = Field(ge=0)


class ReceiptRequest(BaseModel):
    po_id: str
    items: list[ReceiptItem]
    received_by: str = "warehouse-user"


class ReceiptResult(BaseModel):
    receipt_id: str
    po_id: str
    status: str
    exceptions: list[str]
    received_by: str
    received_at: datetime


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
    def __init__(self) -> None:
        self._lock = Lock()
        self.purchase_orders: dict[str, PurchaseOrder] = {}
        self.receipts: list[ReceiptResult] = []
        self.inventory: dict[str, InventoryItem] = {}
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
        self.purchase_orders = {order.po_id: order for order in demo_orders}
        for material_id, name, quantity, reorder_point in [
            ("MAT-1001", "軸承組件", 420, 100),
            ("MAT-1002", "鋁合金外殼", 85, 30),
            ("MAT-2001", "控制晶片", 48, 80),
        ]:
            self.inventory[material_id] = InventoryItem(
                material_id=material_id,
                material_name=name,
                quantity=quantity,
                reorder_point=reorder_point,
                updated_at=now,
            )

    def dashboard(self) -> DashboardSummary:
        with self._lock:
            completed = sum(receipt.status == "已完成" for receipt in self.receipts)
            exceptions = sum(bool(receipt.exceptions) for receipt in self.receipts)
            pending = sum(order.status == "待驗收" for order in self.purchase_orders.values())
            return DashboardSummary(
                total_purchase_orders=len(self.purchase_orders),
                pending_receipts=pending,
                completed_receipts=completed,
                exception_count=exceptions,
                inventory_item_count=len(self.inventory),
            )

    def list_purchase_orders(self) -> list[PurchaseOrder]:
        return list(self.purchase_orders.values())

    def list_inventory(self) -> list[InventoryItem]:
        return list(self.inventory.values())

    def create_purchase_order(self, order: PurchaseOrder) -> PurchaseOrder:
        with self._lock:
            if order.po_id in self.purchase_orders:
                raise ValueError(f"採購單 {order.po_id} 已存在")
            self.purchase_orders[order.po_id] = order
            return order

    def receive(self, request: ReceiptRequest) -> ReceiptResult:
        with self._lock:
            order = self.purchase_orders.get(request.po_id)
            if not order:
                raise ValueError(f"找不到採購單 {request.po_id}")
            ordered = {item.material_id: item for item in order.items}
            received = {item.material_id: item.received_quantity for item in request.items}
            exceptions: list[str] = []
            for material_id, item in ordered.items():
                quantity = received.get(material_id, 0)
                if quantity < item.ordered_quantity:
                    exceptions.append(
                        f"{item.material_name} 短缺 {item.ordered_quantity - quantity} {item.unit}"
                    )
                elif quantity > item.ordered_quantity:
                    exceptions.append(
                        f"{item.material_name} 超收 {quantity - item.ordered_quantity} {item.unit}"
                    )
                inventory = self.inventory.get(material_id)
                if inventory:
                    inventory.quantity += quantity
                    inventory.updated_at = datetime.now(UTC)
                else:
                    self.inventory[material_id] = InventoryItem(
                        material_id=material_id,
                        material_name=item.material_name,
                        quantity=quantity,
                        unit=item.unit,
                        updated_at=datetime.now(UTC),
                    )
            status = "有異常" if exceptions else "已完成"
            order.status = status
            result = ReceiptResult(
                receipt_id=f"RCV-{uuid4().hex[:8].upper()}",
                po_id=request.po_id,
                status=status,
                exceptions=exceptions,
                received_by=request.received_by,
                received_at=datetime.now(UTC),
            )
            self.receipts.append(result)
            return result


store = ErpStore()
