variable "prefix" {
  description = "Resource name prefix, e.g. `ata-dev-`."
  type        = string
}

variable "alert_email" {
  description = "E-mail address subscribed to the alerts topic. Empty = no subscription."
  type        = string
  default     = ""
}

variable "lambda_function_names" {
  description = "Function names to alarm on (Errors >= 1 over 5 min)."
  type        = list(string)
}

variable "state_machine_arn" {
  description = "State machine to alarm on (ExecutionsFailed / ExecutionsTimedOut)."
  type        = string
}

variable "api_id" {
  description = "HTTP API id to alarm on (5xx)."
  type        = string
}

variable "config_errors_namespace" {
  description = "Namespace of the custom ConfigErrors metric published by webhook via EMF."
  type        = string
  default     = "AssembleTheArmy/ConfigErrors"
}

variable "tags" {
  type    = map(string)
  default = {}
}
