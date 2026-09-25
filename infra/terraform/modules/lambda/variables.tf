variable "function_name" {
  description = "Full Lambda function name (already prefixed)."
  type        = string
}

variable "description" {
  description = "Function description."
  type        = string
  default     = ""
}

variable "source_file" {
  description = "Path to the bundled ESM entry point (index.mjs) produced by esbuild."
  type        = string
}

variable "memory_size" {
  description = "Memory in MB."
  type        = number
  default     = 512
}

variable "timeout" {
  description = "Timeout in seconds."
  type        = number
}

variable "environment" {
  description = "Environment variables."
  type        = map(string)
  default     = {}
}

variable "reserved_concurrent_executions" {
  description = "Reserved concurrency; null leaves the function on the unreserved pool."
  type        = number
  default     = null
}

variable "policy_statements" {
  description = "IAM statements rendered into the role's inline policy (least privilege, per function)."
  type = list(object({
    sid       = string
    actions   = list(string)
    resources = list(string)
  }))
  default = []
}

variable "log_retention_days" {
  description = "CloudWatch Logs retention for the function log group."
  type        = number
}

variable "tags" {
  description = "Extra tags."
  type        = map(string)
  default     = {}
}
