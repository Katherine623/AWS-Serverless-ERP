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

resource "terraform_data" "auth_config" {
  input = var.api_auth_enabled

  lifecycle {
    precondition {
      condition = !var.api_auth_enabled || (
        var.cognito_issuer_url != "" && var.cognito_audience != ""
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
    audience = [var.cognito_audience]
    issuer   = var.cognito_issuer_url
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
