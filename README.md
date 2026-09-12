# AWS Serverless ERP Receiving Platform

AWS Serverless ERP 物料點收管理平台，將採購單、到貨驗收、異常判斷與庫存異動串成可追蹤流程。這個專案以履歷展示為目標，先提供可執行的本機 MVP，再逐步接上 AWS 託管服務。

## 核心流程

```text
採購單 -> 到貨驗收 -> 短缺／超收判斷 -> 庫存更新 -> Dashboard 查詢
```

目前 Demo 支援：

- 採購單與供應商資料
- 待驗收、已完成、有異常狀態
- 實際收料數量與採購數量比對
- 短缺與超收異常訊息
- 庫存與安全庫存判斷
- ERP Dashboard 與 API 文件

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

Terraform 與 Docker 已保留為部署基礎。下一階段會將目前的 in-memory Demo Store 替換成 DynamoDB，並加入私有 S3、Pre-signed URL、SQS 重試、Cognito 權限與 CloudFront。

## 本機啟動

需要 Python 3.12：

```powershell
python -m venv .venv
.\.venv\Scripts\Activate.ps1
python -m pip install -r requirements-dev.txt
uvicorn app.main:app --reload
```

開啟 <http://127.0.0.1:8000>，API 文件位於 <http://127.0.0.1:8000/docs>。

## API

| Method | Path | Purpose |
| --- | --- | --- |
| GET | `/api/dashboard` | ERP KPI 摘要 |
| GET | `/api/purchase-orders` | 查詢採購單 |
| POST | `/api/purchase-orders` | 建立採購單 |
| POST | `/api/receipts` | 送出驗收並更新庫存 |
| GET | `/api/inventory` | 查詢庫存 |

## 測試與部署

```powershell
.\.venv\Scripts\python.exe -m ruff check .
.\.venv\Scripts\python.exe -m pytest
docker build --platform linux/amd64 -t erp-receiving-platform .
```

Lambda Container、API Gateway 與 IAM 的 Terraform 設定位於 `infra/`。部署前請先將映像推送至 ECR，再以 `terraform -chdir=infra apply -var="image_uri=..."` 建立資源。

## 履歷描述

> 建置 AWS Serverless ERP 物料點收平台，整合採購單、到貨驗收、異常判斷、庫存更新與營運 Dashboard；使用 FastAPI、Lambda Container、API Gateway、DynamoDB 設計可追蹤的收料流程，並以 Terraform 與 GitHub Actions 管理雲端基礎設施與 CI/CD。
