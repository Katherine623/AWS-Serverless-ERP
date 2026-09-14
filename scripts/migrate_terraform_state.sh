#!/usr/bin/env bash
set -euo pipefail

PROJECT_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
INFRA_DIR="$PROJECT_ROOT/infra"
AWS_REGION="${AWS_REGION:-ap-northeast-1}"
STATE_BUCKET="${ERP_TF_STATE_BUCKET:-erp-receiving-platform-tfstate-586106643022}"
LOCK_TABLE="${ERP_TF_LOCK_TABLE:-erp-receiving-platform-tf-lock}"
STATE_KEY="erp-receiving-platform/terraform.tfstate"

command -v aws >/dev/null 2>&1 || {
  echo "找不到 AWS CLI，請先安裝並設定 AWS_PROFILE。" >&2
  exit 1
}
command -v terraform >/dev/null 2>&1 || {
  echo "找不到 Terraform。" >&2
  exit 1
}

echo "確認 AWS 身份與區域：${AWS_REGION}"
aws sts get-caller-identity >/dev/null

if aws s3api head-bucket --bucket "$STATE_BUCKET" >/dev/null 2>&1; then
  echo "S3 state bucket 已存在：$STATE_BUCKET"
else
  echo "建立 S3 state bucket：$STATE_BUCKET"
  if [[ "$AWS_REGION" == "us-east-1" ]]; then
    aws s3api create-bucket --bucket "$STATE_BUCKET" --region "$AWS_REGION" >/dev/null
  else
    aws s3api create-bucket \
      --bucket "$STATE_BUCKET" \
      --region "$AWS_REGION" \
      --create-bucket-configuration "LocationConstraint=$AWS_REGION" >/dev/null
  fi
fi

aws s3api put-public-access-block \
  --bucket "$STATE_BUCKET" \
  --public-access-block-configuration \
  BlockPublicAcls=true,IgnorePublicAcls=true,BlockPublicPolicy=true,RestrictPublicBuckets=true
aws s3api put-bucket-versioning \
  --bucket "$STATE_BUCKET" \
  --versioning-configuration Status=Enabled
aws s3api put-bucket-encryption \
  --bucket "$STATE_BUCKET" \
  --server-side-encryption-configuration \
  '{"Rules":[{"ApplyServerSideEncryptionByDefault":{"SSEAlgorithm":"AES256"}}]}'

if aws dynamodb describe-table --table-name "$LOCK_TABLE" --region "$AWS_REGION" >/dev/null 2>&1; then
  echo "DynamoDB lock table 已存在：$LOCK_TABLE"
else
  echo "建立 DynamoDB lock table：$LOCK_TABLE"
  aws dynamodb create-table \
    --table-name "$LOCK_TABLE" \
    --attribute-definitions AttributeName=LockID,AttributeType=S \
    --key-schema AttributeName=LockID,KeyType=HASH \
    --billing-mode PAY_PER_REQUEST \
    --region "$AWS_REGION" >/dev/null
fi
aws dynamodb wait table-exists --table-name "$LOCK_TABLE" --region "$AWS_REGION"

if aws s3api head-object \
  --bucket "$STATE_BUCKET" \
  --key "$STATE_KEY" \
  --region "$AWS_REGION" >/dev/null 2>&1; then
  echo "遠端 Terraform state 已存在，重新連線至 S3 backend。"
  terraform -chdir="$INFRA_DIR" init \
    -reconfigure \
    -backend-config="bucket=$STATE_BUCKET" \
    -backend-config="key=$STATE_KEY" \
    -backend-config="region=$AWS_REGION" \
    -backend-config="dynamodb_table=$LOCK_TABLE"
else
  if [[ ! -f "$INFRA_DIR/terraform.tfstate" ]]; then
    echo "找不到現有本機 state：$INFRA_DIR/terraform.tfstate" >&2
    exit 1
  fi
  echo "開始將本機 Terraform state 遷移到 S3。"
  terraform -chdir="$INFRA_DIR" init \
    -migrate-state \
    -backend-config="bucket=$STATE_BUCKET" \
    -backend-config="key=$STATE_KEY" \
    -backend-config="region=$AWS_REGION" \
    -backend-config="dynamodb_table=$LOCK_TABLE"
fi

echo "驗證遠端 state 可以讀取。"
terraform -chdir="$INFRA_DIR" state pull >/dev/null
echo "完成：$STATE_BUCKET/$AWS_REGION/$STATE_KEY"
