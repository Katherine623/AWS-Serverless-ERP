---
marp: true
theme: default
paginate: true
size: 16:9
title: AWS Serverless ERP｜目前框架與架構
---

# AWS Serverless ERP

## 從採購單到可追蹤的物料點收

**目前框架、資料流與 AWS 部署邊界**

> 本簡報依照 working tree 的程式與 Terraform 設定整理；`CURRENT` 與 `ROADMAP` 分開標示。

---

# 一句話定義目前框架

| 層次 | 目前實作 |
| --- | --- |
| Application | Python FastAPI + Pydantic，業務集中在 `ErpStore` |
| Serverless adapter | Mangum，把 ASGI app 轉成 Lambda handler |
| Runtime / package | AWS Lambda Python 3.12、`build_lambda.sh` 產生 ZIP |
| Persistence | Repository abstraction：本機 InMemory；AWS DynamoDB |
| Event / alert | 本機 logging；AWS SNS topic |
| IaC | Terraform AWS provider ~5.0 |

Evidence: `app/main.py`, `app/erp.py`, `app/repository.py`, `infra/main.tf`

---

# Current vs Target

## CURRENT / code

- PO、收料、短缺異常、庫存、Dashboard
- DynamoDB transaction 與 `Idempotency-Key`
- API Gateway HTTP API → Lambda ZIP
- DynamoDB pending alert outbox + EventBridge replay worker → SNS / application log
- Optional JWT authorizer、explicit CORS origins、`X-Request-Id` correlation header

## TARGET / README roadmap

- CloudFront + S3 frontend
- S3 Excel import + SQS retry worker
- Cognito 權限、pre-signed URL
- CloudWatch Alarms、正式通知流程

> Dockerfile 仍存在，但目前 `infra/main.tf` 使用 `.lambda-build/lambda.zip`，以 ZIP 部署為準。

---

# 邏輯架構

```text
Browser / web/index.html
        │ fetch REST API
        ▼
API Gateway HTTP API (AWS_PROXY, payload 2.0)
        ▼
Lambda Python 3.12 → Mangum → FastAPI routes
        ▼
ErpStore：validation / state transition / alert decision
        ├── Repository → DynamoDB (AWS) / InMemory (local)
        ├── Alert outbox → DynamoDB (same transaction)
        └── Alert worker → SNS (AWS) / logging (local)
```

旁路：EventBridge 每分鐘觸發 alert worker；Lambda 基本執行記錄 → CloudWatch Log Group。

---

# 核心交易流程

```text
建立 PO
  → POST /api/receipts + Idempotency-Key
  → Pydantic 與 domain validation
  → 比對訂購量 / 剩餘待收量
  → 寫入 Receipt + PO + Inventory + InventoryTransaction
  → 正常：已完成；短缺：待處理異常
  → 低於 reorder_point 或有短缺 → pending alert outbox
  → alert worker 重試 → SNS / log alert
```

異常處置：`補貨` → `待補貨`；`差異允收結案` → `差異結案`。

---

# 資料模型與追溯

| Entity | 主要責任 |
| --- | --- |
| `PurchaseOrder` | 採購承諾、供應商、品項、狀態 |
| `ReceiptResult` | 每次收料結果、異常、操作人、時間 |
| `InventoryItem` | 目前庫存與 `reorder_point` |
| `InventoryTransaction` | 每筆庫存異動的 audit trail |
| Alert batch | 收料異常與低庫存通知的 pending/replay 狀態 |
| Idempotency record | key、request hash、receipt_id，防重複收料 |

DynamoDB key pattern：`PK=<entity>#<id>`, `SK=META`；以單表保存多種 entity。

---

# 可靠性設計

1. **Atomic write**：`TransactWriteItems` 一次提交收料結果、PO、庫存、異動、idempotency 與 alert outbox。
2. **Retry safe**：同一 key + 同一 payload 回傳原結果；同 key 不同 payload 回 `409`。
3. **Concurrent update safe**：PO / inventory 使用 previous data condition，衝突要求重新整理。
4. **Contract validation**：Pydantic 限制數量、品項完整性、重複料號與異常處置輸入。
5. **Notification retry**：SNS 失敗不回滾收料，pending batch 由 worker 重試。

Evidence: `app/repository.py:260-354`, `app/erp.py:253-336`, `app/main.py:59-82`

---

# API surface

| Method | Path | Purpose |
| --- | --- | --- |
| GET | `/health` / `/ready` | Liveness / repository readiness |
| GET | `/api/dashboard` | KPI 摘要 |
| GET/POST | `/api/purchase-orders` | 查詢 / 建立 PO |
| POST | `/api/receipts` | 收料、更新庫存、排入警示 |
| POST | `/api/purchase-orders/{po_id}/exception-resolution` | 補貨或差異允收結案 |
| GET | `/api/inventory` | 查詢庫存 |
| GET | `/api/inventory-transactions` | 查詢庫存異動 |

FastAPI 也提供 `/docs` API 文件。

---

# 部署框架

```text
requirements-lambda.txt + app + web
              │
              ▼
scripts/build_lambda.sh
              │ manylinux2014_x86_64
              ▼
infra/.lambda-build/lambda.zip
              │
              ▼
terraform apply
              │
              ├── API Gateway HTTP API
              ├── API Lambda + alert worker Lambda + IAM role
              ├── DynamoDB PAY_PER_REQUEST
              ├── EntityIndex、PITR、伺服器端加密、deletion protection
              ├── SNS topic + EventBridge 每分鐘重試排程
              └── CloudWatch Log Groups（可設定 retention）
```

目前仍沒有 Cognito user pool、CloudFront、S3 frontend、SQS Excel worker 與 CloudWatch Alarms；API JWT authorizer 需提供既有 issuer/audience。

---

# Code map

| File | Responsibility |
| --- | --- |
| `app/main.py` | Routes、health/readiness、HTTP status、Mangum handler |
| `app/erp.py` | Domain model、收料與異常狀態轉換 |
| `app/repository.py` | InMemory / DynamoDB adapter、transaction writes |
| `app/alerts.py` | Logging / SNS publisher |
| `app/alert_worker.py` | Pending alert replay Lambda handler |
| `app/config.py` | Environment 與 production safety guard |
| `app/mcp_server.py` | ERP approval-gated MCP stdio adapter |
| `web/index.html` | Dashboard UI、API client |
| `scripts/build_lambda.sh` | Lambda ZIP package |
| `infra/main.tf` | AWS resource graph、IAM、environment variables |
| `tests/` | API、domain、configuration、MCP tests |

**結論：**不是 AWS SAM/CDK；是 **FastAPI + Mangum + Terraform** 的 serverless application。

---

# 下一步：MVP → production ERP

1. 接上 Cognito / JWT 與 warehouse、purchaser、approver 角色。
2. 建立 private S3、pre-signed URL、SQS retry worker。
3. 補 structured logs、CloudWatch Alarms 與正式通知訂閱管理。
4. 決定 ZIP 或 container image 單一路徑，接上 CI/CD approval。

## Takeaway

核心價值是：每次收料都能被**驗證、寫入、追蹤、重試與通知**。
