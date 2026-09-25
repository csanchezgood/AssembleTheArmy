# One HTTP API for the whole system (ARCHITECTURE.md section 4). Routes and
# integrations live in the sibling `api_routes` module so that the API id can
# be known before the Lambdas that need GRAPH_CALLBACK_URL are created.

resource "aws_apigatewayv2_api" "this" {
  name          = var.name
  protocol_type = "HTTP"
  description   = "AssembleTheArmy: New Relic webhook, Graph callback and admin API"

  cors_configuration {
    allow_origins = var.cors_allow_origins
    allow_headers = ["authorization", "content-type"]
    allow_methods = ["GET", "PUT", "POST", "DELETE", "OPTIONS"]
    max_age       = 3600
  }

  tags = var.tags
}

resource "aws_cloudwatch_log_group" "access" {
  name              = "/aws/apigateway/${var.name}/access"
  retention_in_days = var.log_retention_days
  tags              = var.tags
}

resource "aws_apigatewayv2_stage" "default" {
  api_id      = aws_apigatewayv2_api.this.id
  name        = "$default"
  auto_deploy = true

  access_log_settings {
    destination_arn = aws_cloudwatch_log_group.access.arn
    format = jsonencode({
      requestId          = "$context.requestId"
      requestTime        = "$context.requestTime"
      ip                 = "$context.identity.sourceIp"
      httpMethod         = "$context.httpMethod"
      routeKey           = "$context.routeKey"
      path               = "$context.path"
      status             = "$context.status"
      responseLength     = "$context.responseLength"
      responseLatency    = "$context.responseLatency"
      integrationStatus  = "$context.integrationStatus"
      integrationLatency = "$context.integrationLatency"
      integrationError   = "$context.integrationErrorMessage"
      authorizerError    = "$context.authorizer.error"
      errorMessage       = "$context.error.message"
      userAgent          = "$context.identity.userAgent"
    })
  }

  default_route_settings {
    throttling_rate_limit  = var.throttling_rate_limit
    throttling_burst_limit = var.throttling_burst_limit
  }

  tags = var.tags
}

# JWT authorizer against Entra ID (v2.0 tokens). Attached only to /admin/*.
resource "aws_apigatewayv2_authorizer" "entra" {
  api_id           = aws_apigatewayv2_api.this.id
  name             = "entra-jwt"
  authorizer_type  = "JWT"
  identity_sources = ["$request.header.Authorization"]

  jwt_configuration {
    issuer   = "https://login.microsoftonline.com/${var.entra_tenant_id}/v2.0"
    audience = [var.admin_api_audience]
  }
}
