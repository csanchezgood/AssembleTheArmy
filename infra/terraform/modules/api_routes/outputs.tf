output "route_ids" {
  value = { for k, r in aws_apigatewayv2_route.this : k => r.id }
}
