# AWS 資安基準

## Security Group 公開管理埠

規則 SEC-SG-001。SSH 22、RDP 3389、MySQL 3306、PostgreSQL 5432、Redis 6379
與 MongoDB 27017 不得直接開放給 0.0.0.0/0 或 ::/0。管理 Linux 主機時優先使用
AWS Systems Manager Session Manager。若業務確實需要來源 IP，必須限制為經核准的 CIDR，
並在變更紀錄中寫明到期日。

## S3 公開存取

規則 SEC-S3-001。非公開網站用途的 Bucket 應啟用 BlockPublicAcls、IgnorePublicAcls、
BlockPublicPolicy 與 RestrictPublicBuckets。套用前必須確認 CloudFront、網站託管與跨帳號
資料交換需求，避免中斷合法存取。修正後使用授權角色與未授權請求各驗證一次。

## IAM 最小權限

規則 SEC-IAM-001。正式環境不得在客戶管理 Policy 中同時使用 Action:* 與 Resource:*。
應根據 CloudTrail 或應用程式實際呼叫的 API 建立動作白名單，並盡可能限制資源 ARN。
IAM 權限修正需要人工審查，不得由 Agent 自動縮減後直接套用。
