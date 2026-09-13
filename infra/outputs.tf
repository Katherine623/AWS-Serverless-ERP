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
