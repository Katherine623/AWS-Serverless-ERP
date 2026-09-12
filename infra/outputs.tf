output "api_url" {
  description = "Public application URL."
  value       = aws_apigatewayv2_api.http.api_endpoint
}

output "lambda_role_arn" {
  description = "Read-only scanner role for IAM review."
  value       = aws_iam_role.lambda.arn
}

