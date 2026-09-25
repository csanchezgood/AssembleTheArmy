variable "api_id" {
  type = string
}

variable "api_execution_arn" {
  type = string
}

variable "authorizer_id" {
  description = "JWT authorizer id used by routes with `authorized = true`."
  type        = string
}

variable "routes" {
  description = "Map keyed by a short id: route key, target Lambda and whether the JWT authorizer applies."
  type = map(object({
    route_key            = string # e.g. "POST /webhook/newrelic"
    lambda_function_name = string
    lambda_invoke_arn    = string
    authorized           = bool
  }))
}
