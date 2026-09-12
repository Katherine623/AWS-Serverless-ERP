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

resource "aws_iam_role_policy" "scanner" {
  name = "${var.project_name}-read-only-scanner"
  role = aws_iam_role.lambda.id

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Sid    = "ReadRegionalInventory"
        Effect = "Allow"
        Action = [
          "ec2:DescribeAddresses",
          "ec2:DescribeSecurityGroups",
          "ec2:DescribeVolumes",
          "logs:DescribeLogGroups"
        ]
        Resource = "*"
      },
      {
        Sid    = "ReadS3Governance"
        Effect = "Allow"
        Action = [
          "s3:GetBucketLocation",
          "s3:GetBucketPublicAccessBlock",
          "s3:ListAllMyBuckets"
        ]
        Resource = "*"
      },
      {
        Sid    = "ReadCustomerManagedPolicies"
        Effect = "Allow"
        Action = [
          "iam:GetPolicyVersion",
          "iam:ListPolicies"
        ]
        Resource = "*"
      },
      {
        Sid      = "ReadIdentity"
        Effect   = "Allow"
        Action   = "sts:GetCallerIdentity"
        Resource = "*"
      },
      {
        Sid    = "OptionalBedrockSummary"
        Effect = "Allow"
        Action = [
          "bedrock:InvokeModel"
        ]
        Resource = "*"
      }
    ]
  })
}

resource "aws_lambda_function" "api" {
  function_name = var.project_name
  role          = aws_iam_role.lambda.arn
  package_type  = "Image"
  image_uri     = var.image_uri
  architectures = ["x86_64"]
  memory_size   = 1024
  timeout       = 120

  environment {
    variables = {
      ALLOW_AWS_SCAN         = "false"
      AWS_ACCOUNT_ID         = data.aws_caller_identity.current.account_id
      BEDROCK_MODEL_ID       = var.bedrock_model_id
      POWERTOOLS_SERVICE_NAME = var.project_name
    }
  }
}

resource "aws_apigatewayv2_api" "http" {
  name          = var.project_name
  protocol_type = "HTTP"
}

resource "aws_apigatewayv2_integration" "lambda" {
  api_id                 = aws_apigatewayv2_api.http.id
  integration_type       = "AWS_PROXY"
  integration_uri        = aws_lambda_function.api.invoke_arn
  payload_format_version = "2.0"
}

resource "aws_apigatewayv2_route" "default" {
  api_id    = aws_apigatewayv2_api.http.id
  route_key = "$default"
  target    = "integrations/${aws_apigatewayv2_integration.lambda.id}"
}

resource "aws_apigatewayv2_stage" "default" {
  api_id      = aws_apigatewayv2_api.http.id
  name        = "$default"
  auto_deploy = true
}

resource "aws_lambda_permission" "api_gateway" {
  statement_id  = "AllowApiGateway"
  action        = "lambda:InvokeFunction"
  function_name = aws_lambda_function.api.function_name
  principal     = "apigateway.amazonaws.com"
  source_arn    = "${aws_apigatewayv2_api.http.execution_arn}/*/*"
}
