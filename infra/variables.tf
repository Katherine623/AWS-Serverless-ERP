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

variable "image_uri" {
  description = "ECR image URI including an immutable tag or digest."
  type        = string
}

variable "bedrock_model_id" {
  description = "Optional Bedrock model ID for generated summaries."
  type        = string
  default     = ""
}

