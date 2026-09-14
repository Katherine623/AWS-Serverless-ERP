terraform {
  # The bucket and lock table are bootstrapped by
  # scripts/migrate_terraform_state.sh before the first remote init.
  backend "s3" {
    bucket         = "erp-receiving-platform-tfstate-586106643022"
    key            = "erp-receiving-platform/terraform.tfstate"
    region         = "ap-northeast-1"
    encrypt        = true
    dynamodb_table = "erp-receiving-platform-tf-lock"
  }
}
