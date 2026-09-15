terraform {
  required_version = ">= 1.7.0"

  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 5.0"
    }
  }
}

provider "aws" {
  region = var.aws_region
}

data "aws_caller_identity" "current" {}

locals {
  managed_cognito_issuer   = var.manage_cognito_user_pool ? "https://cognito-idp.${var.aws_region}.amazonaws.com/${aws_cognito_user_pool.erp[0].id}" : ""
  managed_cognito_audience = var.manage_cognito_user_pool ? aws_cognito_user_pool_client.erp[0].id : ""
  managed_cognito_domain   = var.manage_cognito_user_pool ? "https://${aws_cognito_user_pool_domain.erp[0].domain}.auth.${var.aws_region}.amazoncognito.com" : ""
  cognito_domain_prefix    = var.cognito_domain_prefix != "" ? var.cognito_domain_prefix : "${var.project_name}-${data.aws_caller_identity.current.account_id}"
  jwt_issuer               = var.manage_cognito_user_pool ? local.managed_cognito_issuer : var.cognito_issuer_url
  jwt_audience             = var.manage_cognito_user_pool ? local.managed_cognito_audience : var.cognito_audience
  public_base_url          = var.enable_frontend_cdn ? "https://${aws_cloudfront_distribution.frontend[0].domain_name}" : aws_apigatewayv2_api.http.api_endpoint
  upload_cors_origins      = var.enable_frontend_cdn ? [local.public_base_url] : var.cors_allowed_origins
}

resource "aws_cognito_user_pool" "erp" {
  count = var.manage_cognito_user_pool ? 1 : 0
  name  = var.cognito_user_pool_name != "" ? var.cognito_user_pool_name : "${var.project_name}-users"

  username_attributes = ["email"]

  password_policy {
    minimum_length                   = 12
    require_lowercase                = true
    require_numbers                  = true
    require_symbols                  = true
    require_uppercase                = true
    temporary_password_validity_days = 1
  }

  auto_verified_attributes = ["email"]

  admin_create_user_config {
    allow_admin_create_user_only = true
  }

  tags = var.tags
}

resource "aws_cognito_user_pool_client" "erp" {
  count                         = var.manage_cognito_user_pool ? 1 : 0
  name                          = "${var.project_name}-api"
  user_pool_id                  = aws_cognito_user_pool.erp[0].id
  generate_secret               = false
  prevent_user_existence_errors = "ENABLED"
  explicit_auth_flows = [
    "ALLOW_REFRESH_TOKEN_AUTH",
    "ALLOW_USER_SRP_AUTH",
    "ALLOW_USER_PASSWORD_AUTH",
  ]
  allowed_oauth_flows_user_pool_client = true
  allowed_oauth_flows                  = ["code"]
  allowed_oauth_scopes                 = ["openid", "email", "profile"]
  callback_urls                        = ["${local.public_base_url}/"]
  logout_urls                          = ["${local.public_base_url}/"]
  supported_identity_providers         = ["COGNITO"]
}

resource "aws_cognito_user_pool_domain" "erp" {
  count        = var.manage_cognito_user_pool ? 1 : 0
  domain       = local.cognito_domain_prefix
  user_pool_id = aws_cognito_user_pool.erp[0].id
}

resource "aws_cognito_user_group" "erp_roles" {
  for_each     = var.manage_cognito_user_pool ? toset(["admin", "approver", "purchaser", "warehouse"]) : toset([])
  name         = each.key
  user_pool_id = aws_cognito_user_pool.erp[0].id
  description  = "ERP ${each.key} role"
}

resource "terraform_data" "auth_config" {
  input = jsonencode({ enabled = var.api_auth_enabled, managed = var.manage_cognito_user_pool })

  lifecycle {
    precondition {
      condition = !var.api_auth_enabled || (
        local.jwt_issuer != "" && local.jwt_audience != ""
      )
      error_message = "cognito_issuer_url and cognito_audience are required when API auth is enabled."
    }

    precondition {
      condition     = contains(["local", "test"], var.erp_environment) || var.api_auth_enabled
      error_message = "api_auth_enabled must be true in staging and production."
    }

    precondition {
      condition     = contains(["local", "test"], var.erp_environment) || !var.seed_demo
      error_message = "seed_demo must be false in staging and production."
    }
  }
}

resource "aws_dynamodb_table" "erp" {
  name                        = "${var.project_name}-data"
  billing_mode                = "PAY_PER_REQUEST"
  hash_key                    = "PK"
  range_key                   = "SK"
  deletion_protection_enabled = var.enable_deletion_protection

  attribute {
    name = "PK"
    type = "S"
  }

  attribute {
    name = "SK"
    type = "S"
  }

  attribute {
    name = "entity"
    type = "S"
  }

  attribute {
    name = "entity_key"
    type = "S"
  }

  global_secondary_index {
    name            = "EntityIndex"
    hash_key        = "entity"
    range_key       = "entity_key"
    projection_type = "ALL"
  }

  point_in_time_recovery {
    enabled = var.enable_pitr
  }

  ttl {
    attribute_name = "expires_at"
    enabled        = true
  }

  server_side_encryption {
    enabled = true
  }

  tags = var.tags
}

resource "aws_iam_role" "lambda" {
  name = "${var.project_name}-lambda"

  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect = "Allow"
      Principal = {
        Service = "lambda.amazonaws.com"
      }
      Action = "sts:AssumeRole"
    }]
  })
}

resource "aws_iam_role_policy_attachment" "lambda_logs" {
  role       = aws_iam_role.lambda.name
  policy_arn = "arn:aws:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole"
}

resource "aws_cloudwatch_log_group" "api" {
  name              = "/aws/lambda/${var.project_name}"
  retention_in_days = var.log_retention_days
  tags              = var.tags
}

resource "aws_cloudwatch_log_group" "alert_worker" {
  name              = "/aws/lambda/${var.project_name}-alert-worker"
  retention_in_days = var.log_retention_days
  tags              = var.tags
}

resource "aws_cloudwatch_log_group" "api_gateway" {
  name              = "/aws/apigateway/${var.project_name}"
  retention_in_days = var.log_retention_days
  tags              = var.tags
}

resource "aws_cloudwatch_log_group" "import_worker" {
  name              = "/aws/lambda/${var.project_name}-import-worker"
  retention_in_days = var.log_retention_days
  tags              = var.tags
}

resource "aws_sns_topic" "erp_alerts" {
  name              = "${var.project_name}-alerts"
  kms_master_key_id = "alias/aws/sns"
  tags              = var.tags
}

resource "aws_sns_topic" "erp_ops" {
  name              = "${var.project_name}-ops"
  kms_master_key_id = "alias/aws/sns"
  tags              = var.tags
}

resource "aws_iam_role_policy" "lambda_alerts" {
  name = "${var.project_name}-publish-alerts"
  role = aws_iam_role.lambda.id

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect   = "Allow"
      Action   = "sns:Publish"
      Resource = aws_sns_topic.erp_alerts.arn
    }]
  })
}

resource "aws_iam_role_policy" "lambda_data" {
  name = "${var.project_name}-dynamodb"
  role = aws_iam_role.lambda.id

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect = "Allow"
      Action = [
        "dynamodb:GetItem",
        "dynamodb:PutItem",
        "dynamodb:UpdateItem",
        "dynamodb:DeleteItem",
        "dynamodb:Query",
        "dynamodb:TransactWriteItems"
      ]
      Resource = [
        aws_dynamodb_table.erp.arn,
        "${aws_dynamodb_table.erp.arn}/index/*",
      ]
    }]
  })
}

resource "aws_iam_role_policy" "ai_model" {
  count = var.ai_model_id != "" ? 1 : 0
  name  = "${var.project_name}-ai-model"
  role  = aws_iam_role.lambda.id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect   = "Allow"
      Action   = ["bedrock:InvokeModel"]
      Resource = "arn:aws:bedrock:${var.aws_region}::foundation-model/${var.ai_model_id}"
    }]
  })
}

resource "aws_lambda_function" "api" {
  function_name    = var.project_name
  role             = aws_iam_role.lambda.arn
  filename         = "${path.module}/.lambda-build/lambda.zip"
  source_code_hash = filebase64sha256("${path.module}/.lambda-build/lambda.zip")
  runtime          = "python3.12"
  handler          = "app.main.handler"
  architectures    = ["x86_64"]
  memory_size      = 512
  timeout          = 30
  tags             = var.tags
  depends_on       = [aws_cloudwatch_log_group.api]

  environment {
    variables = {
      ERP_ALERT_TOPIC_ARN       = aws_sns_topic.erp_alerts.arn
      ERP_DYNAMODB_TABLE_NAME   = aws_dynamodb_table.erp.name
      ERP_ENVIRONMENT           = var.erp_environment
      ERP_SEED_DEMO             = tostring(var.seed_demo)
      ERP_MCP_MUTATIONS_ENABLED = "false"
      ERP_IDEMPOTENCY_TTL_DAYS  = tostring(var.idempotency_ttl_days)
      ERP_ALERT_OUTBOX_TTL_DAYS = tostring(var.alert_outbox_ttl_days)
      ERP_ALERT_LEASE_SECONDS   = tostring(var.alert_lease_seconds)
      ERP_IMPORT_BUCKET_NAME    = var.enable_excel_import ? aws_s3_bucket.imports[0].bucket : ""
      ERP_COGNITO_CLIENT_ID     = local.managed_cognito_audience
      ERP_COGNITO_DOMAIN        = local.managed_cognito_domain
      ERP_PUBLIC_BASE_URL       = local.public_base_url
      ERP_AI_MODEL_ID           = var.ai_model_id
    }
  }
}

resource "aws_lambda_function" "alert_worker" {
  function_name    = "${var.project_name}-alert-worker"
  role             = aws_iam_role.lambda.arn
  filename         = "${path.module}/.lambda-build/lambda.zip"
  source_code_hash = filebase64sha256("${path.module}/.lambda-build/lambda.zip")
  runtime          = "python3.12"
  handler          = "app.alert_worker.handler"
  architectures    = ["x86_64"]
  memory_size      = 256
  timeout          = 30
  tags             = var.tags
  depends_on       = [aws_cloudwatch_log_group.alert_worker]

  environment {
    variables = {
      ERP_ALERT_TOPIC_ARN       = aws_sns_topic.erp_alerts.arn
      ERP_DYNAMODB_TABLE_NAME   = aws_dynamodb_table.erp.name
      ERP_ENVIRONMENT           = var.erp_environment
      ERP_SEED_DEMO             = "false"
      ERP_MCP_MUTATIONS_ENABLED = "false"
      ERP_IDEMPOTENCY_TTL_DAYS  = tostring(var.idempotency_ttl_days)
      ERP_ALERT_OUTBOX_TTL_DAYS = tostring(var.alert_outbox_ttl_days)
      ERP_ALERT_LEASE_SECONDS   = tostring(var.alert_lease_seconds)
      ERP_IMPORT_BUCKET_NAME    = var.enable_excel_import ? aws_s3_bucket.imports[0].bucket : ""
    }
  }
}

resource "aws_lambda_function" "import_worker" {
  count            = var.enable_excel_import ? 1 : 0
  function_name    = "${var.project_name}-import-worker"
  role             = aws_iam_role.lambda.arn
  filename         = "${path.module}/.lambda-build/lambda.zip"
  source_code_hash = filebase64sha256("${path.module}/.lambda-build/lambda.zip")
  runtime          = "python3.12"
  handler          = "app.import_worker.handler"
  architectures    = ["x86_64"]
  memory_size      = 512
  timeout          = 240
  tags             = var.tags
  depends_on       = [aws_cloudwatch_log_group.import_worker]

  environment {
    variables = {
      ERP_ALERT_TOPIC_ARN       = aws_sns_topic.erp_alerts.arn
      ERP_DYNAMODB_TABLE_NAME   = aws_dynamodb_table.erp.name
      ERP_ENVIRONMENT           = var.erp_environment
      ERP_SEED_DEMO             = "false"
      ERP_MCP_MUTATIONS_ENABLED = "false"
      ERP_IDEMPOTENCY_TTL_DAYS  = tostring(var.idempotency_ttl_days)
      ERP_ALERT_OUTBOX_TTL_DAYS = tostring(var.alert_outbox_ttl_days)
      ERP_ALERT_LEASE_SECONDS   = tostring(var.alert_lease_seconds)
      ERP_IMPORT_BUCKET_NAME    = var.enable_excel_import ? aws_s3_bucket.imports[0].bucket : ""
    }
  }
}

resource "aws_iam_role_policy_attachment" "lambda_sqs" {
  count      = var.enable_excel_import ? 1 : 0
  role       = aws_iam_role.lambda.name
  policy_arn = "arn:aws:iam::aws:policy/service-role/AWSLambdaSQSQueueExecutionRole"
}

resource "aws_lambda_event_source_mapping" "imports" {
  count                              = var.enable_excel_import ? 1 : 0
  event_source_arn                   = aws_sqs_queue.imports[0].arn
  function_name                      = aws_lambda_function.import_worker[0].arn
  batch_size                         = 1
  function_response_types            = ["ReportBatchItemFailures"]
  maximum_batching_window_in_seconds = 5
  scaling_config {
    maximum_concurrency = 2
  }
}

resource "aws_cloudwatch_event_rule" "alert_worker" {
  name                = "${var.project_name}-alert-worker"
  description         = "Replay pending ERP alert batches."
  schedule_expression = "rate(1 minute)"
  tags                = var.tags
}

resource "aws_cloudwatch_event_target" "alert_worker" {
  rule = aws_cloudwatch_event_rule.alert_worker.name
  arn  = aws_lambda_function.alert_worker.arn
}

resource "aws_lambda_permission" "alert_worker_events" {
  statement_id  = "AllowEventBridgeAlertWorker"
  action        = "lambda:InvokeFunction"
  function_name = aws_lambda_function.alert_worker.function_name
  principal     = "events.amazonaws.com"
  source_arn    = aws_cloudwatch_event_rule.alert_worker.arn
}

resource "aws_apigatewayv2_api" "http" {
  name          = var.project_name
  protocol_type = "HTTP"

  dynamic "cors_configuration" {
    for_each = length(var.cors_allowed_origins) > 0 ? [true] : []
    content {
      allow_headers = ["content-type", "idempotency-key", "x-request-id", "authorization"]
      allow_methods = ["GET", "POST", "OPTIONS"]
      allow_origins = var.cors_allowed_origins
      max_age       = 300
    }
  }
}

resource "aws_apigatewayv2_integration" "lambda" {
  api_id                 = aws_apigatewayv2_api.http.id
  integration_type       = "AWS_PROXY"
  integration_uri        = aws_lambda_function.api.invoke_arn
  payload_format_version = "2.0"
}

resource "aws_apigatewayv2_authorizer" "jwt" {
  count            = var.api_auth_enabled ? 1 : 0
  api_id           = aws_apigatewayv2_api.http.id
  authorizer_type  = "JWT"
  identity_sources = ["$request.header.Authorization"]
  name             = "${var.project_name}-jwt"

  jwt_configuration {
    audience = [local.jwt_audience]
    issuer   = local.jwt_issuer
  }
}

resource "aws_apigatewayv2_route" "default" {
  api_id             = aws_apigatewayv2_api.http.id
  route_key          = "$default"
  target             = "integrations/${aws_apigatewayv2_integration.lambda.id}"
  authorization_type = var.api_auth_enabled ? "JWT" : "NONE"
  authorizer_id      = var.api_auth_enabled ? aws_apigatewayv2_authorizer.jwt[0].id : null
  depends_on         = [terraform_data.auth_config]
}

resource "aws_apigatewayv2_route" "index" {
  api_id             = aws_apigatewayv2_api.http.id
  route_key          = "GET /"
  target             = "integrations/${aws_apigatewayv2_integration.lambda.id}"
  authorization_type = "NONE"
}

resource "aws_apigatewayv2_route" "frontend_script" {
  api_id             = aws_apigatewayv2_api.http.id
  route_key          = "GET /app.js"
  target             = "integrations/${aws_apigatewayv2_integration.lambda.id}"
  authorization_type = "NONE"
}

resource "aws_apigatewayv2_route" "purchase_order_template" {
  api_id             = aws_apigatewayv2_api.http.id
  route_key          = "GET /purchase-order-template.xlsx"
  target             = "integrations/${aws_apigatewayv2_integration.lambda.id}"
  authorization_type = "NONE"
}

resource "aws_apigatewayv2_route" "favicon" {
  api_id             = aws_apigatewayv2_api.http.id
  route_key          = "GET /favicon.ico"
  target             = "integrations/${aws_apigatewayv2_integration.lambda.id}"
  authorization_type = "NONE"
}

resource "aws_apigatewayv2_route" "health" {
  api_id             = aws_apigatewayv2_api.http.id
  route_key          = "GET /health"
  target             = "integrations/${aws_apigatewayv2_integration.lambda.id}"
  authorization_type = "NONE"
}

resource "aws_apigatewayv2_route" "ready" {
  api_id             = aws_apigatewayv2_api.http.id
  route_key          = "GET /ready"
  target             = "integrations/${aws_apigatewayv2_integration.lambda.id}"
  authorization_type = "NONE"
}

resource "aws_apigatewayv2_route" "auth_config" {
  api_id             = aws_apigatewayv2_api.http.id
  route_key          = "GET /auth/config"
  target             = "integrations/${aws_apigatewayv2_integration.lambda.id}"
  authorization_type = "NONE"
}

resource "aws_apigatewayv2_stage" "default" {
  api_id      = aws_apigatewayv2_api.http.id
  name        = "$default"
  auto_deploy = true

  default_route_settings {
    throttling_burst_limit = var.api_burst_limit
    throttling_rate_limit  = var.api_rate_limit
  }

  access_log_settings {
    destination_arn = aws_cloudwatch_log_group.api_gateway.arn
    format = jsonencode({
      requestId        = "$context.requestId"
      routeKey         = "$context.routeKey"
      status           = "$context.status"
      requestTime      = "$context.requestTime"
      integrationError = "$context.integrationErrorMessage"
    })
  }
}

resource "aws_lambda_permission" "api_gateway" {
  statement_id  = "AllowApiGateway"
  action        = "lambda:InvokeFunction"
  function_name = aws_lambda_function.api.function_name
  principal     = "apigateway.amazonaws.com"
  source_arn    = "${aws_apigatewayv2_api.http.execution_arn}/*/*"
}

resource "aws_s3_bucket" "frontend" {
  count         = var.enable_frontend_cdn ? 1 : 0
  bucket_prefix = "${var.project_name}-frontend-"
  force_destroy = var.frontend_force_destroy
  tags          = var.tags
}

resource "aws_s3_bucket_public_access_block" "frontend" {
  count                   = var.enable_frontend_cdn ? 1 : 0
  bucket                  = aws_s3_bucket.frontend[0].id
  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

resource "aws_s3_bucket_ownership_controls" "frontend" {
  count  = var.enable_frontend_cdn ? 1 : 0
  bucket = aws_s3_bucket.frontend[0].id

  rule {
    object_ownership = "BucketOwnerEnforced"
  }
}

resource "aws_s3_bucket_server_side_encryption_configuration" "frontend" {
  count  = var.enable_frontend_cdn ? 1 : 0
  bucket = aws_s3_bucket.frontend[0].id

  rule {
    apply_server_side_encryption_by_default {
      sse_algorithm = "AES256"
    }
  }
}

resource "aws_s3_bucket_versioning" "frontend" {
  count  = var.enable_frontend_cdn ? 1 : 0
  bucket = aws_s3_bucket.frontend[0].id

  versioning_configuration {
    status = "Enabled"
  }
}

resource "aws_s3_bucket_lifecycle_configuration" "frontend" {
  count  = var.enable_frontend_cdn ? 1 : 0
  bucket = aws_s3_bucket.frontend[0].id

  rule {
    id     = "expire-old-frontend-versions"
    status = "Enabled"

    filter {}

    noncurrent_version_expiration {
      noncurrent_days = 30
    }
  }
}

resource "aws_s3_object" "frontend_index" {
  count        = var.enable_frontend_cdn ? 1 : 0
  bucket       = aws_s3_bucket.frontend[0].id
  key          = "index.html"
  source       = "${path.module}/../web/index.html"
  etag         = filemd5("${path.module}/../web/index.html")
  content_type = "text/html; charset=utf-8"
}

resource "aws_s3_object" "frontend_app" {
  count        = var.enable_frontend_cdn ? 1 : 0
  bucket       = aws_s3_bucket.frontend[0].id
  key          = "app.js"
  source       = "${path.module}/../web/app.js"
  etag         = filemd5("${path.module}/../web/app.js")
  content_type = "text/javascript; charset=utf-8"
}

resource "aws_s3_object" "purchase_order_template" {
  count        = var.enable_frontend_cdn ? 1 : 0
  bucket       = aws_s3_bucket.frontend[0].id
  key          = "purchase-order-template.xlsx"
  source       = "${path.module}/../web/purchase-order-template.xlsx"
  etag         = filemd5("${path.module}/../web/purchase-order-template.xlsx")
  content_type = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
}

resource "aws_cloudfront_origin_access_control" "frontend" {
  count                             = var.enable_frontend_cdn ? 1 : 0
  name                              = "${var.project_name}-frontend-oac"
  description                       = "Private S3 origin access for the ERP frontend."
  origin_access_control_origin_type = "s3"
  signing_behavior                  = "always"
  signing_protocol                  = "sigv4"
}

resource "aws_cloudfront_response_headers_policy" "frontend_security" {
  count = var.enable_frontend_cdn ? 1 : 0
  name  = "${var.project_name}-frontend-security"

  security_headers_config {
    content_security_policy {
      content_security_policy = "default-src 'self'; connect-src 'self' ${local.managed_cognito_domain}; img-src 'self' data:; style-src 'self' 'unsafe-inline'; script-src 'self' 'unsafe-inline'; base-uri 'self'; frame-ancestors 'none'"
      override                = true
    }
    content_type_options {
      override = true
    }
    frame_options {
      frame_option = "DENY"
      override     = true
    }
    referrer_policy {
      referrer_policy = "strict-origin-when-cross-origin"
      override        = true
    }
    strict_transport_security {
      access_control_max_age_sec = 31536000
      include_subdomains         = true
      override                   = true
      preload                    = false
    }
  }
}

resource "aws_cloudfront_distribution" "frontend" {
  count               = var.enable_frontend_cdn ? 1 : 0
  enabled             = true
  comment             = "${var.project_name} frontend"
  default_root_object = "index.html"
  price_class         = "PriceClass_100"

  origin {
    domain_name              = aws_s3_bucket.frontend[0].bucket_regional_domain_name
    origin_id                = "s3-frontend"
    origin_access_control_id = aws_cloudfront_origin_access_control.frontend[0].id
  }

  origin {
    domain_name = replace(aws_apigatewayv2_api.http.api_endpoint, "https://", "")
    origin_id   = "api-gateway"

    custom_origin_config {
      http_port              = 80
      https_port             = 443
      origin_protocol_policy = "https-only"
      origin_ssl_protocols   = ["TLSv1.2"]
    }
  }

  default_cache_behavior {
    target_origin_id       = "s3-frontend"
    viewer_protocol_policy = "redirect-to-https"
    allowed_methods        = ["GET", "HEAD", "OPTIONS"]
    cached_methods         = ["GET", "HEAD", "OPTIONS"]
    compress               = true

    forwarded_values {
      query_string = false
      cookies {
        forward = "none"
      }
    }
    min_ttl                    = 0
    default_ttl                = 0
    max_ttl                    = 0
    response_headers_policy_id = aws_cloudfront_response_headers_policy.frontend_security[0].id
  }

  ordered_cache_behavior {
    path_pattern           = "/api/*"
    target_origin_id       = "api-gateway"
    viewer_protocol_policy = "redirect-to-https"
    allowed_methods        = ["DELETE", "GET", "HEAD", "OPTIONS", "PATCH", "POST", "PUT"]
    cached_methods         = ["GET", "HEAD", "OPTIONS"]
    compress               = true

    forwarded_values {
      query_string = true
      headers      = ["Authorization", "Content-Type", "Idempotency-Key", "Origin", "X-Request-Id"]
      cookies {
        forward = "all"
      }
    }
    response_headers_policy_id = aws_cloudfront_response_headers_policy.frontend_security[0].id
    min_ttl                    = 0
    default_ttl                = 0
    max_ttl                    = 0
  }

  ordered_cache_behavior {
    path_pattern           = "/auth/*"
    target_origin_id       = "api-gateway"
    viewer_protocol_policy = "redirect-to-https"
    allowed_methods        = ["GET", "HEAD", "OPTIONS"]
    cached_methods         = ["GET", "HEAD", "OPTIONS"]
    compress               = true

    forwarded_values {
      query_string = true
      headers      = ["Origin", "X-Request-Id"]
      cookies {
        forward = "none"
      }
    }
    response_headers_policy_id = aws_cloudfront_response_headers_policy.frontend_security[0].id
    min_ttl                    = 0
    default_ttl                = 0
    max_ttl                    = 0
  }

  ordered_cache_behavior {
    path_pattern           = "/health"
    target_origin_id       = "api-gateway"
    viewer_protocol_policy = "redirect-to-https"
    allowed_methods        = ["GET", "HEAD", "OPTIONS"]
    cached_methods         = ["GET", "HEAD", "OPTIONS"]
    compress               = true

    forwarded_values {
      query_string = false
      cookies {
        forward = "none"
      }
    }
    response_headers_policy_id = aws_cloudfront_response_headers_policy.frontend_security[0].id
    min_ttl                    = 0
    default_ttl                = 0
    max_ttl                    = 0
  }

  ordered_cache_behavior {
    path_pattern           = "/ready"
    target_origin_id       = "api-gateway"
    viewer_protocol_policy = "redirect-to-https"
    allowed_methods        = ["GET", "HEAD", "OPTIONS"]
    cached_methods         = ["GET", "HEAD", "OPTIONS"]
    compress               = true

    forwarded_values {
      query_string = false
      cookies {
        forward = "none"
      }
    }
    response_headers_policy_id = aws_cloudfront_response_headers_policy.frontend_security[0].id
    min_ttl                    = 0
    default_ttl                = 0
    max_ttl                    = 0
  }

  restrictions {
    geo_restriction {
      restriction_type = "none"
    }
  }

  viewer_certificate {
    cloudfront_default_certificate = true
  }

}

resource "aws_s3_bucket_policy" "frontend" {
  count  = var.enable_frontend_cdn ? 1 : 0
  bucket = aws_s3_bucket.frontend[0].id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Sid    = "AllowCloudFrontRead"
      Effect = "Allow"
      Principal = {
        Service = "cloudfront.amazonaws.com"
      }
      Action   = "s3:GetObject"
      Resource = "${aws_s3_bucket.frontend[0].arn}/*"
      Condition = {
        StringEquals = {
          "AWS:SourceArn" = aws_cloudfront_distribution.frontend[0].arn
        }
      }
    }]
  })
}

resource "aws_s3_bucket" "imports" {
  count         = var.enable_excel_import ? 1 : 0
  bucket_prefix = "${var.project_name}-imports-"
  force_destroy = var.import_bucket_force_destroy
  tags          = var.tags
}

resource "aws_s3_bucket_public_access_block" "imports" {
  count                   = var.enable_excel_import ? 1 : 0
  bucket                  = aws_s3_bucket.imports[0].id
  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

resource "aws_s3_bucket_ownership_controls" "imports" {
  count  = var.enable_excel_import ? 1 : 0
  bucket = aws_s3_bucket.imports[0].id

  rule {
    object_ownership = "BucketOwnerEnforced"
  }
}

resource "aws_s3_bucket_server_side_encryption_configuration" "imports" {
  count  = var.enable_excel_import ? 1 : 0
  bucket = aws_s3_bucket.imports[0].id

  rule {
    apply_server_side_encryption_by_default {
      sse_algorithm = "AES256"
    }
  }
}

resource "aws_s3_bucket_versioning" "imports" {
  count  = var.enable_excel_import ? 1 : 0
  bucket = aws_s3_bucket.imports[0].id

  versioning_configuration {
    status = "Enabled"
  }
}

resource "aws_s3_bucket_cors_configuration" "imports" {
  count  = var.enable_excel_import && length(local.upload_cors_origins) > 0 ? 1 : 0
  bucket = aws_s3_bucket.imports[0].id

  cors_rule {
    allowed_headers = ["*"]
    allowed_methods = ["GET", "HEAD", "PUT"]
    allowed_origins = local.upload_cors_origins
    expose_headers  = ["ETag"]
    max_age_seconds = 3000
  }
}

resource "aws_s3_bucket_lifecycle_configuration" "imports" {
  count  = var.enable_excel_import ? 1 : 0
  bucket = aws_s3_bucket.imports[0].id

  rule {
    id     = "expire-import-files"
    status = "Enabled"

    filter {
      prefix = "incoming/"
    }

    expiration {
      days = 30
    }

    noncurrent_version_expiration {
      noncurrent_days = 30
    }
  }
}

resource "aws_sqs_queue" "imports_dlq" {
  count                     = var.enable_excel_import ? 1 : 0
  name                      = "${var.project_name}-imports-dlq"
  message_retention_seconds = 1209600
  sqs_managed_sse_enabled   = true
  tags                      = var.tags
}

resource "aws_sqs_queue" "imports" {
  count = var.enable_excel_import ? 1 : 0
  name  = "${var.project_name}-imports"
  # AWS recommends a visibility timeout of at least six times the Lambda
  # timeout plus the maximum batching window to avoid duplicate deliveries.
  # import_worker timeout = 240s and batching window = 5s, so use 1500s.
  visibility_timeout_seconds = 1500
  message_retention_seconds  = 345600
  receive_wait_time_seconds  = 20
  sqs_managed_sse_enabled    = true
  redrive_policy = jsonencode({
    deadLetterTargetArn = aws_sqs_queue.imports_dlq[0].arn
    maxReceiveCount     = 5
  })
  tags = var.tags
}

resource "aws_sqs_queue_policy" "imports" {
  count     = var.enable_excel_import ? 1 : 0
  queue_url = aws_sqs_queue.imports[0].id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Sid    = "AllowS3ImportNotifications"
      Effect = "Allow"
      Principal = {
        Service = "s3.amazonaws.com"
      }
      Action   = "sqs:SendMessage"
      Resource = aws_sqs_queue.imports[0].arn
      Condition = {
        ArnEquals = {
          "aws:SourceArn" = aws_s3_bucket.imports[0].arn
        }
      }
    }]
  })
}

resource "aws_s3_bucket_notification" "imports" {
  count  = var.enable_excel_import ? 1 : 0
  bucket = aws_s3_bucket.imports[0].id

  queue {
    queue_arn     = aws_sqs_queue.imports[0].arn
    events        = ["s3:ObjectCreated:Put", "s3:ObjectCreated:CompleteMultipartUpload"]
    filter_prefix = "incoming/"
    filter_suffix = ".xlsx"
  }

  depends_on = [aws_sqs_queue_policy.imports]
}

resource "aws_iam_role_policy" "lambda_import" {
  count = var.enable_excel_import ? 1 : 0
  name  = "${var.project_name}-import-read"
  role  = aws_iam_role.lambda.id

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect   = "Allow"
      Action   = ["s3:GetObject", "s3:GetObjectVersion", "s3:PutObject"]
      Resource = "${aws_s3_bucket.imports[0].arn}/*"
    }]
  })
}

resource "aws_cloudwatch_metric_alarm" "api_errors" {
  alarm_name          = "${var.project_name}-api-errors"
  alarm_description   = "API Lambda returned one or more errors in five minutes."
  comparison_operator = "GreaterThanOrEqualToThreshold"
  evaluation_periods  = 1
  metric_name         = "Errors"
  namespace           = "AWS/Lambda"
  period              = 300
  statistic           = "Sum"
  threshold           = 1
  treat_missing_data  = "notBreaching"
  alarm_actions       = [aws_sns_topic.erp_ops.arn]
  dimensions          = { FunctionName = aws_lambda_function.api.function_name }
  tags                = var.tags
}

resource "aws_cloudwatch_metric_alarm" "alert_worker_errors" {
  alarm_name          = "${var.project_name}-alert-worker-errors"
  alarm_description   = "Alert replay worker returned one or more errors in five minutes."
  comparison_operator = "GreaterThanOrEqualToThreshold"
  evaluation_periods  = 1
  metric_name         = "Errors"
  namespace           = "AWS/Lambda"
  period              = 300
  statistic           = "Sum"
  threshold           = 1
  treat_missing_data  = "notBreaching"
  alarm_actions       = [aws_sns_topic.erp_ops.arn]
  dimensions          = { FunctionName = aws_lambda_function.alert_worker.function_name }
  tags                = var.tags
}

resource "aws_cloudwatch_metric_alarm" "import_worker_errors" {
  count               = var.enable_excel_import ? 1 : 0
  alarm_name          = "${var.project_name}-import-worker-errors"
  alarm_description   = "Excel import worker returned one or more errors in five minutes."
  comparison_operator = "GreaterThanOrEqualToThreshold"
  evaluation_periods  = 1
  metric_name         = "Errors"
  namespace           = "AWS/Lambda"
  period              = 300
  statistic           = "Sum"
  threshold           = 1
  treat_missing_data  = "notBreaching"
  alarm_actions       = [aws_sns_topic.erp_ops.arn]
  dimensions          = { FunctionName = aws_lambda_function.import_worker[0].function_name }
  tags                = var.tags
}

resource "aws_cloudwatch_metric_alarm" "import_dlq_messages" {
  count               = var.enable_excel_import ? 1 : 0
  alarm_name          = "${var.project_name}-import-dlq-messages"
  alarm_description   = "Excel import messages reached the dead-letter queue."
  comparison_operator = "GreaterThanOrEqualToThreshold"
  evaluation_periods  = 1
  metric_name         = "ApproximateNumberOfMessagesVisible"
  namespace           = "AWS/SQS"
  period              = 300
  statistic           = "Maximum"
  threshold           = 1
  treat_missing_data  = "notBreaching"
  alarm_actions       = [aws_sns_topic.erp_ops.arn]
  dimensions          = { QueueName = aws_sqs_queue.imports_dlq[0].name }
  tags                = var.tags
}

resource "aws_cloudwatch_metric_alarm" "api_gateway_5xx" {
  alarm_name          = "${var.project_name}-api-gateway-5xx"
  alarm_description   = "HTTP API returned one or more 5xx responses in five minutes."
  comparison_operator = "GreaterThanOrEqualToThreshold"
  evaluation_periods  = 1
  metric_name         = "5XXError"
  namespace           = "AWS/ApiGateway"
  period              = 300
  statistic           = "Sum"
  threshold           = 1
  treat_missing_data  = "notBreaching"
  alarm_actions       = [aws_sns_topic.erp_ops.arn]
  dimensions          = { ApiId = aws_apigatewayv2_api.http.id, Stage = "$default" }
  tags                = var.tags
}

resource "aws_cloudwatch_metric_alarm" "dynamodb_throttles" {
  alarm_name          = "${var.project_name}-dynamodb-throttles"
  alarm_description   = "DynamoDB read or write requests were throttled in five minutes."
  comparison_operator = "GreaterThanOrEqualToThreshold"
  evaluation_periods  = 1
  metric_name         = "ThrottledRequests"
  namespace           = "AWS/DynamoDB"
  period              = 300
  statistic           = "Sum"
  threshold           = 1
  treat_missing_data  = "notBreaching"
  alarm_actions       = [aws_sns_topic.erp_ops.arn]
  dimensions          = { TableName = aws_dynamodb_table.erp.name }
  tags                = var.tags
}
