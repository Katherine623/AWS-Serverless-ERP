# AWS Serverless ERP Receiving Platform

AWS Serverless ERP 物料點收管理平台，將採購單、到貨驗收、異常判斷與庫存異動串成可追蹤流程。這個專案以履歷展示為目標，先提供可執行的本機 MVP，再逐步接上 AWS 託管服務；同時提供 approval-gated MCP 工具，讓 AI 可以查詢 ERP，但不能預設直接改資料。

## 核心流程

```text
採購單 -> 到貨驗收 -> 短缺／超收判斷 -> 庫存更新 -> AWS SNS 警示 -> Dashboard 查詢
```

目前 Demo 支援：

- 採購單與供應商資料
- 待驗收、已完成、有異常狀態
- 實際收料數量與採購數量比對
- 短缺與超收異常訊息（超收先進隔離庫存，差異允收後才轉可用庫存）
- 可用庫存、隔離庫存與安全庫存判斷
- 收料異常與低庫存警示
- ERP Dashboard 與 API 文件
- DynamoDB 持久化與收料 idempotency（設定 `ERP_DYNAMODB_TABLE_NAME` 後啟用）
- Pending alert outbox 與每分鐘重試 worker

`local` / `test` 才允許 demo seed 與 InMemory repository；`staging` / `production` 必須設定 DynamoDB 且禁止 demo seed。

## AWS 警示系統

每次送出 `POST /api/receipts` 後，系統會檢查：

- 實收數量與採購數量不同：發布 `收料異常`
- 收料後庫存低於 `reorder_point`：發布 `低庫存`

送出收料時建議帶上唯一的 `Idempotency-Key` header。相同 key 與相同內容會回傳原本的收料結果，不會重複增加庫存；相同 key 若搭配不同內容，API 會回傳 `409`。

本機未設定 `ERP_ALERT_TOPIC_ARN` 時，警示會寫入 application log；部署到 AWS 後，Terraform 會建立 SNS topic，API Lambda 將 alert batch 與收料交易一起寫入 DynamoDB，`alert_worker` 再發布 JSON 警示。SNS 暫時失敗時 batch 會保留並由 EventBridge 每分鐘重試。Email 訂閱不由 Terraform 管理，避免人工確認狀態與 Terraform state 不一致。

通知採 at-least-once delivery；下游若需要去重，請使用 `receipt_id + alert_type + material_id` 作為事件鍵。
Idempotency key 預設保留 90 天，alert outbox 預設保留 30 天；DynamoDB TTL 會清理到期資料，lease 預設 300 秒。

## AWS 架構目標

```text
CloudFront -> S3 Frontend -> API Gateway -> Lambda
                                             |
                              DynamoDB: PurchaseOrders / Receipts / Inventory
                                             |
                              S3 -> SQS -> Lambda: Excel 匯入流程
                                             |
                                      CloudWatch: Logs / Alarms
```

Terraform 與 Docker 已保留為部署基礎。設定 `enable_frontend_cdn=true` 會建立私有 S3 + CloudFront，同一個 CloudFront domain 會把 `/api/*` 轉送到 API Gateway；`manage_cognito_user_pool=true` 會建立 Cognito user pool 與 ERP groups；`enable_excel_import=true` 會建立私有 XLSX S3 bucket、SQS、DLQ 與 import worker。Pre-signed URL 與正式自訂網域憑證仍需依實際營運流程補上；目前 Terraform 已支援可選 JWT authorizer、DynamoDB PITR、alert worker、API access logs 與 CloudWatch alarms。`ops_topic_arn` 可提供給維運訂閱流程。

## 本機啟動

需要 Python 3.12：

```powershell
python -m venv .venv
.\.venv\Scripts\Activate.ps1
python -m pip install -r requirements-dev.txt
uvicorn app.main:app --reload
```

開啟 <http://127.0.0.1:8000>，API 文件位於 <http://127.0.0.1:8000/docs>。新版作業台已直接整合 PO 篩選／cursor 分頁、低庫存與隔離庫存 KPI、收料、異常處置、庫存調整、Excel 上傳與 JWT token 設定；不需要切換到 Swagger 才能操作。

## API

| Method | Path | Purpose |
| --- | --- | --- |
| GET | `/health` / `/ready` | Liveness / DynamoDB readiness |
| GET | `/api/dashboard` | ERP KPI 摘要 |
| GET | `/api/purchase-orders` | 查詢採購單 |
| GET | `/api/v2/purchase-orders?limit=50&cursor=...&status=待驗收&supplier_name=...` | 分頁、狀態與供應商篩選 |
| POST | `/api/purchase-orders` | 建立採購單 |
| POST | `/api/receipts` | 送出驗收並更新庫存 |
| POST | `/api/inventory-adjustments` | 盤點調整、退貨或報廢（需要 Idempotency-Key） |
| POST | `/api/imports/excel/upload-url` | 取得 XLSX 預簽名上傳 URL |
| POST | `/api/purchase-orders/{po_id}/exception-resolution` | 補貨或差異允收結案 |
| GET | `/api/inventory` | 查詢庫存 |
| GET | `/api/v2/inventory?limit=50&cursor=...&material_id=...&low_stock=true` | 分頁、料號與低庫存篩選 |
| GET | `/api/inventory-transactions` | 查詢庫存異動 |
| GET | `/api/v2/inventory-transactions?limit=50&cursor=...&material_id=...&transaction_type=報廢` | 分頁、料號與異動類型篩選 |

收料 API 需要 `Idempotency-Key` header；超收會建立異常，必須使用「差異允收結案」才能關閉。

v2 cursor 是 opaque token，且會綁定當次篩選條件；拿不同 `status`、`material_id` 或其他 filter 重用 cursor 會收到 `400`，避免跨查詢跳頁。

## ERP MCP

MCP 是獨立的 stdio adapter，不會自動掛到公開 API Gateway。啟動：

```bash
python -m app.mcp_server
```

目前提供 Dashboard、採購單、庫存與庫存異動查詢；建立 PO、收料與異常處置都要求 `approved=true`，且還必須設定 `ERP_MCP_MUTATIONS_ENABLED=true` 才會執行變更。預設為唯讀。

HTTP API 在 `local` / `test` 使用 demo actor；`staging` / `production` 必須由 API Gateway JWT 提供 `sub` 與 `roles` / `cognito:groups`。建立 PO 需要 `purchaser`、收料需要 `warehouse`、異常結案需要 `approver`；`admin` 可執行全部操作。操作者身份由 JWT subject 記錄，不接受前端自行指定。Terraform 設定 `manage_cognito_user_pool=true` 時，會一併建立 user pool、app client 與四個 ERP role groups；也可以改用既有 Cognito issuer/audience。

## 測試與部署

```powershell
.\.venv\Scripts\python.exe -m ruff check .
.\.venv\Scripts\python.exe -m pytest
docker build --platform linux/amd64 -t erp-receiving-platform .
```

Lambda ZIP、API Gateway、IAM、DynamoDB、SNS 與 alert worker 的 Terraform 設定位於 `infra/`。部署前先建立 Lambda ZIP：

```bash
bash scripts/build_lambda.sh
```

再執行：

```bash
terraform -chdir=infra apply
```

正式環境建議確認 `erp_environment=production`、`seed_demo=false`，並提供 Cognito issuer/audience 後設定 `api_auth_enabled=true`。此部署方式不需要 Docker 或 ECR；SNS Topic 會保留，警示可透過 CloudWatch Logs 查看。

若由不同網域的前端呼叫 API，請明確設定 `cors_allowed_origins = ["https://erp.example.com"]`；留空時不會啟用 API Gateway CORS。不要在正式環境使用 `*`。HTTP API stage 預設限制 50 req/s、burst 100，可依流量調整 `api_rate_limit` 與 `api_burst_limit`。

團隊或正式環境不要使用本機 Terraform state；請先建立受加密與版本控管保護的 S3 state bucket，再將 `infra/backend.tf.example` 複製成 `infra/backend.tf` 並填入實際 bucket。

Excel 匯入工作表第一列需包含 `po_id`、`supplier_name`、`expected_date`、`material_id`、`material_name`、`ordered_quantity`；`unit` 可選，`.xlsx` 上傳到 import bucket 後會經 SQS 交給 worker，連續失敗的訊息會進 DLQ。

## 履歷描述

> 建置 AWS Serverless ERP 物料點收平台，整合採購單、到貨驗收、異常判斷、庫存更新與營運 Dashboard；使用 FastAPI、Lambda ZIP、API Gateway、DynamoDB、SNS 與 approval-gated MCP 設計可追蹤的收料流程，並以 Terraform 與 GitHub Actions 管理雲端基礎設施與 CI/CD。
