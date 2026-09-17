"""Optional browser checks: pip install playwright; playwright install chromium.

All HTTP requests are intercepted; this does not write to AWS or send notifications.
"""

import base64
import json
from pathlib import Path
from urllib.parse import parse_qs, urlparse

from playwright.sync_api import expect, sync_playwright

ROOT = Path(__file__).resolve().parents[1]
claims = base64.urlsafe_b64encode(json.dumps({"sub": "test-user"}).encode()).decode().rstrip("=")
mutations = []
confirmations = []
requests = []
draft = {
    "id": "draft-one",
    "action": "receive",
    "title": "到貨驗收",
    "path": "/api/receipts",
    "payload": {"po_id": "PO-TEST", "items": []},
    "requires_idempotency": True,
}


def route_request(route):
    request = route.request
    url = urlparse(request.url)
    path = url.path
    requests.append(path)
    if path in {"/", "/app.js"}:
        filename = "index.html" if path == "/" else "app.js"
        return route.fulfill(
            content_type="text/html" if path == "/" else "text/javascript",
            body=(ROOT / "web" / filename).read_text("utf-8"),
        )
    status, data = 200, {}
    if path == "/auth/config":
        data = {"enabled": False}
    elif path == "/api/ai/chat":
        data = {"answer": "草稿 <img src=x onerror=alert(1)>", "drafts": [draft], "sources": []}
    elif path.endswith("/confirm"):
        confirmations.append(path)
        status = 503 if len(confirmations) == 1 else 200
        data = {"detail": "try again"} if status == 503 else {"receipt_id": "RCV-TEST"}
    elif path == "/api/inventory-adjustments":
        mutations.append((request.headers["idempotency-key"], request.post_data_json))
        status = 503 if len(mutations) == 1 else 201
        data = (
            {"detail": "network error"}
            if status == 503
            else {"adjustment_id": "ADJ-TEST", "quantity_before": 10, "quantity_after": 9}
        )
    elif path == "/api/dashboard":
        data = dict.fromkeys(
            [
                "total_purchase_orders",
                "pending_receipts",
                "completed_receipts",
                "exception_count",
                "low_stock_count",
                "quarantine_total",
            ],
            0,
        )
    elif path == "/api/v2/inventory":
        data = {
            "items": [
                {
                    "material_id": "MAT",
                    "material_name": "Part",
                    "quantity": 10,
                    "quarantine_quantity": 0,
                    "reorder_point": 5,
                    "unit": "pcs",
                }
            ],
            "next_cursor": None,
        }
    elif path == "/api/v2/inventory-transactions":
        data = {"items": [], "next_cursor": None if "cursor" in parse_qs(url.query) else "next"}
    elif path.startswith("/api/v2/"):
        data = {"items": [], "next_cursor": None}
    elif path == "/api/ai/actions":
        data = []
    elif path == "/api/imports/excel/jobs":
        data = [
            {
                "file_name": "orders.xlsx",
                "status": "partial_failed",
                "imported": 1,
                "failed": 1,
                "errors": [{"row": 3, "message": "供應商不一致"}],
            }
        ]
    route.fulfill(status=status, content_type="application/json", body=json.dumps(data))


with sync_playwright() as playwright:
    browser = playwright.chromium.launch()
    page = browser.new_page(viewport={"width": 1280, "height": 900})
    errors = []
    page.on("pageerror", lambda error: errors.append(str(error)))
    page.route("https://erp.test/**", route_request)
    page.add_init_script(f"sessionStorage.setItem('erp.jwt', 'test.{claims}.test')")
    page.goto("https://erp.test/")
    expect(page.locator("#adjustmentMaterial")).to_have_value("MAT")
    page.fill("#adjustmentQuantity", "-1")
    page.fill("#adjustmentReason", "test")
    page.locator('#adjustmentForm button[type="submit"]').click()
    expect(page.locator("#adjustmentResult")).to_contain_text("network error")
    page.fill("#adjustmentQuantity", "-2")
    page.locator('#adjustmentForm button[type="submit"]').click()
    expect(page.locator("#adjustmentResult")).to_contain_text("上一筆操作結果尚未確認")
    assert len(mutations) == 1
    page.reload()
    page.locator('[data-retry-operation="adjustment"]').click()
    expect(page.locator("#adjustmentResult")).to_contain_text("ADJ-TEST")
    assert len(mutations) == 2 and mutations[0] == mutations[1]
    assert not page.evaluate("sessionStorage.getItem('erp.pending.test-user.adjustment')")
    expect(page.locator("#importJobs")).to_contain_text("第 3 列")
    page.click("#transactionNext")
    expect(page.locator("#transactionNext")).to_be_disabled()
    assert "/api/inventory-transactions" not in requests
    assert "/api/purchase-orders" not in requests
    page.click("#aiTab")
    page.fill("#aiMessage", "test")
    page.click("#aiSend")
    confirm = page.locator("#aiLog").get_by_role("button", name="確認送出", exact=True)
    expect(confirm).to_be_visible()
    assert not confirmations and not page.locator("#aiLog img").count()
    confirm.click()
    page.locator("#aiLog").get_by_role("button", name="重新送出", exact=True).click()
    expect(page.locator("#aiLog")).to_contain_text("到貨驗收 · 已完成")
    assert len(confirmations) == 2 and confirmations[0] == confirmations[1]
    page.fill("#aiMessage", "test cancel")
    page.click("#aiSend")
    expect(page.locator("#aiLog .chat-draft")).to_have_count(2)
    page.locator("#aiLog").get_by_role("button", name="取消", exact=True).last.click()
    expect(page.locator("#aiLog")).to_contain_text("已取消，未送出")
    assert len(confirmations) == 2
    page.set_viewport_size({"width": 390, "height": 844})
    assert page.evaluate("document.documentElement.scrollWidth <= window.innerWidth")
    assert not errors, errors
    browser.close()
print(
    "Passed: persistent retry, changed payload guard, pagination, import errors, AI confirm/cancel"
)
