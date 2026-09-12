output "api_url" {
  description = "Public application URL."
  value       = aws_apigatewayv2_api.http.api_endpoint
}

output "lambda_role_arn" {
  description = "Lambda execution role for the ERP API."
  value       = aws_iam_role.lambda.arn
}

