"""Read tools shared by the MCP adapter and authenticated AI chat."""

from typing import Literal

from pydantic import BaseModel, ConfigDict, Field

from app.erp import store


class ReadQuery(BaseModel):
    model_config = ConfigDict(extra="forbid")

    limit: int = Field(default=20, ge=1, le=50)
    cursor: str | None = Field(default=None, max_length=1024)
    status: Literal["待驗收", "待處理異常", "待補貨", "已完成", "差異結案"] | None = None
    supplier_name: str | None = Field(default=None, max_length=160)
    material_id: str | None = Field(default=None, max_length=80)
    low_stock: bool = False


READ_TOOLS = {
    "get_dashboard": "取得整體 KPI；exception_count 是歷史異常收料次數，不是待處理 PO 數。",
    "list_purchase_orders": "分頁查採購單，可用 status、supplier_name 完全符合篩選。",
    "list_inventory": "分頁查庫存，可用 material_id 或 low_stock 篩選。",
    "list_inventory_transactions": "分頁查庫存異動，可用 material_id 篩選；順序非時間排序。",
}


def read_tool(name: str, arguments: dict) -> dict:
    query = ReadQuery.model_validate(arguments)
    if name == "get_dashboard":
        result = store.dashboard()
    elif name == "list_purchase_orders":
        result = store.list_purchase_orders_page(
            query.limit, query.cursor, status=query.status, supplier_name=query.supplier_name
        )
    elif name == "list_inventory":
        result = store.list_inventory_page(
            query.limit, query.cursor, material_id=query.material_id, low_stock=query.low_stock
        )
    elif name == "list_inventory_transactions":
        result = store.list_inventory_transactions_page(
            query.limit, query.cursor, material_id=query.material_id
        )
    else:
        raise ValueError("Unknown ERP read tool")
    return result.model_dump(mode="json")
