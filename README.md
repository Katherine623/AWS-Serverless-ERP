# AWS FinOpsSec Governance Agent

一個以履歷與期末專題為目標的 AWS 成本暨資安治理 Agent。它會用唯讀權限收集 AWS
資源中繼資料、執行可重現的治理規則、顯示證據，並產生需要人工核准的修復計畫。

目前版本是第一個可執行的 MVP：包含 Demo 資料、真實 AWS 唯讀掃描、Web Dashboard、
Bedrock 摘要、FAISS 多來源政策知識庫、MCP 工具入口、Lambda 容器與 Terraform。它不會修改
或刪除 AWS 資源。

## 已支援的規則

| Rule ID | 類型 | 檢查內容 |
| --- | --- | --- |
| `SEC-SG-001` | Security | 敏感連接埠對 `0.0.0.0/0` 或 `::/0` 開放 |
| `SEC-S3-001` | Security | S3 Block Public Access 未完整啟用 |
| `SEC-IAM-001` | Security | 客戶管理 Policy 同時允許 `Action:*` 與 `Resource:*` |
| `COST-EIP-001` | Cost | Elastic IP 未附加 |
| `COST-EBS-001` | Cost | EBS Volume 處於 `available` 狀態 |
| `GOV-LOG-001` | Governance | CloudWatch Log Group 沒有保存期限 |

費用數字是治理用估算，不是 AWS 帳單。EBS 目前使用 US$0.08/GiB-month 作為基準，之後會接
AWS Pricing API 依區域計算。

## 本機啟動

需要 Python 3.12：

```powershell
python -m venv .venv
.\.venv\Scripts\Activate.ps1
python -m pip install -r requirements-dev.txt
uvicorn app.main:app --reload
```

開啟 <http://127.0.0.1:8000>，選擇 `Demo 資料` 後執行掃描。API 文件位於
<http://127.0.0.1:8000/docs>。

## 掃描真實 AWS 帳號

先使用 AWS CLI profile 或環境變數提供憑證，再把介面模式切換成 `真實 AWS 帳號`。掃描器目前
只呼叫 `List`、`Get` 與 `Describe` 類型 API。Terraform 內的 Lambda Role 也只授予唯讀掃描權限。

Windows 可以使用啟動腳本，自動找到使用者層級的 AWS CLI、驗證登入並設定環境變數：

```powershell
.\scripts\start-real-scan.ps1
```

若個人練習帳號目前只有 root 短期登入，可在一次性的唯讀測試中明確允許；正式部署前必須改成
非 root 身分：

```powershell
.\scripts\start-real-scan.ps1 -AllowRootSession
```

```powershell
$env:AWS_PROFILE = "your-profile"
$env:AWS_REGION = "ap-northeast-1"
$env:ALLOW_AWS_SCAN = "true"
uvicorn app.main:app --reload
```

若要啟用 Bedrock 主管摘要：

```powershell
$env:BEDROCK_MODEL_ID = "jp.amazon.nova-2-lite-v1:0"
```

沒有設定模型或模型呼叫失敗時，系統會使用確定性的本機摘要，掃描不會中斷。

Terraform 部署預設將 `ALLOW_AWS_SCAN` 設為 `false`，因此公開端點只能使用 Demo
資料。加入 Cognito 或其他身分驗證前，不應在公開 API 啟用真實帳號掃描。

## MCP Server

MCP Server 預設使用 stdio，提供 `scan_aws_governance` 與 `propose_remediation` 兩個工具：

```powershell
python -m app.mcp_server
```

AI IDE 的 MCP 設定可指向專案虛擬環境中的 Python：

```json
{
  "mcpServers": {
    "finopssec": {
      "command": "C:\\absolute\\path\\to\\.venv\\Scripts\\python.exe",
      "args": ["-m", "app.mcp_server"],
      "cwd": "C:\\absolute\\path\\to\\project"
    }
  }
}
```

## 測試

```powershell
ruff check .
pytest
```

## 部署輪廓

`Dockerfile` 會建立 Lambda container image。推送到 ECR 後，將映像 URI 傳入 Terraform：

```powershell
terraform -chdir=infra init
terraform -chdir=infra apply -var="image_uri=ACCOUNT.dkr.ecr.REGION.amazonaws.com/finopssec-agent:TAG"
```

Terraform 會建立 Lambda、唯讀 IAM Role 與 API Gateway HTTP API。正式部署前應使用 immutable
image digest、設定 AWS Budget，並依帳號資源縮小 IAM Resource 範圍。

## 下一個里程碑

1. DynamoDB 保存掃描、核准與稽核紀錄。
2. 加入 Step Functions human-in-the-loop 流程。
3. 產生 Terraform remediation branch 與 GitHub Pull Request。
4. 經核准後執行白名單動作，並重新掃描驗證。
5. 加入 20 個錯誤設定案例、偵測率、誤報率、Token 與成本 Dashboard。
