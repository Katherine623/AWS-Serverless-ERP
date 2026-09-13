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

variable "idempotency_ttl_days" {
  description = "Retention period for idempotency keys before they may be reused."
  type        = number
  default     = 90

  validation {
    condition     = var.idempotency_ttl_days >= 1 && var.idempotency_ttl_days <= 3650
    error_message = "idempotency_ttl_days must be between 1 and 3650."
  }
}

variable "alert_outbox_ttl_days" {
  description = "Retention period for pending alert batches."
  type        = number
  default     = 30

  validation {
    condition     = var.alert_outbox_ttl_days >= 1 && var.alert_outbox_ttl_days <= 3650
    error_message = "alert_outbox_ttl_days must be between 1 and 3650."
  }
}

variable "alert_lease_seconds" {
  description = "Lease duration preventing concurrent alert worker claims."
  type        = number
  default     = 300

  validation {
    condition     = var.alert_lease_seconds >= 30 && var.alert_lease_seconds <= 86400
    error_message = "alert_lease_seconds must be between 30 and 86400."
  }
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

variable "manage_cognito_user_pool" {
  description = "Create a Cognito user pool, app client and ERP role groups."
  type        = bool
  default     = false
}

variable "cognito_user_pool_name" {
  description = "Optional Cognito user pool name when managed by this stack."
  type        = string
  default     = ""
}

variable "cors_allowed_origins" {
  description = "Explicit browser origins allowed to call the HTTP API."
  type        = list(string)
  default     = []
}

variable "api_rate_limit" {
  description = "Steady-state requests per second allowed by the HTTP API stage."
  type        = number
  default     = 50

  validation {
    condition     = var.api_rate_limit > 0
    error_message = "api_rate_limit must be greater than zero."
  }
}

variable "api_burst_limit" {
  description = "Burst requests allowed by the HTTP API stage."
  type        = number
  default     = 100

  validation {
    condition     = var.api_burst_limit >= var.api_rate_limit
    error_message = "api_burst_limit must be at least api_rate_limit."
  }
}

variable "tags" {
  description = "Tags applied to managed AWS resources."
  type        = map(string)
  default = {
    ManagedBy = "terraform"
    Service   = "erp-receiving-platform"
  }
}
