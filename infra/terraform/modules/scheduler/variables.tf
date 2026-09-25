variable "name" {
  description = "Schedule name (already prefixed)."
  type        = string
}

variable "schedule_expression" {
  type    = string
  default = "rate(1 minute)"
}

variable "target_lambda_arn" {
  description = "ARN of the Lambda invoked on every tick."
  type        = string
}

variable "input" {
  description = "JSON payload passed to the target."
  type        = string
  default     = "{}"
}

variable "tags" {
  type    = map(string)
  default = {}
}
