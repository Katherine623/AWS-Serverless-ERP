# AWS Serverless ERP Receiving Platform

AWS Serverless ERP 物料點收管理平台，將採購單、到貨驗收、異常判斷與庫存異動串成可追蹤流程。正式 staging 部署使用 API Gateway JWT、Cognito、Lambda、DynamoDB、SNS 與 EventBridge；同時提供 approval-gated MCP 工具，讓 AI 可以查詢 ERP，但不能預設直接改資料。

## 核心流程

```text
採購單 -> 到貨驗收 -> 短缺／超收判斷 -> 庫存更新 -> AWS SNS 警示 -> Dashboard 查詢
```

目前功能支援：

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

庫存調整、退貨、報廢也會檢查異動後的可用量。低於安全庫存時，通知與庫存交易一併保存；SNS 失敗會留下 pending outbox。排程重送須確保 EventBridge 規則已啟用。

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

開啟 <http://127.0.0.1:8000>，API 文件位於 <http://127.0.0.1:8000/docs>。新版作業台已直接整合 PO 篩選／cursor 分頁、低庫存與隔離庫存 KPI、收料、異常處置、庫存調整、Excel 上傳與 Cognito Hosted UI 登入；不需要切換到 Swagger 才能操作。local/test 沒有 Hosted UI 時仍可用進階手動 JWT 欄位測試。

## API

### 操作重送、匯入結果與 AI 紀錄

- 收料與庫存調整表單在同一瀏覽器分頁的 `sessionStorage` 保存待確認請求，按帳號隔離。網路失敗或重新整理後，可按「重送上一筆待確認操作」沿用原內容與 key。修改內容前須查核原操作結果；關閉分頁會失去本機待確認資料。後端去重期限由 `ERP_IDEMPOTENCY_TTL_DAYS` 設定，預設 90 天，超過期限先查核帳本。
- 同 key 的並行交易若已被另一個請求保存，後端回傳已保存的單號與結果。
- Excel 上限為檔案 10 MB、解壓縮內容 50 MB、資料區 2,000 列（含中間空列）。同一 PO 的供應商、日期必須相同；任一列有錯，整張 PO 不匯入，其他有效 PO 繼續。相同既有 PO 定義略過，衝突則列為失敗。
- 上傳回傳 `job_id`，UI 自動查詢最多約 90 秒，之後可按「更新匯入結果」。顯示新增／略過／失敗 PO 數、錯誤列號及原因（最多 100 條）。最近 20 筆工作限上傳者本人查閱；大型匯入遇暫時性故障時可能已有部分 PO 保存，重試會將它們計為略過。
- AI 草稿保存於 DynamoDB，只有本人按確認才執行；確認時重新檢查目前角色。收料／調整的重送使用固定 key，保存草稿、執行、失敗、取消與完成歷程。重新整理可從 AI 分頁「我的 AI 操作紀錄」取回最近 20 筆。執行結果未確認的新建 PO／異常處置不會自動重做，需先查核 ERP。
- AI 提示分開顯示 Bedrock 配額或節流（429）、權限不足（503）、逾時（504）。仍需 AWS 帳號有模型權限與可用配額。
- 操作選單、庫存異動使用 cursor 分頁；庫存調整選單跟隨目前庫存頁及篩選條件。異動只在當頁依時間排序，並非全域最新排序。過濾頁可能為空但仍有 `next_cursor`，請繼續下一頁。每次 API 最多查 5 個 DynamoDB 分頁。
- Dashboard 在每個 Lambda 執行環境快取 20 秒，本環境寫入會使快取失效；跨環境更新及 GSI 同步可能稍有延遲。快取未命中仍為 O(N) 分頁統計，未建立預先彙總表。

新增查詢及確認端點：

| Method | Path | Purpose |
| --- | --- | --- |
| GET | `/api/imports/excel/jobs` | 本人的最近 20 筆匯入工作 |
| GET | `/api/imports/excel/jobs/{job_id}` | 匯入進度、筆數與錯誤列 |
| GET | `/api/ai/actions` | 本人的最近 20 筆 AI 操作歷程 |
| POST | `/api/ai/actions/{id}/confirm` | 明確確認並執行已保存草稿 |
| POST | `/api/ai/actions/{id}/cancel` | 取消尚未執行的草稿 |

可選的瀏覽器回歸檢查：安裝 `playwright` 與 Chromium 後執行 `python scripts/check_reliability_ui.py`。此檢查攔截所有請求，以測試資料驗證重送、分頁、匯入結果、AI 確認及取消，不寫入 AWS。

### 原有端點

| Method | Path | Purpose |
| --- | --- | --- |
| GET | `/health` / `/ready` | Liveness / DynamoDB readiness |
| GET | `/auth/config` | Cognito Hosted UI OAuth 設定（公開，只回傳 client ID 與端點） |
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

作業台另提供同頁「AI 助理」，使用 AWS Bedrock 查詢 ERP 並產生待確認操作草稿。
使用方式、模型設定與限制見 [AI 助理說明](docs/AI-assistant.md)。

MCP 是獨立的 stdio adapter，不會自動掛到公開 API Gateway。啟動：

```bash
python -m app.mcp_server
```

目前提供 Dashboard、採購單、庫存與庫存異動查詢；建立 PO、收料與異常處置都要求 `approved=true`，且還必須設定 `ERP_MCP_MUTATIONS_ENABLED=true` 才會執行變更。預設為唯讀。

HTTP API 在 `local` / `test` 使用 demo actor；`staging` / `production` 必須由 API Gateway JWT 提供 `sub` 與 `roles` / `cognito:groups`。查詢 ERP 資料也需要至少一個 ERP role；建立 PO 需要 `purchaser`、收料需要 `warehouse`、異常結案需要 `approver`；`admin` 可執行全部操作。操作者身份由 JWT subject 記錄，不接受前端自行指定。Terraform 設定 `manage_cognito_user_pool=true` 時，會一併建立只允許管理員建立使用者的 user pool、app client、Hosted UI domain 與四個 ERP role groups；作業台使用 OAuth Authorization Code + PKCE，並以 refresh token 自動更新 ID token。也可以改用既有 Cognito issuer/audience，但此時 Hosted UI 需由外部 IdP 自行提供。

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

第一次部署可先複製 `infra/terraform.tfvars.example` 為 `infra/terraform.tfvars`，再依 API 網域調整 `cors_allowed_origins`；`terraform.tfvars` 不會被 Git 追蹤。

再執行：

```bash
terraform -chdir=infra apply
```

正式環境建議確認 `erp_environment=production`、`seed_demo=false`、`manage_cognito_user_pool=true` 與 `api_auth_enabled=true`。Terraform 會輸出 `cognito_hosted_ui_url`；第一次登入只需完成 Cognito Hosted UI，之後作業台會自動刷新 token。此部署方式不需要 Docker 或 ECR；SNS Topic 會保留，警示可透過 CloudWatch Logs 查看。

若由不同網域的前端呼叫 API，請明確設定 `cors_allowed_origins = ["https://erp.example.com"]`；留空時不會啟用 API Gateway CORS。不要在正式環境使用 `*`。HTTP API stage 預設限制 50 req/s、burst 100，可依流量調整 `api_rate_limit` 與 `api_burst_limit`。

Terraform state 已設定為 S3 backend，並使用 DynamoDB lock 防止同時部署。第一次切換請執行：

```bash
AWS_PROFILE=erp-dev bash scripts/migrate_terraform_state.sh
```

腳本會建立（若不存在）啟用私有存取、SSE 加密與版本控管的 S3 state bucket，以及按量計費的 DynamoDB lock table，然後將現有 `infra/terraform.tfstate` 遷移到 S3。若 AWS 帳戶不同，請同時修改 `infra/backend.tf` 的 bucket／table 名稱，並用 `ERP_TF_STATE_BUCKET` 與 `ERP_TF_LOCK_TABLE` 傳給遷移腳本。

### GitHub Actions 自動部署

`.github/workflows/deploy.yml` 只在 `master` push 後部署 staging；它會先執行測試、建立 Lambda ZIP，再使用 S3 backend 執行 Terraform plan/apply。啟用前需完成一次 State 遷移，並在 GitHub `staging` Environment 建立非機密變數 `AWS_DEPLOY_ROLE_ARN`。

AWS IAM Role 必須信任 GitHub OIDC provider `token.actions.githubusercontent.com`，並限制 `aud=sts.amazonaws.com` 與 `sub=repo:Katherine623@199088897/AWS-Serverless-ERP@1367029885:environment:staging`。Role 至少需要 Terraform 管理本專案資源的權限、讀寫 Terraform state S3 bucket，以及讀寫 DynamoDB lock table；不要把長期 AWS access key 放進 GitHub Secrets。完成後，合併到 `master` 即會觸發部署；Workflow 會在沒有 `AWS_DEPLOY_ROLE_ARN` 時直接停止，不會執行 Terraform。

### GitHub OIDC 信任設定修復

此 repository 建立於 2026-07-15 之後，OIDC subject 包含 owner ID 與 repository ID。部署 job 使用 `environment: staging`，因此 subject 結尾是 `environment:staging`。舊的 `repo:Katherine623/AWS-Serverless-ERP:*` 不會匹配。

部署角色 `erp-github-deploy` 的信任政策保存在 `infra/github-deploy-trust-policy.json`。在專案根目錄執行：

```powershell
aws iam update-assume-role-policy --profile erp-dev --role-name erp-github-deploy --policy-document file://infra/github-deploy-trust-policy.json
```

GitHub staging Environment 的 `AWS_DEPLOY_ROLE_ARN` 應為 `arn:aws:iam::586106643022:role/erp-github-deploy`，並將 Environment deployment branches 限制為 `master`。信任政策修復後可直接重新執行失敗的 workflow。

參考：https://docs.github.com/en/actions/how-tos/secure-your-work/security-harden-deployments/oidc-in-aws

清理舊的 `DEMO-*` DynamoDB 資料時，先預覽：

```bash
AWS_PROFILE=erp-dev .venv/bin/python scripts/cleanup_demo_data.py
```

確認列出的 `PK/SK` 全部都是舊示範資料後，才執行刪除：

```bash
AWS_PROFILE=erp-dev .venv/bin/python scripts/cleanup_demo_data.py \
  --apply --confirm DELETE-DEMO-DATA
```

工具會先將命中的資料備份到 `/tmp/erp-demo-records-*.json`，只刪除與 `DEMO-*` 採購單或料號直接相關的資料，不會刪除正式 `PO-*` 或 `MAT-*` 資料。

Excel 匯入工作表第一列需包含 `po_id`、`supplier_name`、`expected_date`、`material_id`、`material_name`、`ordered_quantity`；`unit` 可選，`.xlsx` 上傳到 import bucket 後會經 SQS 交給 worker，連續失敗的訊息會進 DLQ。

## 履歷描述

> 建置 AWS Serverless ERP 物料點收平台，整合採購單、到貨驗收、異常判斷、庫存更新與營運 Dashboard；使用 FastAPI、Lambda ZIP、API Gateway、DynamoDB、SNS 與 approval-gated MCP 設計可追蹤的收料流程，並以 Terraform 與 GitHub Actions 管理雲端基礎設施與 CI/CD。
