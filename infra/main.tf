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

locals {
  managed_cognito_issuer   = var.manage_cognito_user_pool ? "https://cognito-idp.${var.aws_region}.amazonaws.com/${aws_cognito_user_pool.erp[0].id}" : ""
  managed_cognito_audience = var.manage_cognito_user_pool ? aws_cognito_user_pool_client.erp[0].id : ""
  jwt_issuer               = var.manage_cognito_user_pool ? local.managed_cognito_issuer : var.cognito_issuer_url
  jwt_audience             = var.manage_cognito_user_pool ? local.managed_cognito_audience : var.cognito_audience
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
  tags                     = var.tags
}

resource "aws_cognito_user_pool_client" "erp" {
  count                         = var.manage_cognito_user_pool ? 1 : 0
  name                          = "${var.project_name}-api"
  user_pool_id                  = aws_cognito_user_pool.erp[0].id
  generate_secret               = false
  prevent_user_existence_errors = "ENABLED"
  explicit_auth_flows           = ["ALLOW_REFRESH_TOKEN_AUTH", "ALLOW_USER_SRP_AUTH"]
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
      condition     = var.erp_environment != "production" || var.api_auth_enabled
      error_message = "api_auth_enabled must be true in production."
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

resource "aws_sns_topic" "erp_alerts" {
  name = "${var.project_name}-alerts"
  tags = var.tags
}

resource "aws_sns_topic" "erp_ops" {
  name = "${var.project_name}-ops"
  tags = var.tags
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
    }
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

resource "aws_s3_object" "frontend_index" {
  count        = var.enable_frontend_cdn ? 1 : 0
  bucket       = aws_s3_bucket.frontend[0].id
  key          = "index.html"
  source       = "${path.module}/../web/index.html"
  etag         = filemd5("${path.module}/../web/index.html")
  content_type = "text/html; charset=utf-8"
}

resource "aws_cloudfront_origin_access_control" "frontend" {
  count                             = var.enable_frontend_cdn ? 1 : 0
  name                              = "${var.project_name}-frontend-oac"
  description                       = "Private S3 origin access for the ERP frontend."
  origin_access_control_origin_type = "s3"
  signing_behavior                  = "always"
  signing_protocol                  = "sigv4"
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
    min_ttl     = 0
    default_ttl = 0
    max_ttl     = 0
  }

  restrictions {
    geo_restriction {
      restriction_type = "none"
    }
  }

  viewer_certificate {
    cloudfront_default_certificate = true
  }

  custom_error_response {
    error_code            = 403
    response_code         = 200
    response_page_path    = "/index.html"
    error_caching_min_ttl = 0
  }

  custom_error_response {
    error_code            = 404
    response_code         = 200
    response_page_path    = "/index.html"
    error_caching_min_ttl = 0
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
