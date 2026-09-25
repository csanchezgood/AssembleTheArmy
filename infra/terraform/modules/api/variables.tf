variable "name" {
  description = "API name (already prefixed)."
  type        = string
}

variable "cors_allow_origins" {
  description = "Allowed CORS origins (admin panel URL + dev origins)."
  type        = list(string)
}

variable "entra_tenant_id" {
  description = "Entra ID tenant id used to build the JWT issuer."
  type        = string
}

variable "admin_api_audience" {
  description = "Expected `aud` claim of admin tokens."
  type        = string
}

variable "throttling_rate_limit" {
  description = "Default route steady-state requests per second."
  type        = number
  default     = 20
}

variable "throttling_burst_limit" {
  description = "Default route burst limit."
  type        = number
  default     = 50
}

variable "log_retention_days" {
  description = "Retention of the access log group."
  type        = number
}

variable "tags" {
  type    = map(string)
  default = {}
}
