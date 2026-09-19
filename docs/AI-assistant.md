# ERP AI 助理

同一個作業台新增「AI 助理」分頁，登入後可詢問庫存、採購單、異動與 KPI。
後端使用 Amazon Bedrock Converse，預設部署至東京區的 `amazon.nova-lite-v1:0`。
模型未啟用、無權限或 AWS 帳戶仍在驗證時，頁面會顯示錯誤，不會以假資料回覆。

## 操作

1. 登入 Cognito，切換「AI 助理」。
2. 輸入問題，例如「有哪些低庫存料號？」。
3. 回答下方可展開本次 ERP 查詢來源；分頁結果不代表全量。
4. 要求建立 PO、收料、庫存調整或異常處置時，AI 只產生草稿。
5. 核對草稿後按「確認送出」，由原本的業務 API 再次驗證角色與資料。
6. 收料和庫存調整的重試沿用同一個 Idempotency-Key；取消不會寫入。

對話僅存在頁面記憶體，重新整理、登出或清除時移除。送往模型的歷史最多八則。
不要在對話中輸入密碼或金鑰；模型會收到使用者問題與本次工具查詢的 ERP 資料。

## 程式分工

- `app/ai.py`：Bedrock 工具迴圈、输入限制、草稿驗證；不執行寫入。
- `app/erp_tools.py`：共用分頁查詢工具，MCP `query_erp` 與網頁 AI 都使用。
- `app/main.py`：`GET /api/ai/config`、`POST /api/ai/chat`，要求 ERP 角色。
- `web/ai.mjs`：對話、來源、確認卡片，確認後呼叫既有 POST API。
- `app/mcp_server.py`：仍保留 stdio MCP；網頁後端直接使用共用工具，不啟動 stdio 子程序。

## 設定與限制

`ERP_AI_MODEL_ID` 為空時停用模型接口。本機需要可用的 AWS profile 與區域；
Terraform 變數 `ai_model_id` 控制 Lambda 環境設定與指定區域模型的 InvokeModel 權限。
目前 IAM 設定針對區域 foundation model；若改跨區 inference profile，需同步調整授權資源。

每個請求最多兩次模型呼叫、每次最多四個工具；每個查詢最多 50 筆。
模型呼叫不自動重試，限制回應時間；複雜問題可拆成多次詢問。
模型建議可能不完整，草稿並不保證可成功執行；正式 API 仍驗證狀態、數量與權限。
目前不保存跨裝置聊天歷史、不使用向量資料庫，也不授予模型直接寫入權限。

Lambda 依賴與一般依賴都接受安全掃描，CI 執行 AI 角色、草稿、錯誤與工具限制測試。
