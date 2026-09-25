output "api_id" {
  value = aws_apigatewayv2_api.this.id
}

output "api_endpoint" {
  description = "Invoke URL of the $default stage (no trailing slash)."
  value       = aws_apigatewayv2_api.this.api_endpoint
}

output "execution_arn" {
  value = aws_apigatewayv2_api.this.execution_arn
}

output "authorizer_id" {
  value = aws_apigatewayv2_authorizer.entra.id
}

output "stage_name" {
  value = aws_apigatewayv2_stage.default.name
}
