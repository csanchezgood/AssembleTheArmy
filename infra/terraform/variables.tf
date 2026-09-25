# Variables of ARCHITECTURE.md section 6.

variable "project" {
  description = "Short project code used as the first part of every resource name."
  type        = string
  default     = "ata"

  validation {
    condition     = can(regex("^[a-z][a-z0-9]{1,15}$", var.project))
    error_message = "project must be 2-16 lowercase alphanumeric characters starting with a letter."
  }
}

variable "env" {
  description = "Environment name (dev, stg, prod...)."
  type        = string
  default     = "dev"

  validation {
    condition     = can(regex("^[a-z][a-z0-9]{1,9}$", var.env))
    error_message = "env must be 2-10 lowercase alphanumeric characters starting with a letter."
  }
}

variable "aws_region" {
  description = "AWS region where everything is deployed."
  type        = string
  default     = "us-east-1"

  validation {
    condition     = can(regex("^[a-z]{2}-[a-z]+-[0-9]$", var.aws_region))
    error_message = "aws_region must look like `us-east-1`."
  }
}

variable "entra_tenant_id" {
  description = "Entra ID (Azure AD) tenant id. Used by the JWT authorizer issuer and as GRAPH_TENANT_ID."
  type        = string

  validation {
    condition     = can(regex("^[0-9a-fA-F-]{36}$", var.entra_tenant_id)) || var.entra_tenant_id == "common"
    error_message = "entra_tenant_id must be a GUID (or \"common\" while the real tenant is not known yet; admin tokens will not validate until it is set)."
  }
}

variable "graph_client_id" {
  description = "Application (client) id of the bot app registration that calls Microsoft Graph."
  type        = string

  validation {
    condition     = can(regex("^[0-9a-fA-F-]{36}$", var.graph_client_id))
    error_message = "graph_client_id must be a GUID."
  }
}

variable "admin_spa_client_id" {
  description = "Application (client) id of the admin SPA registration (MSAL)."
  type        = string

  validation {
    condition     = can(regex("^[0-9a-fA-F-]{36}$", var.admin_spa_client_id))
    error_message = "admin_spa_client_id must be a GUID."
  }
}

variable "admin_api_audience" {
  description = "Expected `aud` claim of the admin access tokens (e.g. `api://<admin_api_client_id>` or the API client id)."
  type        = string

  validation {
    condition     = length(var.admin_api_audience) > 0
    error_message = "admin_api_audience cannot be empty."
  }
}

variable "admin_api_scope" {
  description = "Scope the SPA requests for the admin API, e.g. `api://<admin_api_client_id>/access_as_user`."
  type        = string

  validation {
    condition     = length(var.admin_api_scope) > 0
    error_message = "admin_api_scope cannot be empty."
  }
}

variable "admin_group_id" {
  description = "Entra group object id whose members may use the admin panel. Empty = any authenticated user of the tenant."
  type        = string
  default     = ""

  validation {
    condition     = var.admin_group_id == "" || can(regex("^[0-9a-fA-F-]{36}$", var.admin_group_id))
    error_message = "admin_group_id must be empty or a GUID."
  }
}

variable "alert_email" {
  description = "E-mail address that receives the SNS alerts (system failures, unanswered convocations). Empty = no e-mail subscription (subscribe later)."
  type        = string
  default     = ""

  validation {
    condition     = var.alert_email == "" || can(regex("^[^@\\s]+@[^@\\s]+\\.[^@\\s]+$", var.alert_email))
    error_message = "alert_email must be a valid e-mail address or empty."
  }
}

variable "max_attempts" {
  description = "Ring attempts per member before giving up on the slot (policy.max_attempts)."
  type        = number
  default     = 5

  validation {
    condition     = var.max_attempts >= 1 && var.max_attempts <= 20 && floor(var.max_attempts) == var.max_attempts
    error_message = "max_attempts must be an integer between 1 and 20."
  }
}

variable "ring_timeout_seconds" {
  description = "Seconds to wait for a member to join after each invite (policy.ring_timeout_seconds)."
  type        = number
  default     = 45

  validation {
    condition     = var.ring_timeout_seconds >= 10 && var.ring_timeout_seconds <= 300 && floor(var.ring_timeout_seconds) == var.ring_timeout_seconds
    error_message = "ring_timeout_seconds must be an integer between 10 and 300."
  }
}

variable "max_escalations" {
  description = "Maximum number of team escalations per incident (policy.max_escalations)."
  type        = number
  default     = 1

  validation {
    condition     = var.max_escalations >= 0 && var.max_escalations <= 5 && floor(var.max_escalations) == var.max_escalations
    error_message = "max_escalations must be an integer between 0 and 5."
  }
}

variable "unanswered_ttl_minutes" {
  description = "Minutes after which presence-monitor closes `unanswered` incidents."
  type        = number
  default     = 60

  validation {
    condition     = var.unanswered_ttl_minutes >= 1 && floor(var.unanswered_ttl_minutes) == var.unanswered_ttl_minutes
    error_message = "unanswered_ttl_minutes must be a positive integer."
  }
}

variable "log_retention_days" {
  description = "CloudWatch Logs retention for every log group."
  type        = number
  default     = 90

  validation {
    condition     = contains([1, 3, 5, 7, 14, 30, 60, 90, 120, 150, 180, 365, 400, 545, 731, 1096, 1827, 2192, 2557, 2922, 3288, 3653], var.log_retention_days)
    error_message = "log_retention_days must be one of the values accepted by CloudWatch Logs (1, 3, 5, 7, 14, 30, 60, 90, 120, 150, 180, 365, 400, 545, 731, ...)."
  }
}

variable "extra_cors_origins" {
  description = "Additional CORS origins allowed by the API besides the CloudFront URL of the panel (dev server)."
  type        = list(string)
  default     = ["http://localhost:5173"]

  validation {
    condition     = alltrue([for o in var.extra_cors_origins : can(regex("^https?://[^/]+$", o))])
    error_message = "Each origin must be `scheme://host[:port]` without a path."
  }
}
