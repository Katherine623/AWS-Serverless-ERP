variable "aws_region" {
  description = "AWS Region for the application."
  type        = string
  default     = "ap-northeast-1"
}

variable "project_name" {
  description = "Resource name prefix."
  type        = string
  default     = "erp-receiving-platform"
}

variable "erp_environment" {
  description = "Runtime environment passed to the ERP Lambda."
  type        = string
  default     = "staging"

  validation {
    condition     = contains(["local", "test", "staging", "production"], var.erp_environment)
    error_message = "erp_environment must be local, test, staging or production."
  }
}

variable "seed_demo" {
  description = "Whether the Lambda may seed demo purchase orders and inventory."
  type        = bool
  default     = false
}

variable "log_retention_days" {
  description = "CloudWatch retention for API and alert worker logs."
  type        = number
  default     = 30

  validation {
    condition     = var.log_retention_days >= 1
    error_message = "log_retention_days must be at least 1."
  }
}

variable "enable_pitr" {
  description = "Enable DynamoDB point-in-time recovery."
  type        = bool
  default     = true
}

variable "enable_deletion_protection" {
  description = "Prevent accidental DynamoDB table deletion."
  type        = bool
  default     = true
}

variable "api_auth_enabled" {
  description = "Require a JWT authorizer on the HTTP API."
  type        = bool
  default     = false
}

variable "cognito_issuer_url" {
  description = "JWT issuer URL used when API auth is enabled."
  type        = string
  default     = ""
}

variable "cognito_audience" {
  description = "JWT audience used when API auth is enabled."
  type        = string
  default     = ""
}

variable "cors_allowed_origins" {
  description = "Explicit browser origins allowed to call the HTTP API."
  type        = list(string)
  default     = []
}

variable "tags" {
  description = "Tags applied to managed AWS resources."
  type        = map(string)
  default = {
    ManagedBy = "terraform"
    Service   = "erp-receiving-platform"
  }
}
