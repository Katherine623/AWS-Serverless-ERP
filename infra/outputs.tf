output "api_url" {
  description = "Public application URL."
  value       = aws_apigatewayv2_api.http.api_endpoint
}

output "lambda_role_arn" {
  description = "Lambda execution role for the ERP API."
  value       = aws_iam_role.lambda.arn
}

output "alert_topic_arn" {
  description = "SNS topic ARN for ERP alerts."
  value       = aws_sns_topic.erp_alerts.arn
}

output "ops_topic_arn" {
  description = "SNS topic receiving infrastructure alarm notifications."
  value       = aws_sns_topic.erp_ops.arn
}

output "data_table_name" {
  description = "DynamoDB table used by the ERP API."
  value       = aws_dynamodb_table.erp.name
}

output "alert_worker_arn" {
  description = "Lambda worker that replays pending ERP alert batches."
  value       = aws_lambda_function.alert_worker.arn
}

output "cognito_user_pool_id" {
  description = "Managed Cognito user pool ID, when enabled."
  value       = var.manage_cognito_user_pool ? aws_cognito_user_pool.erp[0].id : null
}

output "cognito_client_id" {
  description = "Managed Cognito app client ID, when enabled."
  value       = var.manage_cognito_user_pool ? aws_cognito_user_pool_client.erp[0].id : null
}

output "cognito_hosted_ui_url" {
  description = "Cognito Hosted UI authorization endpoint, when enabled."
  value       = var.manage_cognito_user_pool ? "${local.managed_cognito_domain}/oauth2/authorize?client_id=${aws_cognito_user_pool_client.erp[0].id}&response_type=code&scope=openid+email+profile&redirect_uri=${urlencode("${aws_apigatewayv2_api.http.api_endpoint}/")}" : null
}

output "frontend_url" {
  description = "CloudFront frontend URL, when frontend CDN is enabled."
  value       = var.enable_frontend_cdn ? "https://${aws_cloudfront_distribution.frontend[0].domain_name}" : null
}

output "import_bucket_name" {
  description = "Private XLSX import bucket name, when enabled."
  value       = var.enable_excel_import ? aws_s3_bucket.imports[0].bucket : null
}

output "import_queue_url" {
  description = "SQS import queue URL, when enabled."
  value       = var.enable_excel_import ? aws_sqs_queue.imports[0].url : null
}
